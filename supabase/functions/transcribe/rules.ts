// Pure rules for the transcribe function (spec §5): request validation, the Perth day, CORS.
// No I/O here, so it's unit-tested directly.

export const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_AUDIO_BYTES = 1_048_576; // matches the recordings bucket's file_size_limit
export const MAX_DURATION_MS = 61_000; // Jot stops at 60 s
export const MAX_TEXT = 2000; // items.text
export const MAX_TRANSCRIPT = 10_000; // items.transcript
export const DEFAULT_DAILY_CAP = 50; // ADR-0008

/** Accepted Recording types (base MIME, without codec parameters) and their file extensions. */
export const AUDIO_TYPES: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
};

export interface Upload {
  id: string;
  capturedAt: Date;
  durationMs: number;
  device: string | null;
  audio: File;
  /** As sent, e.g. "audio/webm;codecs=opus". The Transcriber gets this one. */
  mimeType: string;
  /** Without parameters, e.g. "audio/webm". Storage gets this one. */
  baseType: string;
  ext: string;
}

export type ParseResult =
  | { ok: true; upload: Upload }
  | { ok: false; status: 400 | 413; message: string };

const EARLIEST_CAPTURE = Date.UTC(2020, 0, 1);
const MAX_CLOCK_SKEW_MS = 24 * 3600_000;

export function baseMimeType(type: string): string {
  return type.split(";")[0].trim().toLowerCase();
}

/** Validates the multipart fields of a transcribe request. */
export function parseUpload(form: FormData, now: Date): ParseResult {
  const bad = (message: string): ParseResult => ({ ok: false, status: 400, message });
  const tooLarge = (message: string): ParseResult => ({ ok: false, status: 413, message });

  const id = form.get("id");
  if (typeof id !== "string" || !ITEM_ID.test(id)) return bad("id must be 1-64 characters of A-Z a-z 0-9 _ -");

  const captured = form.get("captured_at");
  const capturedAt = typeof captured === "string" ? new Date(captured) : null;
  if (!capturedAt || Number.isNaN(capturedAt.getTime())) return bad("captured_at must be an ISO time");
  if (capturedAt.getTime() < EARLIEST_CAPTURE || capturedAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
    return bad("captured_at is out of range");
  }

  const duration = form.get("duration_ms");
  const durationMs = typeof duration === "string" && /^\d{1,9}$/.test(duration) ? Number(duration) : NaN;
  if (!Number.isSafeInteger(durationMs)) return bad("duration_ms must be a whole number of milliseconds");
  if (durationMs > MAX_DURATION_MS) return tooLarge(`Recordings are at most ${MAX_DURATION_MS / 1000} s`);

  const deviceField = form.get("device");
  if (deviceField !== null && (typeof deviceField !== "string" || deviceField.length > 64)) {
    return bad("device must be at most 64 characters");
  }
  const device = typeof deviceField === "string" && deviceField.trim() ? deviceField.trim() : null;

  const audio = form.get("audio");
  if (!(audio instanceof File) || audio.size === 0) return bad("audio must be a non-empty file");
  if (audio.size > MAX_AUDIO_BYTES) return tooLarge("audio is over 1 MB");
  const baseType = baseMimeType(audio.type);
  const ext = AUDIO_TYPES[baseType];
  if (!ext) return bad("audio must be audio/webm, audio/ogg or audio/mp4");

  return {
    ok: true,
    upload: { id, capturedAt, durationMs, device, audio, mimeType: audio.type, baseType, ext },
  };
}

const PERTH_OFFSET_MS = 8 * 3600_000; // Australia/Perth is UTC+8 all year (no daylight saving)
const DAY_MS = 24 * 3600_000;

/** The Perth calendar day containing `now`: its start, and the next midnight (when the daily cap resets). */
export function perthDay(now: Date): { start: Date; next: Date } {
  const local = now.getTime() + PERTH_OFFSET_MS;
  const start = Math.floor(local / DAY_MS) * DAY_MS - PERTH_OFFSET_MS;
  return { start: new Date(start), next: new Date(start + DAY_MS) };
}

/** Parses DAILY_CAP, falling back to the default for anything that isn't a positive whole number. */
export function dailyCap(raw: string | undefined): number {
  const n = Number(raw);
  return raw && Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

/** Origins allowed to call from a browser: the configured list, plus loopback for local development. */
export function allowedOrigin(origin: string | null, allowed: string[]): string | null {
  if (!origin) return null;
  if (allowed.includes(origin)) return origin;
  try {
    const u = new URL(origin);
    if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return origin;
  } catch {
    // not a URL
  }
  return null;
}

export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const ok = allowedOrigin(origin, allowed);
  if (!ok) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retry-count",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
