import { assertEquals } from "jsr:@std/assert@1.0.13";
import { allowedOrigin, corsHeaders, dailyCap, MAX_AUDIO_BYTES, parseUpload, perthDay } from "./rules.ts";

const NOW = new Date("2026-11-24T10:00:00Z");

function form(fields: Record<string, string | Blob | undefined>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v instanceof Blob) f.append(k, v, "recording");
    else f.append(k, v);
  }
  return f;
}

const audio = (bytes = 2048, type = "audio/webm;codecs=opus") => new Blob([new Uint8Array(bytes)], { type });
const valid = (over: Record<string, string | Blob | undefined> = {}) =>
  form({
    id: "3f1c2b9e-1d2c-4b8a-9a7e-0c5d6e7f8a9b",
    captured_at: "2026-11-24T09:59:50.000Z",
    duration_ms: "4200",
    device: "phone",
    audio: audio(),
    ...over,
  });

Deno.test("a well-formed upload parses", () => {
  const r = parseUpload(valid(), NOW);
  assertEquals(r.ok, true);
  if (!r.ok) return;
  assertEquals(r.upload.id, "3f1c2b9e-1d2c-4b8a-9a7e-0c5d6e7f8a9b");
  assertEquals(r.upload.capturedAt.toISOString(), "2026-11-24T09:59:50.000Z");
  assertEquals(r.upload.durationMs, 4200);
  assertEquals(r.upload.device, "phone");
  assertEquals(r.upload.mimeType, "audio/webm;codecs=opus");
  assertEquals(r.upload.baseType, "audio/webm");
  assertEquals(r.upload.ext, "webm");
});

Deno.test("each accepted audio type maps to its extension", () => {
  for (const [type, ext] of [["audio/ogg;codecs=opus", "ogg"], ["audio/mp4", "m4a"], ["AUDIO/WEBM", "webm"]]) {
    const r = parseUpload(valid({ audio: audio(2048, type) }), NOW);
    assertEquals(r.ok && r.upload.ext, ext, type);
  }
});

Deno.test("device is optional", () => {
  const r = parseUpload(valid({ device: undefined }), NOW);
  assertEquals(r.ok && r.upload.device, null);
});

Deno.test("bad fields are 400", () => {
  const cases: Record<string, Record<string, string | Blob | undefined>> = {
    "missing id": { id: undefined },
    "bad id": { id: "bad id!" },
    "long id": { id: "x".repeat(65) },
    "missing captured_at": { captured_at: undefined },
    "garbage captured_at": { captured_at: "yesterday" },
    "captured before 2020": { captured_at: "2019-12-31T23:59:59Z" },
    "captured over a day in the future": { captured_at: "2026-11-25T10:00:01Z" },
    "missing duration": { duration_ms: undefined },
    "fractional duration": { duration_ms: "4200.5" },
    "negative duration": { duration_ms: "-1" },
    "long device": { device: "x".repeat(65) },
    "missing audio": { audio: undefined },
    "audio as text": { audio: "not a file" },
    "empty audio": { audio: audio(0) },
    "wrong type": { audio: audio(2048, "text/plain") },
    "wav": { audio: audio(2048, "audio/wav") },
  };
  for (const [name, over] of Object.entries(cases)) {
    const r = parseUpload(valid(over), NOW);
    assertEquals(r.ok ? 200 : r.status, 400, name);
  }
});

Deno.test("oversized Recordings are 413", () => {
  const big = parseUpload(valid({ audio: audio(MAX_AUDIO_BYTES + 1) }), NOW);
  assertEquals(big.ok ? 200 : big.status, 413);
  const long = parseUpload(valid({ duration_ms: "61001" }), NOW);
  assertEquals(long.ok ? 200 : long.status, 413);
  assertEquals(parseUpload(valid({ duration_ms: "61000" }), NOW).ok, true);
  assertEquals(parseUpload(valid({ audio: audio(MAX_AUDIO_BYTES) }), NOW).ok, true);
});

Deno.test("the Perth day runs from 16:00 UTC to 16:00 UTC", () => {
  // 10:00 UTC on the 24th is 18:00 in Perth on the 24th.
  assertEquals(perthDay(NOW), { start: new Date("2026-11-23T16:00:00Z"), next: new Date("2026-11-24T16:00:00Z") });
  // 16:30 UTC on the 24th is 00:30 on the 25th in Perth.
  assertEquals(perthDay(new Date("2026-11-24T16:30:00Z")), {
    start: new Date("2026-11-24T16:00:00Z"),
    next: new Date("2026-11-25T16:00:00Z"),
  });
  // Exactly Perth midnight belongs to the new day.
  assertEquals(perthDay(new Date("2026-11-24T16:00:00Z")).start, new Date("2026-11-24T16:00:00Z"));
});

Deno.test("DAILY_CAP falls back to 50 unless it's a positive whole number", () => {
  assertEquals(dailyCap(undefined), 50);
  assertEquals(dailyCap(""), 50);
  assertEquals(dailyCap("0"), 50);
  assertEquals(dailyCap("-3"), 50);
  assertEquals(dailyCap("2.5"), 50);
  assertEquals(dailyCap("many"), 50);
  assertEquals(dailyCap("3"), 3);
});

Deno.test("CORS allows the configured origins and loopback only", () => {
  const allowed = ["https://lvanch.github.io"];
  assertEquals(allowedOrigin("https://lvanch.github.io", allowed), "https://lvanch.github.io");
  assertEquals(allowedOrigin("http://127.0.0.1:8000", allowed), "http://127.0.0.1:8000");
  assertEquals(allowedOrigin("http://localhost:5173", allowed), "http://localhost:5173");
  assertEquals(allowedOrigin("https://evil.example", allowed), null);
  assertEquals(allowedOrigin("http://lvanch.github.io", allowed), null);
  assertEquals(allowedOrigin(null, allowed), null);
  assertEquals(corsHeaders("https://evil.example", allowed), { Vary: "Origin" });
  assertEquals(
    corsHeaders("https://lvanch.github.io", allowed)["Access-Control-Allow-Origin"],
    "https://lvanch.github.io",
  );
});
