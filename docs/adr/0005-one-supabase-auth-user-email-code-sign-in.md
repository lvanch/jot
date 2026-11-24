# One Supabase Auth user, devices sign in with an emailed code

All data belongs to one Supabase Auth user (you), and public sign-ups are switched off. Each device signs in once by typing a 6-digit code that's emailed to you, then stays signed in. Row-level security lets only that user read or write, plus the agent members added by ADR-0011. We chose this over `jot-api`'s per-device secret keys because future apps can then use Supabase directly, rather than going through functions we'd have to write. A code beats a magic link because a link opens in Chrome, not in the installed app.

## Consequences

- The Supabase publishable key ships in Jot's source. It isn't a secret: row-level security is what protects the data.
- Jot vendors Supabase's JS client, because its CSP allows only same-origin scripts.
- A lost device means signing out all sessions, then signing the other devices back in.
- Headless agents get identities of their own (ADR-0011). Nothing ever uses the service-role key except server functions.
