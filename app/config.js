// Where Jot's Inbox lives. Neither value is a secret: the publishable key is meant for browsers, and row-level
// security is what protects the data (ADR-0005).
//
// Set both once the Supabase project exists (owner setup, #2): Dashboard → Project Settings → API Keys.
// The project host lives in one other place: the CSP meta tag's connect-src in index.html, as https:// and wss://.
// Change both together; test/unit/csp.test.mjs fails if they differ, and the Pages deploy refuses the placeholder.

export const SUPABASE_URL = 'https://hidnrdanbmfiflzvsyif.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_kzfA2N_-ot-RObxZ6dImhg_wpk-KXOr';

// Optional: where the Edge Functions live, if not at SUPABASE_URL/functions/v1. Only local test setups need it.
export const FUNCTIONS_URL = '';
