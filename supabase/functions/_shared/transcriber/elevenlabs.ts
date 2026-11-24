// ElevenLabs Scribe adapter (ADR-0001, ADR-0007, spec §5).
// API: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
//
// Never log the audio, the Transcript or the key.

import {
  type TranscribeInput,
  type Transcriber,
  type TranscribeResult,
  TranscriberRefused,
  TranscriberUnavailable,
} from "./types.ts";

export const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
export const DEFAULT_MODEL = "scribe_v2";
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Key-term limits for batch transcription, from the API reference:
 * - at most 1000 terms;
 * - at most 50 characters and 5 words each;
 * - none of < > { } [ ] \
 *
 * Above 100 terms, every request is billed for at least 20 s of audio. That's why the Vocabulary stops at 100.
 */
export const MAX_KEYTERMS = 100;
const MAX_KEYTERM_CHARS = 50;
const MAX_KEYTERM_WORDS = 5;
const BANNED_KEYTERM_CHARS = /[<>{}[\]\\]/;

/** Statuses that mean the Recording itself was rejected. Anything else non-2xx is worth retrying. */
const REFUSED_STATUSES = new Set([400, 413, 415, 422]);

export interface ElevenLabsOptions {
  apiKey: string;
  /** Model id; defaults to scribe_v2. */
  model?: string;
  /** Drop filler words and false starts ("um", "uh"). Off by default. */
  noVerbatim?: boolean;
  timeoutMs?: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

/** The Vocabulary terms ElevenLabs will accept, trimmed, de-duplicated (ignoring case), capped at MAX_KEYTERMS. */
export function usableKeyterms(vocabulary: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of vocabulary) {
    const term = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!term || term.length > MAX_KEYTERM_CHARS) continue;
    if (term.split(" ").length > MAX_KEYTERM_WORDS) continue;
    if (BANNED_KEYTERM_CHARS.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length === MAX_KEYTERMS) break;
  }
  return out;
}

/** A filename whose extension matches the MIME type, so the vendor's format sniffing has a hint. */
export function filenameFor(mimeType: string): string {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  const ext = ({
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  } as Record<string, string>)[base];
  return `recording.${ext ?? "bin"}`;
}

export function createElevenLabsTranscriber(options: ElevenLabsOptions): Transcriber {
  const { apiKey, model = DEFAULT_MODEL, noVerbatim = false, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const doFetch = options.fetch ?? fetch;
  if (!apiKey) throw new Error("ElevenLabs API key is missing");

  async function transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const keyterms = usableKeyterms(input.vocabulary);
    const form = new FormData();
    form.append("model_id", model);
    form.append("file", new File([input.audio], filenameFor(input.mimeType), { type: input.mimeType }));
    form.append("language_code", input.language);
    form.append("tag_audio_events", "false"); // keep "(laughter)" etc. out of the Text
    form.append("diarize", "false");
    form.append("timestamps_granularity", "none"); // we don't use word timings
    if (noVerbatim) form.append("no_verbatim", "true");
    for (const term of keyterms) form.append("keyterms", term); // repeated field, as the official SDK sends it

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(ELEVENLABS_STT_URL, {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = controller.signal.aborted;
      throw new TranscriberUnavailable(timedOut ? "ElevenLabs timed out" : `ElevenLabs unreachable (${errName(err)})`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      await res.body?.cancel();
      const message = `ElevenLabs answered ${res.status}`;
      if (REFUSED_STATUSES.has(res.status)) throw new TranscriberRefused(message, res.status);
      // 401/402/403 mean our key or credit, 429 and 5xx mean try later. Either way the Recording is fine.
      throw new TranscriberUnavailable(message, res.status);
    }

    let data: Record<string, unknown>;
    try {
      data = await res.json();
    } catch {
      throw new TranscriberUnavailable("ElevenLabs sent a response that isn't JSON", res.status);
    }
    if (!data || typeof data.text !== "string") {
      throw new TranscriberUnavailable("ElevenLabs sent a response without text", res.status);
    }

    const meta: Record<string, unknown> = { keyterms: keyterms.length };
    if (typeof data.language_probability === "number") meta.language_probability = data.language_probability;
    if (typeof data.audio_duration_secs === "number") meta.audio_duration_secs = data.audio_duration_secs;
    if (typeof data.transcription_id === "string") meta.transcription_id = data.transcription_id;
    if (noVerbatim) meta.no_verbatim = true;

    return {
      text: data.text,
      language: typeof data.language_code === "string" ? data.language_code : null,
      model,
      meta,
    };
  }

  return { name: "elevenlabs", transcribe };
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "error";
}
