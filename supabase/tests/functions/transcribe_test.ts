// Integration tests for the transcribe and health Edge Functions (#5), against the local stack with the fake
// Transcriber. See supabase/README.md for how to run them:
//
//   supabase start && supabase db reset
//   supabase functions serve --env-file supabase/tests/functions/test.env &
//   eval "$(supabase status -o env)"
//   deno test --allow-net --allow-env --config supabase/functions/transcribe/deno.json supabase/tests/functions/

import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const API_URL = Deno.env.get("API_URL") ?? "http://127.0.0.1:54321";
const PUBLISHABLE_KEY = need("PUBLISHABLE_KEY");
const SECRET_KEY = need("SECRET_KEY");
// Through the gateway by default; serve_local.ts sets FUNCTIONS_URL when the functions run on the host instead.
const FUNCTIONS = Deno.env.get("FUNCTIONS_URL") ?? `${API_URL}/functions/v1`;
const RUN = `t5-${Date.now().toString(36)}`; // every id this run creates starts with this
const PERTH_OFFSET_MS = 8 * 3600_000;
const VOCAB_TERM = `Term ${RUN}`; // removed again by the cleanup test

function need(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`${name} is not set: run eval "$(supabase status -o env)" first`);
  return v;
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin: SupabaseClient = createClient(API_URL, SECRET_KEY, options);

async function tokenFor(email: string, password: string): Promise<string> {
  const client = createClient(API_URL, PUBLISHABLE_KEY, options);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return data.session!.access_token;
}

// ---------- fixtures ----------

const strangerEmail = `${RUN}-stranger@jot.local`;
const setup = (async () => {
  const stranger = await admin.auth.admin.createUser({
    email: strangerEmail,
    password: "stranger-password",
    email_confirm: true,
  });
  if (stranger.error) throw stranger.error;
  const vocab = await admin.from("vocabulary").insert({ term: VOCAB_TERM });
  if (vocab.error) throw vocab.error;
  return {
    owner: await tokenFor("owner@jot.local", "local-owner-password"),
    claude: await tokenFor("claude@jot.local", "local-claude-password"),
    stranger: await tokenFor(strangerEmail, "stranger-password"),
    strangerId: stranger.data.user!.id,
  };
})();

let n = 0;
const nextId = () => `${RUN}-${++n}`;

/** Audio of `bytes` bytes, optionally starting with a fake-Transcriber marker. */
function audio(bytes: number, marker = "", type = "audio/webm;codecs=opus"): Blob {
  const body = new Uint8Array(bytes);
  body.set(new TextEncoder().encode(marker));
  return new Blob([body], { type });
}

interface Send {
  token?: string;
  id?: string;
  audio?: Blob;
  durationMs?: string;
  capturedAt?: string;
}

async function transcribe(s: Send): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  form.append("id", s.id ?? nextId());
  form.append("captured_at", s.capturedAt ?? new Date().toISOString());
  form.append("duration_ms", s.durationMs ?? "4200");
  form.append("device", "phone");
  form.append("audio", s.audio ?? audio(4096), "recording.webm");
  const headers: Record<string, string> = { apikey: PUBLISHABLE_KEY };
  if (s.token) headers.Authorization = `Bearer ${s.token}`;
  const res = await fetch(`${FUNCTIONS}/transcribe`, { method: "POST", headers, body: form });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

const itemRow = async (id: string) => (await admin.from("items").select("*").eq("id", id).maybeSingle()).data;
const logRows = async (id: string) =>
  (await admin.from("transcription_log").select("outcome").eq("item_id", id).order("id")).data!.map((r) => r.outcome);
async function recordingExists(path: string): Promise<boolean> {
  const { data } = await admin.storage.from("recordings").list("", { search: path });
  return !!data?.some((o) => o.name === path);
}

const t = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

// ---------- transcribe ----------

t("parks a Recording as an Item in the Inbox", async () => {
  const { owner } = await setup;
  const id = nextId();
  const r = await transcribe({ token: owner, id, audio: audio(4096) });
  assertEquals(r.status, 201, JSON.stringify(r.body));
  const item = r.body.item as Record<string, unknown>;
  assertEquals(item.id, id);
  assertEquals(item.status, "inbox");
  assertEquals(item.text, "fake transcript 4096");
  assertEquals(item.transcript, "fake transcript 4096");
  assertEquals(item.source, "jot");
  assertEquals(item.device, "phone");
  assertEquals(item.duration_ms, 4200);
  assertEquals(item.transcriber, "fake/fake");
  assertEquals(item.recording_path, `${id}.webm`);
  assert(
    (item.meta as { vocabulary: string[] }).vocabulary.includes(VOCAB_TERM),
    "the Vocabulary reached the Transcriber",
  );
  assert(await recordingExists(`${id}.webm`), "the Recording is stored");
  assertEquals(await logRows(id), ["parked"]);
});

t("a repeated upload returns the same Item without transcribing again", async () => {
  const { owner } = await setup;
  const id = nextId();
  const first = await transcribe({ token: owner, id });
  assertEquals(first.status, 201);
  const again = await transcribe({ token: owner, id, audio: audio(8192) });
  assertEquals(again.status, 200);
  assertEquals((again.body.item as Record<string, unknown>).text, "fake transcript 4096");
  assertEquals(
    (again.body.item as Record<string, unknown>).parked_at,
    (first.body.item as Record<string, unknown>).parked_at,
  );
  assertEquals(await logRows(id), ["parked"]);
});

t("silence parks nothing and keeps no Recording", async () => {
  const { owner } = await setup;
  const id = nextId();
  const r = await transcribe({ token: owner, id, audio: audio(500) });
  assertEquals(r.status, 200);
  assertEquals(r.body, { item: null, empty: true });
  assertEquals(await itemRow(id), null);
  assertEquals(await recordingExists(`${id}.webm`), false);
  assertEquals(await logRows(id), ["empty"]);
});

t("a refused Recording is 422 and leaves nothing behind", async () => {
  const { owner } = await setup;
  const id = nextId();
  const r = await transcribe({ token: owner, id, audio: audio(4096, "FAKE:REFUSE") });
  assertEquals(r.status, 422);
  assertEquals(r.body.error, "transcriber_refused");
  assertEquals(await itemRow(id), null);
  assertEquals(await recordingExists(`${id}.webm`), false);
  assertEquals(await logRows(id), ["refused"]);
});

t("a Transcriber outage is 502, and a retry later parks it", async () => {
  const { owner } = await setup;
  const id = nextId();
  const r = await transcribe({ token: owner, id, audio: audio(4096, "FAKE:UNAVAILABLE") });
  assertEquals(r.status, 502);
  assertEquals(r.body.error, "transcriber_unavailable");
  assertEquals(await itemRow(id), null);
  const retry = await transcribe({ token: owner, id, audio: audio(4096) });
  assertEquals(retry.status, 201);
  assertEquals(await logRows(id), ["unavailable", "parked"]);
});

t("only the Owner may transcribe", async () => {
  const { claude, stranger } = await setup;
  for (
    const [who, token] of [["nobody", undefined], ["a bad token", "not-a-jwt"], ["a processor", claude], [
      "a non-member",
      stranger,
    ]]
  ) {
    const id = nextId();
    const r = await transcribe({ token, id });
    assertEquals(r.status, 401, `${who}: ${JSON.stringify(r.body)}`);
    assertEquals(await itemRow(id), null);
  }
});

t("bad requests are 400 and oversized ones 413", async () => {
  const { owner } = await setup;
  assertEquals((await transcribe({ token: owner, id: "bad id!" })).status, 400);
  assertEquals((await transcribe({ token: owner, audio: audio(4096, "", "text/plain") })).status, 400);
  assertEquals((await transcribe({ token: owner, capturedAt: "yesterday" })).status, 400);
  const long = await transcribe({ token: owner, durationMs: "70000" });
  assertEquals([long.status, long.body.error], [413, "too_large"]);
  const big = await transcribe({ token: owner, audio: audio(1_048_577) });
  assertEquals([big.status, big.body.error], [413, "too_large"]);
});

t("other methods are refused, and browsers get CORS only from Jot's origin", async () => {
  const get = await fetch(`${FUNCTIONS}/transcribe`, { headers: { Authorization: `Bearer ${(await setup).owner}` } });
  await get.body?.cancel();
  assertEquals(get.status, 405);

  const preflight = (origin: string) =>
    fetch(`${FUNCTIONS}/transcribe`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization",
      },
    });
  const jot = await preflight("https://lvanch.github.io");
  await jot.body?.cancel();
  assert(jot.status < 300, `preflight status ${jot.status}`);
  assertEquals(jot.headers.get("access-control-allow-origin"), "https://lvanch.github.io");
  const other = await preflight("https://evil.example");
  await other.body?.cancel();
  assertEquals(other.headers.get("access-control-allow-origin"), null);
});

// ---------- health ----------

t("health answers without credentials, to any origin", async () => {
  const res = await fetch(`${FUNCTIONS}/health`, { headers: { Origin: "https://lvanch.github.io" } });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(await res.json(), { ok: true });
});

// ---------- daily cap (last: it fills today's log) ----------

t("the 51st transcription of a Perth day is 429 until Perth midnight", async () => {
  const { owner } = await setup;
  const now = Date.now();
  const startOfPerthDay = Math.floor((now + PERTH_OFFSET_MS) / 86_400_000) * 86_400_000 - PERTH_OFFSET_MS;
  const { count } = await admin.from("transcription_log").select("id", { count: "exact", head: true })
    .gte("at", new Date(startOfPerthDay).toISOString()).neq("outcome", "unavailable");
  const filler = Array.from(
    { length: Math.max(0, 50 - (count ?? 0)) },
    () => ({ item_id: `${RUN}-cap`, outcome: "parked" }),
  );
  if (filler.length) assertEquals((await admin.from("transcription_log").insert(filler)).error, null);

  // Outages don't count towards the cap, so the stray 'unavailable' row from earlier didn't matter.
  const id = nextId();
  const r = await transcribe({ token: owner, id });
  assertEquals(r.status, 429);
  assertEquals(r.body.error, "daily_cap");
  assertEquals(r.body.retry_at, new Date(startOfPerthDay + 86_400_000).toISOString());
  assertEquals(await itemRow(id), null);
  assertEquals(await recordingExists(`${id}.webm`), false);
});

// ---------- cleanup ----------

t("cleanup", async () => {
  const { strangerId } = await setup;
  const items = (await admin.from("items").select("id, recording_path").like("id", `${RUN}-%`)).data ?? [];
  const paths = items.map((i) => i.recording_path).filter(Boolean) as string[];
  if (paths.length) await admin.storage.from("recordings").remove(paths);
  await admin.from("items").delete().like("id", `${RUN}-%`);
  await admin.from("transcription_log").delete().like("item_id", `${RUN}-%`);
  await admin.from("vocabulary").delete().eq("term", VOCAB_TERM);
  await admin.auth.admin.deleteUser(strangerId);
});
