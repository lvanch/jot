import { assert, assertEquals, assertInstanceOf, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  createElevenLabsTranscriber,
  ELEVENLABS_STT_URL,
  filenameFor,
  MAX_KEYTERMS,
  usableKeyterms,
} from "./elevenlabs.ts";
import { type TranscribeInput, TranscriberRefused, TranscriberUnavailable } from "./types.ts";

const audio = new Blob([new Uint8Array(2048)], { type: "audio/webm" });
const input = (vocabulary: string[] = []): TranscribeInput => ({
  audio,
  mimeType: "audio/webm;codecs=opus",
  vocabulary,
  language: "en",
});

interface Call {
  url: string;
  init: RequestInit;
  form: FormData;
}

/** A fetch stub that records each call and answers with `respond`. */
function stubFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init!, form: init!.body as FormData };
    calls.push(call);
    return await respond(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

Deno.test("sends the documented request", async () => {
  const { fetch, calls } = stubFetch(() =>
    ok({ text: "Call Ngaio", language_code: "eng", language_probability: 0.99 })
  );
  const t = createElevenLabsTranscriber({ apiKey: "k-123", fetch });
  await t.transcribe(input(["Ngaio", "Fremantle"]));

  assertEquals(calls.length, 1);
  const { url, init, form } = calls[0];
  assertEquals(url, ELEVENLABS_STT_URL);
  assertEquals(init.method, "POST");
  assertEquals((init.headers as Record<string, string>)["xi-api-key"], "k-123");
  assertEquals(form.get("model_id"), "scribe_v3");
  assertEquals(form.get("language_code"), "en");
  assertEquals(form.get("tag_audio_events"), "false");
  assertEquals(form.get("diarize"), "false");
  assertEquals(form.get("timestamps_granularity"), "none");
  assertEquals(form.get("no_verbatim"), "true");
  assertEquals(form.getAll("keyterms"), ["Ngaio", "Fremantle"]);
  const file = form.get("file") as File;
  assertInstanceOf(file, File);
  assertEquals(file.name, "recording.webm");
  assertEquals(file.type, "audio/webm;codecs=opus");
  assertEquals(file.size, 2048);
});

Deno.test("omits keyterms when the Vocabulary is empty", async () => {
  const { fetch, calls } = stubFetch(() => ok({ text: "" }));
  await createElevenLabsTranscriber({ apiKey: "k", fetch }).transcribe(input([]));
  assertEquals(calls[0].form.has("keyterms"), false);
});

Deno.test("model and no_verbatim are configurable", async () => {
  const { fetch, calls } = stubFetch(() => ok({ text: "x" }));
  const r = await createElevenLabsTranscriber({ apiKey: "k", fetch, model: "scribe_v2", noVerbatim: false }).transcribe(
    input(),
  );
  assertEquals(calls[0].form.get("model_id"), "scribe_v2");
  assertEquals(calls[0].form.has("no_verbatim"), false);
  assertEquals(r.model, "scribe_v2");
  assertEquals(r.meta.no_verbatim, undefined);
});

Deno.test("returns text, language and useful meta, nothing else", async () => {
  const { fetch } = stubFetch(() =>
    ok({
      text: "Call Ngaio about the Fremantle lease",
      language_code: "eng",
      language_probability: 0.98,
      audio_duration_secs: 3.2,
      transcription_id: "tr_1",
      words: [{ text: "Call" }],
    })
  );
  const r = await createElevenLabsTranscriber({ apiKey: "k", fetch }).transcribe(input(["Ngaio"]));
  assertEquals(r, {
    text: "Call Ngaio about the Fremantle lease",
    language: "eng",
    model: "scribe_v3",
    meta: {
      keyterms: 1,
      language_probability: 0.98,
      audio_duration_secs: 3.2,
      transcription_id: "tr_1",
      no_verbatim: true,
    },
  });
});

Deno.test("usableKeyterms keeps only terms ElevenLabs accepts", () => {
  assertEquals(
    usableKeyterms([
      "  Ngaio  ",
      "ngaio", // duplicate, ignoring case
      "",
      "   ",
      "x".repeat(51), // too long
      "one two three four five six", // six words
      "Fremantle   Ports", // inner spaces collapse
      "a<b",
      "{braces}",
      "[x]",
      "back\\slash",
      "Rottnest",
    ]),
    ["Ngaio", "Fremantle Ports", "Rottnest"],
  );
  assertEquals(usableKeyterms(Array.from({ length: 150 }, (_, i) => `term ${i}`)).length, MAX_KEYTERMS);
});

Deno.test("filenameFor matches the MIME type", () => {
  assertEquals(filenameFor("audio/webm;codecs=opus"), "recording.webm");
  assertEquals(filenameFor("audio/ogg;codecs=opus"), "recording.ogg");
  assertEquals(filenameFor("audio/mp4"), "recording.m4a");
  assertEquals(filenameFor("application/x-unknown"), "recording.bin");
});

for (const status of [400, 413, 415, 422]) {
  Deno.test(`${status} means the Recording was refused`, async () => {
    const { fetch } = stubFetch(() => new Response('{"detail":"bad audio"}', { status }));
    const err = await assertRejects(
      () => createElevenLabsTranscriber({ apiKey: "k", fetch }).transcribe(input()),
      TranscriberRefused,
    );
    assertEquals(err.status, status);
  });
}

for (const status of [401, 402, 403, 404, 408, 429, 500, 502, 503]) {
  Deno.test(`${status} means try again later`, async () => {
    const { fetch } = stubFetch(() => new Response("nope", { status }));
    const err = await assertRejects(
      () => createElevenLabsTranscriber({ apiKey: "k", fetch }).transcribe(input()),
      TranscriberUnavailable,
    );
    assertEquals(err.status, status);
  });
}

Deno.test("a network failure is retryable", async () => {
  const { fetch } = stubFetch(() => {
    throw new TypeError("connection refused");
  });
  const err = await assertRejects(
    () => createElevenLabsTranscriber({ apiKey: "k", fetch }).transcribe(input()),
    TranscriberUnavailable,
  );
  assertEquals(err.message, "ElevenLabs unreachable (TypeError)");
});

Deno.test("a slow answer times out as retryable", async () => {
  const { fetch } = stubFetch(({ init }) =>
    new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))
  );
  const started = Date.now();
  const err = await assertRejects(
    () => createElevenLabsTranscriber({ apiKey: "k", fetch, timeoutMs: 30 }).transcribe(input()),
    TranscriberUnavailable,
  );
  assertEquals(err.message, "ElevenLabs timed out");
  assert(Date.now() - started < 2000);
});

Deno.test("a 200 that isn't a transcript is retryable", async () => {
  for (const res of [new Response("<html>", { status: 200 }), ok({ detail: "no text here" })]) {
    const { fetch } = stubFetch(() => res);
    await assertRejects(
      () => createElevenLabsTranscriber({ apiKey: "k", fetch }).transcribe(input()),
      TranscriberUnavailable,
    );
  }
});

Deno.test("error messages never include the key or the Transcript", async () => {
  const { fetch } = stubFetch(() => new Response("secret transcript text k-SECRET", { status: 500 }));
  const err = await assertRejects(
    () => createElevenLabsTranscriber({ apiKey: "k-SECRET", fetch }).transcribe(input()),
    TranscriberUnavailable,
  );
  assertEquals(err.message.includes("k-SECRET"), false);
  assertEquals(err.message.includes("transcript"), false);
});

Deno.test("refuses to start without a key", () => {
  let threw = false;
  try {
    createElevenLabsTranscriber({ apiKey: "" });
  } catch {
    threw = true;
  }
  assert(threw);
});
