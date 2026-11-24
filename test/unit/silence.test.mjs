import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDetector, DEFAULTS, keepRecording, rmsDb } from '../../app/silence.js';

const FRAME = 50;
const QUIET = -65; // a quiet room with noise suppression
const SPEECH = -25; // a voice close to a phone mic
// Real speech dips between words. Without dips, a constant loud level would slowly become the "noise floor".
const SPEAKING = (t) => (t % 600 < 500 ? SPEECH : -60);

/** Runs a detector over [level, ms] segments and returns the first decision with the time it was made. */
function run(segments, options) {
  const d = createDetector(options);
  let t = 0;
  for (const [db, ms] of segments) {
    for (const end = t + ms; t < end; t += FRAME) {
      const decision = d.push(typeof db === 'function' ? db(t) : db, t);
      if (decision) return { ...decision, t };
    }
  }
  return { stop: null, heard: d.heard, t };
}

test('normal speech, then a pause, stops 1.5 s into the pause', () => {
  const r = run([[QUIET, 500], [SPEECH, 3000], [QUIET, 5000]]);
  assert.equal(r.stop, 'silence');
  assert.equal(r.heard, true);
  assert.ok(r.t >= 3500 + 1500 && r.t <= 3500 + 1500 + FRAME, `stopped at ${r.t}`);
});

test('no speech gives up at 8 s and keeps nothing', () => {
  const r = run([[QUIET, 20_000]]);
  assert.deepEqual([r.stop, r.heard], ['no-speech', false]);
  assert.ok(r.t >= DEFAULTS.noSpeechMs && r.t < DEFAULTS.noSpeechMs + FRAME);
  assert.equal(keepRecording(r.stop, r.heard, r.t), false);
});

test('a 61 s monologue stops at the 60 s cap and is kept', () => {
  const r = run([[QUIET, 300], [SPEAKING, 61_000]]);
  assert.deepEqual([r.stop, r.heard], ['max', true]);
  assert.ok(r.t >= DEFAULTS.maxMs && r.t < DEFAULTS.maxMs + FRAME);
  assert.equal(keepRecording(r.stop, r.heard, r.t), true);
});

test('blips shorter than 150 ms never count as speech', () => {
  // 100 ms knocks every second for 10 s: never "speech", so the Capture gives up.
  const blips = (t) => (t % 1000 < 100 ? SPEECH : QUIET);
  const r = run([[blips, 12_000]]);
  assert.deepEqual([r.stop, r.heard], ['no-speech', false]);
});

test('a pause under 1.5 s mid-sentence does not stop the Capture', () => {
  const r = run([[QUIET, 300], [SPEECH, 1500], [QUIET, 1400], [SPEECH, 1500], [QUIET, 3000]]);
  assert.equal(r.stop, 'silence');
  assert.ok(r.t >= 300 + 1500 + 1400 + 1500 + 1500, `only the final pause stops it (stopped at ${r.t})`);
});

test('speech from the very first frame still counts (the floor drops at the first gap between words)', () => {
  const r = run([[SPEAKING, 2000], [QUIET, 3000]]);
  assert.deepEqual([r.stop, r.heard], ['silence', true]);
});

test('in a noisy place, the thresholds follow the noise floor', () => {
  // A car: -40 dB of road noise. Speech is 15 dB louder. Without the floor, the noise itself would be "speech"
  // and never "quiet", so the Capture would run to the cap.
  const r = run([[-40, 1000], [-25, 2500], [-40, 5000]]);
  assert.deepEqual([r.stop, r.heard], ['silence', true]);
  assert.ok(r.t < 1000 + 2500 + 1500 + 500, `stopped at ${r.t}`);

  // Noise alone, however loud, is never speech.
  const noise = run([[-40, 10_000]]);
  assert.equal(noise.stop, 'no-speech');
});

test('the noise floor rises slowly, not with the voice', () => {
  const d = createDetector();
  let t = 0;
  for (; t < 500; t += FRAME) d.push(QUIET, t);
  for (; t < 3500; t += FRAME) d.push(SPEECH, t);
  // 3 s of speech may lift the floor by at most 2 dB/s × 3 s.
  assert.ok(d.floor <= QUIET + 6 + 0.01, `floor ${d.floor}`);
});

test('keepRecording: what each way of stopping keeps', () => {
  assert.equal(keepRecording('silence', true, 4000), true);
  assert.equal(keepRecording('max', false, 60_000), false);
  assert.equal(keepRecording('no-speech', false, 8000), false);
  assert.equal(keepRecording('tap', true, 600), true);
  assert.equal(keepRecording('tap', false, 1200), true, 'a deliberate tap after a second is sent anyway');
  assert.equal(keepRecording('tap', false, 400), false, 'an instant tap-tap is a cancel');
  assert.equal(keepRecording('hidden', true, 3000), true);
  assert.equal(keepRecording('hidden', false, 3000), false);
});

test('rmsDb', () => {
  assert.equal(rmsDb(new Float32Array(512)), -100);
  assert.ok(Math.abs(rmsDb(new Float32Array(512).fill(1)) - 0) < 1e-9);
  assert.ok(Math.abs(rmsDb(new Float32Array(512).fill(0.1)) - -20) < 1e-6);
  assert.equal(rmsDb(new Float32Array(512).fill(1e-9)), -100, 'clamped');
});
