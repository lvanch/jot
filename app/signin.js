// The sign-in card: email → emailed code → session (ADR-0005, spec §6 "Sign-in").
// Sign-ups are off, so only the Owner's email gets a code.

import { authErrorMessage, looksLikeCode, looksLikeEmail } from './auth-errors.js';
import { $ } from './ui.js';

const EMAIL_KEY = 'jot.email.v2'; // remembered so the next sign-in is one tap shorter

const card = $('signin');
const emailForm = $('email-form');
const codeForm = $('code-form');
const emailInput = $('email');
const codeInput = $('code');
const codeEmail = $('code-email');
const errorEl = $('signin-error');

let email = '';

function readEmail() {
  try {
    return localStorage.getItem(EMAIL_KEY) || '';
  } catch {
    return '';
  }
}

function rememberEmail(value) {
  try {
    localStorage.setItem(EMAIL_KEY, value);
  } catch {
    // private mode: fine, just not remembered
  }
}

function showError(text) {
  errorEl.textContent = text;
}

function busy(form, on) {
  for (const el of form.elements) el.disabled = on;
  form.setAttribute('aria-busy', String(on));
}

function showEmailStep() {
  codeForm.hidden = true;
  emailForm.hidden = false;
  emailInput.value = email || readEmail();
}

function showCodeStep() {
  emailForm.hidden = true;
  codeForm.hidden = false;
  codeEmail.textContent = email;
  codeInput.value = '';
  codeInput.focus();
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} inbox
 * @param {{ disabledReason?: string }} options
 */
export function initSignIn(inbox, { disabledReason } = {}) {
  async function sendCode() {
    if (disabledReason) return showError(disabledReason);
    showError('');
    if (!looksLikeEmail(emailInput.value)) {
      showError("That doesn't look like an email address.");
      return;
    }
    email = emailInput.value.trim().toLowerCase();
    busy(emailForm, true);
    busy(codeForm, true);
    const { error } = await inbox.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    busy(emailForm, false);
    busy(codeForm, false);
    if (error) {
      showError(authErrorMessage(error, 'email', navigator.onLine));
      showEmailStep();
      return;
    }
    rememberEmail(email);
    showCodeStep();
  }

  emailForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendCode();
  });

  codeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const token = codeInput.value.replace(/\s+/g, '');
    if (!looksLikeCode(token)) {
      showError('Enter the code from the email.');
      return;
    }
    busy(codeForm, true);
    const { error } = await inbox.auth.verifyOtp({ email, token, type: 'email' });
    busy(codeForm, false);
    if (error) {
      showError(authErrorMessage(error, 'code', navigator.onLine));
      codeInput.select();
    }
    // On success, onAuthStateChange in main.js hides the card.
  });

  $('resend').addEventListener('click', () => {
    emailInput.value = email;
    sendCode();
  });

  $('change-email').addEventListener('click', () => {
    showError('');
    showEmailStep();
    emailInput.focus();
  });

  if (disabledReason) showError(disabledReason);
  showEmailStep();
}

export function showSignIn(on) {
  card.hidden = !on;
  if (!on) {
    showError('');
    codeInput.value = '';
    showEmailStep();
  }
}
