// One Recording: open the mic, record with MediaRecorder, meter the level, and stop when silence.js says so
// (spec §6 "Recording", ADR-0003).

import { createDetector, DEFAULTS, rmsDb } from './silence.js';

const TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
const FRAME_MS = 50;
const BITRATE = 32_000; // speech at 32 kbps: ~4 KB/s, so a minute fits well under the 1 MB limit

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

function unsupported() {
  const err = new Error('MediaRecorder is not available');
  err.name = 'NotSupportedError';
  return err;
}

/**
 * Starts recording. Resolves once the mic is open.
 *
 * `done` resolves when recording stops, by silence, the cap, or `stop(reason)`, with
 * `{ reason, heard, metering, blob, mimeType, startedAt, durationMs }`.
 * Without level metering (the AudioContext couldn't start), there's no auto-stop: it runs until a tap or the cap,
 * and `heard` is true because there's no way to know.
 *
 * @param {{ onLevel?: (db: number) => void }} [options]
 */
export async function startRecording({ onLevel } = {}) {
  const mimeType = pickMimeType();
  if (!mimeType || !navigator.mediaDevices?.getUserMedia) throw unsupported();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const releaseMic = () => stream.getTracks().forEach((t) => t.stop());

  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: BITRATE });
  } catch (err) {
    releaseMic();
    throw err;
  }

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };

  // Level metering. If the AudioContext can't run (e.g. autoplay rules), record anyway, without auto-stop.
  const detector = createDetector();
  let ctx = null;
  let analyser = null;
  try {
    ctx = new AudioContext();
    if (ctx.state !== 'running') await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
  } catch {
    analyser = null;
  }
  const metering = !!analyser && ctx?.state === 'running';

  const startedAt = Date.now();
  const t0 = performance.now();
  let reason = null;
  let timer = 0;
  let resolveDone;
  const done = new Promise((resolve) => (resolveDone = resolve));

  function finish() {
    clearInterval(timer);
    clearTimeout(timer);
    releaseMic();
    ctx?.close().catch(() => {});
    const type = recorder.mimeType || mimeType;
    resolveDone({
      reason: reason ?? 'error',
      heard: metering ? detector.heard : true,
      metering,
      blob: new Blob(chunks, { type }),
      mimeType: type,
      startedAt,
      durationMs: Math.round(performance.now() - t0),
    });
  }

  /** @param {'silence' | 'no-speech' | 'max' | 'tap' | 'hidden' | 'error'} why */
  function stop(why) {
    if (reason) return;
    reason = why;
    clearInterval(timer);
    clearTimeout(timer);
    if (recorder.state !== 'inactive') recorder.stop(); // onstop → finish, after the last dataavailable
    else finish();
  }

  recorder.onstop = finish;
  recorder.onerror = () => stop('error');

  if (metering) {
    const buf = new Float32Array(analyser.fftSize);
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const db = rmsDb(buf);
      onLevel?.(db);
      const decision = detector.push(db, performance.now() - t0);
      if (decision) stop(decision.stop);
    }, FRAME_MS);
  } else {
    timer = setTimeout(() => stop('max'), DEFAULTS.maxMs);
  }

  recorder.start();
  return { stop, done, metering, mimeType };
}
