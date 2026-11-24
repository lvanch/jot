// What to say when the mic can't start. Pure, so it's unit-tested. The wording is carried over from v1.

/**
 * @param {{ name?: string } | null | undefined} err from getUserMedia or MediaRecorder
 * @param {boolean} auto the Capture started by itself (on opening Jot), not from a tap
 */
export function micErrorMessage(err, auto) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      // An automatic start can be refused before the person has done anything; a tap usually fixes it.
      return auto ? 'Tap the mic to start' : 'Microphone blocked — allow it in site settings';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone available — tap to retry';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is busy — tap to retry';
    case 'NotSupportedError':
      return 'Recording isn’t available in this browser';
    default:
      return 'Tap to speak';
  }
}
