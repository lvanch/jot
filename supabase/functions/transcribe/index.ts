// POST /functions/v1/transcribe: turn one Recording into a parked Item (spec §5, ADRs 0003, 0006, 0008).
//
// Steps: auth (Owner only) → validate → already parked? → daily cap → store Recording → Transcriber → park.
// Responses are JSON: { item } | { item: null, empty: true } | { error, message? }.
//
// Never log audio, Transcript text, tokens or keys: errors are logged by name and code only.

import { createSupabaseContext } from "@supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getTranscriber,
  type Transcriber,
  TranscriberRefused,
  TranscriberUnavailable,
} from "../_shared/transcriber/index.ts";
import {
  corsHeaders,
  dailyCap,
  MAX_AUDIO_BYTES,
  MAX_TEXT,
  MAX_TRANSCRIPT,
  parseUpload,
  perthDay,
  type Upload,
} from "./rules.ts";

const ORIGINS = (Deno.env.get("JOT_ORIGINS") ?? "https://lvanch.github.io").split(",").map((s) => s.trim());
const DAILY_CAP = dailyCap(Deno.env.get("DAILY_CAP"));
const BUCKET = "recordings";

let transcriber: Transcriber | undefined; // created on first use, so a missing key fails a request, not the boot

type Reply = (status: number, body: Record<string, unknown>) => Response;
type LogOutcome = "parked" | "empty" | "refused" | "unavailable";

export default { fetch: serve };

async function serve(req: Request): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), ORIGINS);
  const reply: Reply = (status, body) =>
    Response.json(body, { status, headers: { ...cors, "Cache-Control": "no-store" } });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  try {
    return await handle(req, reply);
  } catch (err) {
    console.error("transcribe: unhandled", errName(err));
    return reply(500, { error: "internal" });
  }
}

async function handle(req: Request, reply: Reply): Promise<Response> {
  // 1. Auth: a valid user token, and that user is the Owner.
  const { data: ctx, error: authError } = await createSupabaseContext(req, { auth: "user", cors: "disabled" });
  if (authError) {
    if (authError.status === 401) return reply(401, { error: "unauthorized" });
    console.error("transcribe: auth setup", authError.code);
    return reply(500, { error: "internal" });
  }
  const admin = ctx.supabaseAdmin;
  const userId = ctx.userClaims?.id;
  if (!userId) return reply(401, { error: "unauthorized" });
  const member = await admin.from("members").select("role").eq("user_id", userId).maybeSingle();
  if (member.error) return unavailable(reply, "members", member.error.code);
  if (member.data?.role !== "owner") return reply(401, { error: "unauthorized" });

  // 2. Validate.
  const declared = Number(req.headers.get("content-length"));
  if (declared > MAX_AUDIO_BYTES + 64 * 1024) return reply(413, { error: "too_large", message: "audio is over 1 MB" });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return reply(400, { error: "bad_request", message: "body must be multipart/form-data" });
  }
  const parsed = parseUpload(form, new Date());
  if (!parsed.ok) {
    return reply(parsed.status, {
      error: parsed.status === 413 ? "too_large" : "bad_request",
      message: parsed.message,
    });
  }
  const upload = parsed.upload;

  // 3. Already parked? Then this is a retry after a lost response: answer it, don't transcribe again.
  const existing = await admin.from("items").select("*").eq("id", upload.id).maybeSingle();
  if (existing.error) return unavailable(reply, "items", existing.error.code);
  if (existing.data) return reply(200, { item: existing.data });

  // 4. Daily cap (ADR-0008). Calls the Transcriber couldn't take ('unavailable') aren't billed, so they don't count.
  const { start, next } = perthDay(new Date());
  const today = await admin.from("transcription_log").select("id", { count: "exact", head: true })
    .gte("at", start.toISOString()).neq("outcome", "unavailable");
  if (today.error) return unavailable(reply, "transcription_log", today.error.code);
  if ((today.count ?? 0) >= DAILY_CAP) return reply(429, { error: "daily_cap", retry_at: next.toISOString() });

  // 5. Store the Recording before transcribing, so a parked Item always has its audio (ADR-0006).
  const path = `${upload.id}.${upload.ext}`;
  const stored = await admin.storage.from(BUCKET).upload(path, upload.audio, {
    contentType: upload.baseType,
    upsert: true,
  });
  if (stored.error) return unavailable(reply, "storage", errName(stored.error));

  // 6. Transcribe with the Vocabulary.
  const vocabulary = await admin.from("vocabulary").select("term").order("id");
  if (vocabulary.error) return unavailable(reply, "vocabulary", vocabulary.error.code);
  transcriber ??= getTranscriber();
  let result;
  try {
    result = await transcriber.transcribe({
      audio: upload.audio,
      mimeType: upload.mimeType,
      vocabulary: vocabulary.data.map((v) => v.term as string),
      language: "en",
    });
  } catch (err) {
    if (err instanceof TranscriberRefused) {
      await log(admin, upload, "refused");
      await removeRecording(admin, path);
      return reply(422, { error: "transcriber_refused" });
    }
    if (err instanceof TranscriberUnavailable) {
      await log(admin, upload, "unavailable");
      return reply(502, { error: "transcriber_unavailable" });
    }
    throw err;
  }

  // 7. Nothing said: no Item, no Recording.
  const text = result.text.trim();
  if (!text) {
    await log(admin, upload, "empty");
    await removeRecording(admin, path);
    return reply(200, { item: null, empty: true });
  }

  // 8. Park.
  const row = {
    id: upload.id,
    transcript: text.slice(0, MAX_TRANSCRIPT),
    text: text.slice(0, MAX_TEXT).trim(),
    captured_at: upload.capturedAt.toISOString(),
    source: "jot",
    device: upload.device,
    transcriber: `${transcriber.name}/${result.model}`.slice(0, 100),
    language: result.language?.slice(0, 16) ?? null,
    duration_ms: upload.durationMs,
    recording_path: path,
    meta: result.meta,
  };
  const inserted = await admin.from("items").upsert(row, { onConflict: "id", ignoreDuplicates: true }).select();
  if (inserted.error) {
    console.error("transcribe: park", inserted.error.code);
    return reply(500, { error: "internal" });
  }
  await log(admin, upload, "parked");
  if (inserted.data.length) return reply(201, { item: inserted.data[0] });
  // A concurrent retry parked it first.
  const winner = await admin.from("items").select("*").eq("id", upload.id).single();
  if (winner.error) return unavailable(reply, "items", winner.error.code);
  return reply(200, { item: winner.data });
}

function unavailable(reply: Reply, what: string, code: string | undefined): Response {
  console.error(`transcribe: ${what} unavailable`, code ?? "");
  return reply(503, { error: "inbox_unavailable" });
}

async function log(admin: SupabaseClient, upload: Upload, outcome: LogOutcome): Promise<void> {
  const { error } = await admin.from("transcription_log").insert({
    item_id: upload.id,
    duration_ms: upload.durationMs,
    outcome,
  });
  if (error) console.error("transcribe: log", error.code);
}

async function removeRecording(admin: SupabaseClient, path: string): Promise<void> {
  const { error } = await admin.storage.from(BUCKET).remove([path]);
  if (error) console.error("transcribe: remove recording", errName(error));
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "error";
}
