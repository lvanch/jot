# Park on Transcript, queue Recordings, no Web Speech fallback

Each Capture in Jot works like this:
- **Recording.** Jot records with MediaRecorder. It stops after about 1.5 s of silence following speech, when you tap, or at a hard cap, whichever comes first.
- **Upload and Park.** It uploads the Recording and parks the Item the moment a non-empty Transcript comes back. Undo, available for 5 s, discards the Item.
- **Empty Transcript.** Nothing is parked and Jot says "Didn't catch that".
- **Offline or server error.** The Recording becomes a Queued Capture on the phone and is retried with backoff.
- **Permanent refusal.** It becomes a Failed Capture, with a retry.

We deliberately do **not** fall back to Chrome's Web Speech recogniser when the server can't be reached. Known-bad text in the Inbox is worse than a delay, and since the Recording is kept nothing is lost.

## Consequences

- Text no longer appears live while you speak: Web Speech and MediaRecorder can't reliably share the mic on Android.
- A Recording stays on the phone until the server confirms its Item was parked.
- An upload is identified by its Capture, so retrying after a lost response never parks the same thought twice.
- If the Android mic proves to clip the first word, a short pre-roll buffer is the planned fix. It's not built until it's observed.
