-- Item lifecycle and access per role (spec §3 RLS, §4). Relies on seed.sql: owner (…0a) and the processor claude (…0b).
begin;
create extension if not exists pgtap with schema extensions;
select plan(52);

-- Fixtures, as postgres. Items start a day old so a transition visibly moves status_at to now().
insert into auth.users (id, email) values ('00000000-0000-4000-8000-00000000000c', 'stranger@jot.local');
insert into public.items (id, transcript, text, captured_at, parked_at, status_at, source) values
  ('t-1', 'first',  'first',  now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'jot'),
  ('t-2', 'second', 'second', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'jot'),
  ('t-3', 'third',  'third',  now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'jot'),
  ('t-4', 'fourth', 'fourth', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'jot');
insert into public.vocabulary (term) values ('Fremantle');
insert into public.transcription_log (item_id, duration_ms, outcome) values ('t-1', 4000, 'parked');

-- ---------- anon: nothing ----------
set local role anon;
select throws_ok($$select * from public.items$$, '42501', null, 'anon cannot read Items');
select throws_ok($$select * from public.vocabulary$$, '42501', null, 'anon cannot read the Vocabulary');
select throws_ok($$select public.process_item('t-1')$$, '42501', null, 'anon cannot call process_item');
select throws_ok($$select public.import_v1_items('[]')$$, '42501', null, 'anon cannot call import_v1_items');
reset role;

-- ---------- signed in, but not a member ----------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select is((select count(*)::int from public.items), 0, 'a non-member sees no Items');
select is((select count(*)::int from public.members), 0, 'a non-member sees no members');
select throws_ok($$select public.process_item('t-1')$$, '42501', 'not_allowed', 'a non-member cannot process');
select throws_ok($$select public.discard_item('t-1')$$, '42501', 'not_allowed', 'a non-member cannot discard');
reset role;

-- ---------- processor (claude) ----------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select is((select count(*)::int from public.items), 4, 'a processor reads every Item');
select is((select name from public.members), 'claude', 'a processor sees only its own member row');

select is((public.process_item('t-1', '{"to":"calendar"}')).status, 'processed', 'a processor processes an Item');
select is((select processed_by from public.items where id = 't-1'), 'claude', 'processed_by is the processor''s name');
select is((select status_at from public.items where id = 't-1'), now(), 'processing moves status_at');
select is((public.process_item('t-1')).outcome, '{"to":"calendar"}'::jsonb,
  'processing again by the same processor returns the Item unchanged');

select throws_ok($$select public.process_item('nope')$$, 'P0002', 'not_found', 'processing a missing Item is not_found');
select throws_ok($$select public.discard_item('t-2')$$, '42501', 'not_allowed', 'a processor cannot discard');
select throws_ok($$select public.restore_item('t-2')$$, '42501', 'not_allowed', 'a processor cannot restore');
select throws_ok($$select public.edit_item_text('t-2', 'x')$$, '42501', 'not_allowed', 'a processor cannot edit Text');
select throws_ok($$select public.import_v1_items('[]')$$, '42501', 'not_allowed', 'a processor cannot import');

select throws_ok($$update public.items set text = 'x' where id = 't-2'$$, '42501', null, 'a processor cannot update Items directly');
select throws_ok($$insert into public.items (id, transcript, text, captured_at, source) values ('t-9', 'x', 'x', now(), 'jot')$$,
  '42501', null, 'a processor cannot insert Items');
select throws_ok($$delete from public.items where id = 't-2'$$, '42501', null, 'a processor cannot delete Items');

select is((select count(*)::int from public.vocabulary), 0, 'a processor cannot read the Vocabulary');
select throws_ok($$insert into public.vocabulary (term) values ('Ngaio')$$, '42501', null, 'a processor cannot add to the Vocabulary');
select is((select count(*)::int from public.transcription_log), 0, 'a processor cannot read the transcription log');
reset role;

-- ---------- owner ----------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select is((select count(*)::int from public.items), 4, 'the Owner reads every Item');
select is((select name from public.members), 'owner', 'the Owner sees only its own member row');
select is((select count(*)::int from public.vocabulary), 1, 'the Owner reads the Vocabulary');
select is((select count(*)::int from public.transcription_log), 1, 'the Owner reads the transcription log');

select throws_ok($$select public.process_item('t-1')$$, 'P0001', 'wrong_state',
  'processing an Item someone else processed is wrong_state');

-- discard / restore
select is((public.discard_item('t-2')).status, 'discarded', 'the Owner discards an Item');
select is((select status_at from public.items where id = 't-2'), now(), 'discarding moves status_at');
select is((public.discard_item('t-2')).status, 'discarded', 'discarding again returns it unchanged');
select throws_ok($$select public.process_item('t-2')$$, 'P0001', 'wrong_state', 'a discarded Item cannot be processed');
select throws_ok($$select public.edit_item_text('t-2', 'x')$$, 'P0001', 'wrong_state', 'a discarded Item cannot be edited');
select is((public.restore_item('t-2')).status, 'inbox', 'the Owner restores a discarded Item');
select is((public.restore_item('t-2')).status, 'inbox', 'restoring an Item already in the Inbox returns it unchanged');

-- edit Text
select is((public.edit_item_text('t-2', '  Fixed text  ')).text, 'Fixed text', 'editing trims and saves the Text');
select is((select transcript from public.items where id = 't-2'), 'second', 'editing leaves the Transcript alone');
select throws_ok($$select public.edit_item_text('t-2', '   ')$$, '22023', 'invalid_text', 'blank Text is invalid_text');
select throws_ok($$select public.edit_item_text('t-2', repeat('x', 2001))$$, '22023', 'invalid_text',
  'Text over 2000 characters is invalid_text');
select throws_ok($$select public.edit_item_text('t-1', 'x')$$, 'P0001', 'wrong_state', 'a processed Item cannot be edited');
select throws_ok($$select public.edit_item_text('nope', 'x')$$, 'P0002', 'not_found', 'editing a missing Item is not_found');
select throws_ok($$select public.discard_item('nope')$$, 'P0002', 'not_found', 'discarding a missing Item is not_found');

-- the Owner processes too
select is((public.process_item('t-3', '"done by hand"')).processed_by, 'owner', 'the Owner can process an Item');
select throws_ok($$select public.discard_item('t-3')$$, 'P0001', 'wrong_state', 'a processed Item cannot be discarded');
select throws_ok($$select public.restore_item('t-3')$$, 'P0001', 'wrong_state', 'a processed Item cannot be restored');
select is((public.restore_item('t-4')).status, 'inbox', 'restoring an Item in the Inbox is a no-op');

-- the Owner still can't bypass the functions
select throws_ok($$update public.items set status = 'discarded' where id = 't-4'$$, '42501', null,
  'the Owner cannot update Items directly');
select throws_ok($$insert into public.transcription_log (outcome) values ('parked')$$, '42501', null,
  'the Owner cannot write the transcription log');
select throws_ok($$update public.vocabulary set term = 'x'$$, '42501', null, 'Vocabulary terms are added or deleted, not updated');
reset role;

-- ---------- after everything ----------
select results_eq(
  $$select id, status, processed_by from public.items order by id$$,
  $$values ('t-1', 'processed', 'claude'), ('t-2', 'inbox', null), ('t-3', 'processed', 'owner'), ('t-4', 'inbox', null)$$,
  'final states are as expected');

select * from finish();
rollback;
