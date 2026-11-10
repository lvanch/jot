# Server-side transcription behind a Transcriber seam

Chrome's built-in speech recognition (Web Speech) mis-hears names and jargon, and on Android there's no way to bias it. Jot now records audio and sends the Recording to a server-side function. That function calls the Transcriber, ElevenLabs Scribe v2 (batch), passing the Vocabulary as key terms. The API key lives only on the server. The vendor sits behind one Transcriber interface (Recording and Vocabulary in, Transcript out), so it can be replaced without touching Jot or the Inbox.

## Considered options

- **Keep Web Speech.** Rejected because accuracy is the problem and it has no vocabulary hints on Android.
- **On-device model (e.g. Whisper in WASM).** Rejected: a large download, slow on the phone, and no better at names without hints.
- **Other cloud vendors.** Any of them can go behind the same seam later. Scribe v2 was picked for accuracy plus key-term prompting.

## Consequences

- Transcription needs a network connection. See ADR-0003 for offline handling.
- Cost is about US$0.27 per audio hour (US$0.22 base plus US$0.05 for key terms). At about 20 Captures a week that's roughly US$1 a year.
- The key-term limits are unverified: sources say 100 or 1000 terms, possibly under 50 characters each. Check them against the official API reference at build time.
- Android Chrome's MediaRecorder produces `audio/webm;codecs=opus`, which Scribe lists as accepted. Confirm with a real call at build time.
