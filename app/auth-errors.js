// Turns a Supabase Auth error into a sentence for the sign-in screen. Pure, so it's unit-tested
// (test/unit/auth-errors.test.mjs).

/**
 * @param {{ code?: string, status?: number, name?: string } | null | undefined} error
 * @param {'email' | 'code'} step which form the error came from
 * @param {boolean} online navigator.onLine
 */
export function authErrorMessage(error, step, online = true) {
  if (!online || error?.name === 'AuthRetryableFetchError' || error?.status === 0) {
    return "No connection. Check you're online, then try again.";
  }
  switch (error?.code) {
    case 'otp_disabled': // sign-ups are off, so an unknown email lands here
    case 'signup_disabled':
    case 'user_not_found':
      return "That email isn't set up for Jot.";
    case 'otp_expired':
      return 'That code is wrong or has expired. Check it, or send a new one.';
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return 'Too many tries. Wait a minute, then try again.';
    case 'email_address_invalid':
      return "That doesn't look like an email address.";
    case 'validation_failed':
      return step === 'email' ? "That doesn't look like an email address." : 'Enter the code from the email.';
  }
  if (error?.status === 429) return 'Too many tries. Wait a minute, then try again.';
  if (error?.status >= 500) return "The Inbox isn't answering. Try again in a minute.";
  return step === 'email' ? "Couldn't send a code. Try again." : "Couldn't sign in. Try again.";
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^\d{6,10}$/;

export const looksLikeEmail = (s) => EMAIL.test(String(s).trim());
export const looksLikeCode = (s) => CODE.test(String(s).trim());
