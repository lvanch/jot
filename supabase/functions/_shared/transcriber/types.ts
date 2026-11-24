// The Transcriber seam (ADR-0001, spec §5). Every speech-to-text vendor sits behind this interface, so swapping
// vendors never touches Jot or the Inbox.

export type Language = "en";

export interface TranscribeInput {
  /** The Recording. */
  audio: Blob;
  /** e.g. "audio/webm;codecs=opus". */
  mimeType: string;
  /** The Owner's Vocabulary. Adapters drop terms their vendor can't take; they never fail because of one. */
  vocabulary: string[];
  language: Language;
}

export interface TranscribeResult {
  /** The Transcript, exactly as the vendor returned it. Callers trim it and decide whether it's empty. */
  text: string;
  /** The language the vendor reports, or null. */
  language: string | null;
  /** The vendor's model id, e.g. "scribe_v3". */
  model: string;
  /** Vendor extras worth keeping on the Item, e.g. language probability. Never audio or keys. */
  meta: Record<string, unknown>;
}

export interface Transcriber {
  /** Vendor name, e.g. "elevenlabs". Items record `${name}/${model}`. */
  readonly name: string;
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}

/** Worth retrying later: network failure, timeout, rate limit, vendor outage, or our own account/key problem. */
export class TranscriberUnavailable extends Error {
  override name = "TranscriberUnavailable";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** Never worth retrying: the vendor rejected this Recording itself (unreadable, too short, invalid). */
export class TranscriberRefused extends Error {
  override name = "TranscriberRefused";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}
