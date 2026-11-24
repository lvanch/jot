// The one Supabase client Jot uses. supabase-js is vendored as a classic script (vendor/supabase.js), which
// defines window.supabase before any module runs.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

/** False until config.js holds the real project's values. */
export const configured = !SUPABASE_URL.includes('YOUR-PROJECT-REF') && !SUPABASE_PUBLISHABLE_KEY.includes('REPLACE_ME');

export function createInbox() {
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      storageKey: 'jot.auth.v2', // never collides with v1's jot.* keys, which the v1 import still needs
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false, // sign-in is by typed code, never by link
    },
  });
}
