// When to stop a Capture: the pure part of recording (ADR-0003, spec §6 "Recording"). Fed one audio level every
// ~50 ms, it decides when speech has started, when it has stopped, and when to give up. No browser APIs here, so
// it's unit-tested with synthetic level sequences (test/unit/silence.test.mjs).

export const DEFAULTS = Object.freeze({
  /** Speech needs at least this level (dBFS)… */
  speechDb: -45,
  /** …or this far above the noise floor, whichever is higher, so a noisy room doesn't count as speech. */
  speechAboveFloorDb: 12,
  /** Quiet is below this level (dBFS)… */
  silenceDb: -52,
  /** …or within this much of the noise floor, whichever is higher. */
  silenceAboveFloorDb: 6,
  /** Speech starts once the level has stayed up this long, so clicks and bumps don't count. */
  speechStartMs: 150,
  /** After speech, this much quiet ends the Capture. */
  silenceStopMs: 1500,
  /** With no speech by now, give up and throw the Recording away. */
  noSpeechMs: 8000,
  /** Hard cap (ADR-0008). */
  maxMs: 60_000,
  /** How fast the noise floor may rise, in dB per second, so it follows a car starting but not a voice. */
  floorRiseDbPerSec: 2,
});

/** RMS level of float samples (-1…1) in dBFS. Digital silence is -100. */
export function rmsDb(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

/**
 * @typedef {'silence' | 'no-speech' | 'max'} StopReason
 * @typedef {{ stop: StopReason, heard: boolean }} Decision
 */

export function createDetector(options = {}) {
  const o = { ...DEFAULTS, ...options };
  let floor = null; // the quietest recent level
  let lastT = null;
  let loudSince = null; // start of the current run above the speech threshold
  let quietSince = null; // start of the current run below the silence threshold
  let heard = false;

  return {
    get heard() {
      return heard;
    },
    get floor() {
      return floor;
    },
    /**
     * @param {number} db level in dBFS
     * @param {number} t ms since recording started
     * @returns {Decision | null} a decision to stop, or null to keep going
     */
    push(db, t) {
      const dt = lastT === null ? 0 : Math.max(0, t - lastT);
      lastT = t;
      floor = floor === null ? db : Math.min(db, floor + (o.floorRiseDbPerSec * dt) / 1000);

      const speechAt = Math.max(o.speechDb, floor + o.speechAboveFloorDb);
      const quietAt = Math.max(o.silenceDb, floor + o.silenceAboveFloorDb);

      if (db >= speechAt) {
        loudSince ??= t;
        if (!heard && t - loudSince >= o.speechStartMs) heard = true;
      } else {
        loudSince = null;
      }

      if (db < quietAt) quietSince ??= t;
      else quietSince = null;

      if (heard && quietSince !== null && t - quietSince >= o.silenceStopMs) return { stop: 'silence', heard };
      if (t >= o.maxMs) return { stop: 'max', heard };
      if (!heard && t >= o.noSpeechMs) return { stop: 'no-speech', heard };
      return null;
    },
  };
}

/**
 * Whether a stopped Capture is worth sending.
 * @param {StopReason | 'tap' | 'hidden'} reason
 * @param {boolean} heard speech was detected
 * @param {number} durationMs
 */
export function keepRecording(reason, heard, durationMs) {
  switch (reason) {
    case 'silence':
    case 'max':
      return heard;
    case 'tap':
      // A deliberate tap after a second or more is worth sending even if the level never crossed the threshold:
      // a soft voice costs a cent at most, and an empty Transcript parks nothing.
      return heard || durationMs >= 1000;
    case 'hidden':
      return heard;
    default:
      return false; // 'no-speech'
  }
}
