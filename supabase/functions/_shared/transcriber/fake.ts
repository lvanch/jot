// A deterministic Transcriber for tests (spec §5). It never runs in production: it refuses to load unless
// ALLOW_FAKE_TRANSCRIBER=1.
//
// Behaviour, chosen by the Recording's bytes:
//   under 1 KB                      → empty Transcript ("Didn't catch that")
//   starts with "FAKE:REFUSE"       → TranscriberRefused (422)
//   starts with "FAKE:UNAVAILABLE"  → TranscriberUnavailable (503)
//   anything else                   → "fake transcript <bytes>"
// meta.vocabulary echoes the terms it was given, so tests can check the Vocabulary reached the Transcriber.

import {
  type TranscribeInput,
  type Transcriber,
  type TranscribeResult,
  TranscriberRefused,
  TranscriberUnavailable,
} from "./types.ts";

export const FAKE_REFUSE = "FAKE:REFUSE";
export const FAKE_UNAVAILABLE = "FAKE:UNAVAILABLE";
export const FAKE_EMPTY_BELOW_BYTES = 1024;

export function createFakeTranscriber(allow: string | undefined): Transcriber {
  if (allow !== "1") {
    throw new Error("The fake Transcriber is for tests only: set ALLOW_FAKE_TRANSCRIBER=1 to use it");
  }

  async function transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const head = new TextDecoder().decode(await input.audio.slice(0, 32).arrayBuffer());
    if (head.startsWith(FAKE_REFUSE)) throw new TranscriberRefused("fake refusal", 422);
    if (head.startsWith(FAKE_UNAVAILABLE)) throw new TranscriberUnavailable("fake outage", 503);
    const size = input.audio.size;
    return {
      text: size < FAKE_EMPTY_BELOW_BYTES ? "" : `fake transcript ${size}`,
      language: input.language,
      model: "fake",
      meta: { vocabulary: [...input.vocabulary] },
    };
  }

  return { name: "fake", transcribe };
}
