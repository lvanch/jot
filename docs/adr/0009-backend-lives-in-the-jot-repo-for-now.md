# The backend lives in the jot repo until a second app exists

Supabase migrations and functions live in `supabase/` in this repo, next to `app/`, and `api/` is deleted. Jot and the transcribe function will change together for a while, and no other app exists yet. When a second app arrives, `supabase/` and the Inbox's glossary terms move to a repo of their own. That's a cheap move: one directory and a Supabase CLI link.
