// Picks the Transcriber from the environment (spec §5).
//
//   TRANSCRIBER             elevenlabs (default) | fake
//   ELEVENLABS_API_KEY      required for elevenlabs (a function secret, never committed)
//   ELEVENLABS_MODEL        optional; defaults to scribe_v2
//   ELEVENLABS_NO_VERBATIM  optional; "1" drops filler words
//   ALLOW_FAKE_TRANSCRIBER  "1" to permit the fake (tests only)

import { createElevenLabsTranscriber } from "./elevenlabs.ts";
import { createFakeTranscriber } from "./fake.ts";
import type { Transcriber } from "./types.ts";

export * from "./types.ts";

type Env = (name: string) => string | undefined;

export function getTranscriber(env: Env = (name) => Deno.env.get(name)): Transcriber {
  const which = env("TRANSCRIBER") || "elevenlabs";
  switch (which) {
    case "elevenlabs": {
      const apiKey = env("ELEVENLABS_API_KEY");
      if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
      return createElevenLabsTranscriber({
        apiKey,
        model: env("ELEVENLABS_MODEL") || undefined,
        noVerbatim: env("ELEVENLABS_NO_VERBATIM") === "1",
      });
    }
    case "fake":
      return createFakeTranscriber(env("ALLOW_FAKE_TRANSCRIBER"));
    default:
      throw new Error(`Unknown TRANSCRIBER: ${which}`);
  }
}
