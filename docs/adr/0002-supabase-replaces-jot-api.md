# Supabase replaces jot-api as the shared home

The repo already had `jot-api`, a Cloudflare Worker on D1 with per-device keys and two-way sync to Jot. We are replacing it with Supabase (Postgres, Auth, Storage and Edge Functions) as the one home for Jot, the Inbox and future Processors. Future apps then get a real database, sign-in and file storage without us building and maintaining a bespoke API for each need. `jot-api` and Jot's sync layer will be retired.

## Considered options

- **Keep Cloudflare** (add `/transcribe` and an Inbox to `jot-api`). This was the least work, and free D1 never pauses. Rejected because every future capability (auth, files, queries) would be hand-built in the Worker.
- **Both** (Cloudflare for Jot, Supabase for the Inbox). Rejected: two homes for one person's data.

## Consequences

- Free Supabase projects pause after 7 days without activity, which would silently break Capture. A scheduled keep-alive is required (ADR-0012).
- Jot's CSP must allow the Supabase project's host instead of `*.workers.dev`. It moves to a meta tag (ADR-0013).
- The roughly 300 lines of outbox/sync code in `app/app.js`, plus `api/` and its tests, go away.
- `jot-api` was never deployed, so there's no server data to move. `api/` is simply deleted.
