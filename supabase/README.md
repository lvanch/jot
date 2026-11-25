# Inbox backend (Supabase)

This is the Inbox's database and its Edge Functions. Design: [`docs/spec/jot-v2.md`](../docs/spec/jot-v2.md) §3–§5. Vocabulary: [`CONTEXT.md`](../CONTEXT.md). Apps and agents that read the Inbox: [`docs/inbox-contract.md`](../docs/inbox-contract.md).

- **Migrations:** `migrations/`. Tables, row-level security, the lifecycle functions, the `recordings` bucket and Realtime. A later migration makes `not_found` an HTTP 404 (SQLSTATE `PT404`).
- **Seed:** `seed.sql`. **Local only:** an Owner (`owner@jot.local`) and a processor agent (`claude@jot.local`, password `local-claude-password`).
- **Functions:** `functions/`.
  - `transcribe` turns a Recording into a parked Item.
  - `health` is the keep-alive target.
  - `_shared/transcriber/` is the Transcriber seam (ElevenLabs, plus a fake for tests).
- **Tests:**
  - `tests/database/`: pgTAP, one file per area.
  - `tests/functions/`: Deno integration tests for the functions.
  - The functions' unit tests sit next to their code (`*_test.ts`).

## Local development

You need Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started).

```bash
supabase start
```

```bash
supabase db reset
```

```bash
supabase test db
```

- `supabase start` runs the local stack. The database is at `postgresql://postgres:postgres@127.0.0.1:54322/postgres`, and Mailpit, which shows sign-in codes, is at <http://127.0.0.1:54324>.
- `supabase db reset` re-applies the migrations, then the seed.
- `supabase test db` runs the pgTAP suites.

If your network blocks Docker Hub and ECR but allows GitHub's registry, prefix the commands with `SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io`.

### Functions

You also need [Deno](https://deno.com) 2.

Unit tests (no stack needed):

```bash
(cd supabase/functions && deno test _shared/ transcribe/)
```

Integration tests run against the local stack, with the fake Transcriber (`tests/functions/test.env`). Start the stack and serve the functions:

```bash
supabase functions serve --env-file supabase/tests/functions/test.env
```

Then, in another terminal:

```bash
set -a; eval "$(supabase status -o env)"; set +a
```

```bash
deno test --allow-net --allow-env --config supabase/functions/transcribe/deno.json supabase/tests/functions/
```

If the edge-runtime container can't fetch npm packages (for example behind an egress proxy), serve the functions on the host instead, then run the tests with `FUNCTIONS_URL=http://127.0.0.1:8787`. The command is in the header of `tests/functions/serve_local.ts`. That skips the platform's `verify_jwt` check, but the functions' own auth still runs.

`tests/functions/cors_test.ts` only runs against the functions served on the host. Through the local gateway it's reported as ignored, because Kong's cors plugin answers every preflight itself with `*`. The hosted platform passes preflights to the function, so the function's own CORS is what browsers get in production. CI runs it both ways.

A live check of the real Transcriber: `supabase/functions/_shared/transcriber/try.ts` (instructions in its header).

## Rules worth knowing before you change anything

- Nobody writes `items` directly. Clients change an Item only through `process_item`, `discard_item`, `restore_item` and `edit_item_text`. `transcribe` parks Items with the service role. New behaviour goes into a function, never into a policy that grants `update`.
- Grant table privileges explicitly in the migration that creates a table. A new hosted project doesn't grant new tables to `authenticated` or `service_role` the way the local stack does. CI starts the stack without those defaults (`ci/no_default_grants.sql`), so a missing grant fails the tests.
- A function's error message is a stable code (`not_allowed`, `not_found`, `wrong_state`, `invalid_text`). Clients match on it, so don't reword it.
- Migrations are append-only once they've reached `v2` or `main`. Change things with a new migration.
- Never log audio, Transcript text, tokens or keys from a function. Log error names and codes only.
- The fake Transcriber refuses to load without `ALLOW_FAKE_TRANSCRIBER=1`. Never set that on the hosted project.
