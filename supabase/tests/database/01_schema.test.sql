-- Schema shape and table-level guards (spec §3). Runs as postgres.
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

select has_table('public', 'members', 'members exists');
select has_table('public', 'items', 'items exists');
select has_table('public', 'vocabulary', 'vocabulary exists');
select has_table('public', 'transcription_log', 'transcription_log exists');

select is(
  (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.members'::regclass, 'public.items'::regclass,
                  'public.vocabulary'::regclass, 'public.transcription_log'::regclass)),
  true, 'RLS is on for every Inbox table');

select is((select public from storage.buckets where id = 'recordings'), false, 'recordings bucket exists and is private');
select is((select file_size_limit from storage.buckets where id = 'recordings'), 1048576::bigint,
  'recordings bucket caps files at 1 MB');

select ok(exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'items'),
  'items is published for Realtime');

insert into public.items (id, transcript, text, captured_at, source)
values ('s-1', 'heard this', 'heard this', now(), 'jot');

select throws_ok($$update public.items set transcript = 'rewritten' where id = 's-1'$$,
  'P0001', 'transcript_immutable', 'the Transcript never changes, even for postgres');
select throws_ok($$update public.items set captured_at = now() - interval '1 day' where id = 's-1'$$,
  'P0001', 'transcript_immutable', 'captured_at never changes');
select throws_ok($$update public.items set status = 'processed' where id = 's-1'$$,
  '23514', null, 'a processed Item must say who processed it');
select throws_ok($$insert into public.items (id, transcript, text, captured_at, source) values ('bad id!', 'x', 'x', now(), 'jot')$$,
  '23514', null, 'ids are limited to A-Z a-z 0-9 _ -');
select throws_ok($$insert into public.items (id, transcript, text, captured_at, source) values ('s-2', ' ', '   ', now(), 'jot')$$,
  '23514', null, 'Text cannot be blank');
select throws_ok($$insert into public.items (id, transcript, text, captured_at, source) values ('s-3', 'x', repeat('x', 2001), now(), 'jot')$$,
  '23514', null, 'Text is at most 2000 characters');
select throws_ok($$insert into public.items (id, transcript, text, captured_at, source) values ('s-4', 'x', 'x', now(), 'email')$$,
  '23514', null, 'source is jot or jot-v1');

insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000f1', 'second-owner@jot.local');
select throws_ok($$insert into public.members (user_id, role, name) values ('00000000-0000-4000-8000-0000000000f1', 'owner', 'other')$$,
  '23505', null, 'there is at most one Owner');
select throws_ok($$insert into public.members (user_id, role, name) values ('00000000-0000-4000-8000-0000000000f1', 'processor', 'jot-v1')$$,
  '23514', null, 'jot-v1 is reserved as a member name');
select throws_ok($$insert into public.members (user_id, role, name) values ('00000000-0000-4000-8000-0000000000f1', 'processor', 'claude')$$,
  '23505', null, 'member names are unique');
select lives_ok($$insert into public.members (user_id, role, name) values ('00000000-0000-4000-8000-0000000000f1', 'processor', 'triage-bot')$$,
  'a second processor can be added');

select * from finish();
rollback;
