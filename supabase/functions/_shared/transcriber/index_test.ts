import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.13";
import { FAKE_REFUSE, FAKE_UNAVAILABLE } from "./fake.ts";
import { getTranscriber, TranscriberRefused, TranscriberUnavailable } from "./index.ts";

const envOf = (vars: Record<string, string>) => (name: string) => vars[name];
const blob = (bytes: number | string) =>
  new Blob([typeof bytes === "number" ? new Uint8Array(bytes) : new TextEncoder().encode(bytes.padEnd(2048, " "))]);

Deno.test("defaults to ElevenLabs", () => {
  assertEquals(getTranscriber(envOf({ ELEVENLABS_API_KEY: "k" })).name, "elevenlabs");
});

Deno.test("ElevenLabs settings come from the environment", async () => {
  const sent: FormData[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    sent.push(init!.body as FormData);
    return Promise.resolve(new Response(JSON.stringify({ text: "x" }), { status: 200 }));
  }) as typeof fetch;
  try {
    const base = { audio: blob(2048), mimeType: "audio/webm", vocabulary: [], language: "en" as const };
    await getTranscriber(envOf({ ELEVENLABS_API_KEY: "k" })).transcribe(base);
    await getTranscriber(envOf({ ELEVENLABS_API_KEY: "k", ELEVENLABS_MODEL: "scribe_v2", ELEVENLABS_NO_VERBATIM: "0" }))
      .transcribe(base);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals([sent[0].get("model_id"), sent[0].get("no_verbatim")], ["scribe_v3", "true"]);
  assertEquals([sent[1].get("model_id"), sent[1].get("no_verbatim")], ["scribe_v2", null]);
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
