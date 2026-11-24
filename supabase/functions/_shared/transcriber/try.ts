// Manual check against the real ElevenLabs API: transcribe one local file and print the result.
//
//   ELEVENLABS_API_KEY=… deno run --allow-env --allow-read --allow-net \
//     supabase/functions/_shared/transcriber/try.ts <audio-file> [vocabulary term …]
//
// Optional: ELEVENLABS_MODEL=scribe_v2, ELEVENLABS_NO_VERBATIM=0. This costs a few cents of credit at most.

import { getTranscriber } from "./index.ts";

const [path, ...vocabulary] = Deno.args;
if (!path) {
  console.error("usage: try.ts <audio-file> [vocabulary term …]");
  Deno.exit(2);
}

const ext = path.split(".").pop()?.toLowerCase();
const mimeType = ({
  webm: "audio/webm",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
} as Record<string, string>)[ext ?? ""] ??
  "application/octet-stream";

const audio = new Blob([await Deno.readFile(path)], { type: mimeType });
const started = performance.now();
const result = await getTranscriber().transcribe({ audio, mimeType, vocabulary, language: "en" });
console.log(
  JSON.stringify({ ...result, ms: Math.round(performance.now() - started), bytes: audio.size, mimeType }, null, 2),
);
