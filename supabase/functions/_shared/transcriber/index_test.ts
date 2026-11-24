import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.13";
import { FAKE_REFUSE, FAKE_UNAVAILABLE } from "./fake.ts";
import { getTranscriber, TranscriberRefused, TranscriberUnavailable } from "./index.ts";

const envOf = (vars: Record<string, string>) => (name: string) => vars[name];
const blob = (bytes: number | string) =>
  new Blob([typeof bytes === "number" ? new Uint8Array(bytes) : new TextEncoder().encode(bytes.padEnd(2048, " "))]);

Deno.test("defaults to ElevenLabs", () => {
  assertEquals(getTranscriber(envOf({ ELEVENLABS_API_KEY: "k" })).name, "elevenlabs");
});

Deno.test("ElevenLabs needs its key", () => {
  assertThrows(() => getTranscriber(envOf({})), Error, "ELEVENLABS_API_KEY is not set");
});

Deno.test("unknown Transcriber names are refused", () => {
  assertThrows(() => getTranscriber(envOf({ TRANSCRIBER: "whisper" })), Error, "Unknown TRANSCRIBER: whisper");
});

Deno.test("the fake only loads when explicitly allowed", () => {
  assertThrows(() => getTranscriber(envOf({ TRANSCRIBER: "fake" })), Error, "tests only");
  assertThrows(
    () => getTranscriber(envOf({ TRANSCRIBER: "fake", ALLOW_FAKE_TRANSCRIBER: "true" })),
    Error,
    "tests only",
  );
  assertEquals(getTranscriber(envOf({ TRANSCRIBER: "fake", ALLOW_FAKE_TRANSCRIBER: "1" })).name, "fake");
});

Deno.test("the fake is deterministic and echoes the Vocabulary", async () => {
  const fake = getTranscriber(envOf({ TRANSCRIBER: "fake", ALLOW_FAKE_TRANSCRIBER: "1" }));
  const base = { mimeType: "audio/webm", vocabulary: ["Ngaio"], language: "en" as const };

  const r = await fake.transcribe({ ...base, audio: blob(4096) });
  assertEquals(r, { text: "fake transcript 4096", language: "en", model: "fake", meta: { vocabulary: ["Ngaio"] } });
  assertEquals((await fake.transcribe({ ...base, audio: blob(4096) })).text, r.text);
  assertEquals((await fake.transcribe({ ...base, audio: blob(100) })).text, "");

  await assertRejects(() => fake.transcribe({ ...base, audio: blob(FAKE_REFUSE) }), TranscriberRefused);
  await assertRejects(() => fake.transcribe({ ...base, audio: blob(FAKE_UNAVAILABLE) }), TranscriberUnavailable);
});
