# Inbox backend (Supabase)

This is the Inbox's database, and later its Edge Functions. Design: [`docs/spec/jot-v2.md`](../docs/spec/jot-v2.md) §3–§5. Vocabulary: [`CONTEXT.md`](../CONTEXT.md).

- **Migrations:** `migrations/`. Tables, row-level security, the lifecycle functions, the `recordings` bucket and Realtime.
- **Seed:** `seed.sql`. **Local only:** an Owner (`owner@jot.local`) and a processor agent (`claude@jot.local`, password `local-claude-password`).
- **Tests:** `tests/database/`. pgTAP, one file per area.

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

## Rules worth knowing before you change anything

- Nobody writes `items` directly. Clients change an Item only through `process_item`, `discard_item`, `restore_item` and `edit_item_text`. `transcribe` parks Items with the service role. New behaviour goes into a function, never into a policy that grants `update`.
- A function's error message is a stable code (`not_allowed`, `not_found`, `wrong_state`, `invalid_text`). Clients match on it, so don't reword it.
- Migrations are append-only once they've reached `v2` or `main`. Change things with a new migration.
