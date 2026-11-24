# Server-side transcription behind a Transcriber seam

Chrome's built-in speech recognition (Web Speech) mis-hears names and jargon, and on Android there's no way to bias it. Jot now records audio and sends the Recording to a server-side function. That function calls the Transcriber, ElevenLabs Scribe (batch, model `scribe_v3`), passing the Vocabulary as key terms. The API key lives only on the server. The vendor sits behind one Transcriber interface (Recording and Vocabulary in, Transcript out), so it can be replaced without touching Jot or the Inbox.

## Considered options

- **Keep Web Speech.** Rejected because accuracy is the problem and it has no vocabulary hints on Android.
- **On-device model (e.g. Whisper in WASM).** Rejected: a large download, slow on the phone, and no better at names without hints.
- **Other cloud vendors.** Any of them can go behind the same seam later. Scribe was picked for accuracy plus key-term prompting.

## Consequences

- Transcription needs a network connection. See ADR-0003 for offline handling.
- Cost is US$0.20 per audio hour, plus a 20% surcharge when key terms are sent: about US$0.24 an hour. At about 20 Captures a week that's under US$1 a year. Above 100 key terms ElevenLabs bills every request as at least 20 s of audio, which is why the Vocabulary stops at 100.
- Checked on 2026-11-24 against the API reference and live calls with an 8 s webm/opus clip recorded by Chromium's MediaRecorder:
  - The header is `xi-api-key`.
  - `language_code=en` is accepted.
  - Key terms go as repeated `keyterms` fields: at most 1000, each at most 50 characters and 5 words.
  - Chrome's `audio/webm;codecs=opus` is accepted.
  - Without the Vocabulary, Scribe v2 heard "Kalgoorlie" as "Calgary". With it, the sentence came back exactly right, in about 1 s.
- **Update, 2026-11-24 (the Owner's call):**
  - The default model moves from `scribe_v2` to `scribe_v3`, which came out after this decision. It's the same price and API, and claims 27% fewer errors.
  - Filler words are dropped (`no_verbatim`), so "um", "uh" and false starts never reach the Transcript.
  - Both are settings (`ELEVENLABS_MODEL`, `ELEVENLABS_NO_VERBATIM=0`), so either can be reverted without a deploy of new code.
  - A live check with these defaults returned the test sentence exactly right in 0.9 s.
