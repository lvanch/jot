-- Table privileges for the API roles (migration 20261126000000). These must hold on a database without Supabase's
-- default privileges, as on a new hosted project; row-level security then picks the rows.
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

select ok(has_schema_privilege('authenticated', 'public', 'usage'), 'authenticated may use the schema');
select ok(has_schema_privilege('service_role', 'public', 'usage'), 'service_role may use the schema');

-- Members read Items, their own members row and (the Owner) the log; they keep the Vocabulary.
select ok(has_table_privilege('authenticated', 'public.items', 'select'), 'members may read Items');
select ok(not has_table_privilege('authenticated', 'public.items', 'insert'), 'but not insert them');
select ok(not has_table_privilege('authenticated', 'public.items', 'update'), 'or update them');
select ok(not has_table_privilege('authenticated', 'public.items', 'delete'), 'or delete them');
select ok(has_table_privilege('authenticated', 'public.members', 'select'), 'members may read members');
select ok(not has_table_privilege('authenticated', 'public.members', 'insert'), 'but not add members');
select ok(has_table_privilege('authenticated', 'public.transcription_log', 'select'), 'members may read the log');
select ok(
  has_table_privilege('authenticated', 'public.vocabulary', 'select')
  and has_table_privilege('authenticated', 'public.vocabulary', 'insert')
  and has_table_privilege('authenticated', 'public.vocabulary', 'delete'),
  'members may read, add and remove Vocabulary terms (RLS: the Owner only)'
);
select ok(not has_table_privilege('authenticated', 'public.vocabulary', 'update'), 'terms are never updated');

-- The service role does the functions' work.
select ok(has_table_privilege('service_role', 'public.members', 'select'), 'service_role reads members (health, transcribe)');
select ok(
  has_table_privilege('service_role', 'public.items', 'select') and has_table_privilege('service_role', 'public.items', 'insert'),
  'service_role reads and parks Items'
);
select ok(
  has_table_privilege('service_role', 'public.transcription_log', 'select')
  and has_table_privilege('service_role', 'public.transcription_log', 'insert'),
  'service_role reads and writes the log'
);
select ok(has_table_privilege('service_role', 'public.vocabulary', 'select'), 'service_role reads the Vocabulary');

-- anon gets nothing.
select ok(not has_table_privilege('anon', 'public.items', 'select'), 'anon can’t read Items');
select ok(not has_table_privilege('anon', 'public.vocabulary', 'select'), 'anon can’t read the Vocabulary');
select ok(not has_table_privilege('anon', 'public.members', 'select'), 'anon can’t read members');

select * from finish();
rollback;
