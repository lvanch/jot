import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authErrorMessage, looksLikeCode, looksLikeEmail } from '../../app/auth-errors.js';

test('an unknown email is explained, not blamed on the network', () => {
  // What local and hosted GoTrue return when sign-ups are off and the email has no account.
  assert.equal(authErrorMessage({ code: 'otp_disabled', status: 422 }, 'email'), "That email isn't set up for Jot.");
  assert.equal(authErrorMessage({ code: 'signup_disabled', status: 422 }, 'email'), "That email isn't set up for Jot.");
});

test('a wrong or expired code says so', () => {
  assert.match(authErrorMessage({ code: 'otp_expired', status: 403 }, 'code'), /wrong or has expired/);
});

test('rate limits ask for a pause', () => {
  for (const e of [{ code: 'over_email_send_rate_limit', status: 429 }, { code: 'over_request_rate_limit' }, { status: 429 }]) {
    assert.match(authErrorMessage(e, 'email'), /Too many tries/);
  }
});

test('being offline wins over any other reading', () => {
  assert.match(authErrorMessage({ code: 'otp_expired' }, 'code', false), /No connection/);
  assert.match(authErrorMessage({ name: 'AuthRetryableFetchError', status: 0 }, 'email'), /No connection/);
});

test('validation errors depend on the step', () => {
  assert.match(authErrorMessage({ code: 'validation_failed' }, 'email'), /email address/);
  assert.match(authErrorMessage({ code: 'validation_failed' }, 'code'), /code from the email/);
  assert.match(authErrorMessage({ code: 'email_address_invalid' }, 'email'), /email address/);
});

test('server trouble and unknown errors fall back to plain retries', () => {
  assert.match(authErrorMessage({ status: 503 }, 'email'), /isn't answering/);
  assert.equal(authErrorMessage({ code: 'something_new', status: 400 }, 'email'), "Couldn't send a code. Try again.");
  assert.equal(authErrorMessage(undefined, 'code'), "Couldn't sign in. Try again.");
});

test('input checks', () => {
  assert.ok(looksLikeEmail(' owner@jot.local '));
  assert.ok(!looksLikeEmail('owner'));
  assert.ok(!looksLikeEmail('owner@jot'));
  assert.ok(looksLikeCode('123456'));
  assert.ok(looksLikeCode('1234567890'));
  assert.ok(!looksLikeCode('12345'));
  assert.ok(!looksLikeCode('12a456'));
});
