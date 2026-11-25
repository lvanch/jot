# Test fixtures

- `speech.wav` is about 6.5 s of 16 kHz mono PCM: 0.5 s of silence, the synthetic sentence "Call the bank about the Fremantle lease.", then 3.5 s of silence. Chromium plays it as a fake microphone (`--use-file-for-fake-audio-capture`) and loops it. The trailing silence is longer than Jot's 1.5 s stop-on-silence.

  It was made with [meSpeak](https://www.npmjs.com/package/mespeak) 2.0.2 (eSpeak, voice `en`, speed 150) and padded with ffmpeg:

  ```bash
  ffmpeg -f lavfi -t 0.5 -i anullsrc=r=16000:cl=mono -i speech-raw.wav -f lavfi -t 3.5 -i anullsrc=r=16000:cl=mono \
    -filter_complex "[1:a]aresample=16000,aformat=channel_layouts=mono[s];[0:a][s][2:a]concat=n=3:v=0:a=1" \
    -ar 16000 -ac 1 -c:a pcm_s16le speech.wav
  ```

  The audio is machine-generated, so there's no recording of a real person in the repo.
- Silent audio is generated on the fly by `test/e2e/harness.mjs` (`silentWav()`).
- `v1/` stands in for Jot v1 at its old address, for the cut-over test (`test/e2e/cutover.test.mjs`). `sw.js` and `manifest.webmanifest` are v1's own files, copied from `main` before cut-over. `index.html`, `app.js` and `styles.css` are stubs that only register that service worker.
