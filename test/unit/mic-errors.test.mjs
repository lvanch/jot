import { test } from 'node:test';
import assert from 'node:assert/strict';
import { micErrorMessage } from '../../app/mic-errors.js';

test('a refused mic: a tap fixes an automatic start; a refused tap needs site settings', () => {
  assert.equal(micErrorMessage({ name: 'NotAllowedError' }, true), 'Tap the mic to start');
  assert.equal(micErrorMessage({ name: 'NotAllowedError' }, false), 'Microphone blocked — allow it in site settings');
  assert.equal(micErrorMessage({ name: 'SecurityError' }, false), 'Microphone blocked — allow it in site settings');
});

test('missing, busy and unsupported mics', () => {
  assert.equal(micErrorMessage({ name: 'NotFoundError' }, false), 'No microphone available — tap to retry');
  assert.equal(micErrorMessage({ name: 'NotReadableError' }, false), 'The microphone is busy — tap to retry');
  assert.equal(micErrorMessage({ name: 'NotSupportedError' }, true), 'Recording isn’t available in this browser');
  assert.equal(micErrorMessage(new Error('?'), false), 'Tap to speak');
  assert.equal(micErrorMessage(undefined, false), 'Tap to speak');
});
