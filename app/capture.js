// The mic: start and stop Captures, show their state, and hand each kept Recording to `onCapture`
// (spec §6 "Recording", ADR-0003). The queue (#9) is the consumer.

import { micErrorMessage } from './mic-errors.js';
import { pickMimeType, startRecording } from './recorder.js';
import { keepRecording } from './silence.js';
import { $, setStatus } from './ui.js';

/** Phones open Jot to speak; on a laptop the mic waits for a tap. */
export const AUTO_LISTEN = window.matchMedia('(pointer: coarse)').matches;
export const DEVICE = AUTO_LISTEN ? 'phone' : 'desktop';

/**
 * @typedef {{ id: string, blob: Blob, mimeType: string, capturedAt: number, durationMs: number, device: string,
 *   stop: string }} Capture
 * @param {{ onCapture: (capture: Capture) => void }} options
 */
export function initCapture({ onCapture }) {
  const micBtn = $('mic');
  const fabBtn = $('fab');
  let session = null; // the Recording in progress: { handle, auto }
  let opening = false; // waiting for the mic to open

  function setListening(on) {
    for (const b of [micBtn, fabBtn]) {
      b.classList.toggle('is-listening', on);
      b.setAttribute('aria-label', on ? 'Stop listening' : 'Start listening');
    }
    micBtn.setAttribute('aria-pressed', String(on));
    if (!on) micBtn.style.removeProperty('--level');
  }

  // Louder voice, bigger halo: -60 dB → 0, -20 dB → 1.
  const showLevel = (db) => micBtn.style.setProperty('--level', String(Math.min(1, Math.max(0, (db + 60) / 40))));

  async function start(auto) {
    if (session || opening) return;
    if (!pickMimeType()) {
      micBtn.classList.add('is-unsupported');
      setStatus(micErrorMessage({ name: 'NotSupportedError' }, auto));
      return;
    }
    opening = true;
    setListening(true);
    setStatus('Listening…', true);
    let handle;
    try {
      handle = await startRecording({ onLevel: showLevel });
    } catch (err) {
      setListening(false);
      setStatus(micErrorMessage(err, auto));
      return;
    } finally {
      opening = false;
    }
    session = { handle, auto };
    if (!handle.metering) setStatus('Listening… tap when you’re done', true);
    if (document.visibilityState === 'hidden') handle.stop('hidden');

    const result = await handle.done;
    session = null;
    setListening(false);
    if (keepRecording(result.reason, result.heard, result.durationMs) && result.blob.size > 0) {
      setStatus('Tap to add another');
      onCapture({
        id: crypto.randomUUID(),
        blob: result.blob,
        mimeType: result.mimeType,
        capturedAt: result.startedAt,
        durationMs: result.durationMs,
        device: DEVICE,
        stop: result.reason,
      });
    } else {
      setStatus(result.reason === 'hidden' ? 'Tap to speak' : 'Didn’t catch that — tap to speak');
    }
  }

  function onTap() {
    if (session) session.handle.stop('tap');
    else start(false);
  }

  micBtn.addEventListener('click', onTap);
  fabBtn.addEventListener('click', onTap);

  // ---------- Start on opening Jot; stop when it goes to the background ----------

  let autoTimer = 0;

  function onForeground() {
    if (!AUTO_LISTEN) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) return; // typing a code
      window.scrollTo(0, 0);
      start(true);
    }, 150);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onForeground();
    else {
      clearTimeout(autoTimer);
      session?.handle.stop('hidden');
    }
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) onForeground();
  });

  setStatus('Tap to speak');
  if (document.visibilityState === 'visible') onForeground();

  return { start, onForeground };
}
