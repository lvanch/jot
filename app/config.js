// Where Jot's Inbox lives. Neither value is a secret: the publishable key is meant for browsers, and row-level
// security is what protects the data (ADR-0005).
//
// Set both once the Supabase project exists (owner setup, #2): Dashboard → Project Settings → API Keys.
// The project host must also be in the CSP's connect-src (index.html, #6).

export const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_REPLACE_ME';
