-- One-time import of the Jot v1 list (spec §7), as the Owner.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);

create temporary table v1 (rows jsonb) on commit drop;
insert into v1 values ($$[
  {"id": "v1-open", "text": "  Buy milk ", "created_at": 1761400000000, "status": "inbox", "status_at": null},
  {"id": "v1-done", "text": "Renew passport", "created_at": 1761400000000, "status": "processed", "status_at": 1761500000000},
  {"id": "v1-done-no-time", "text": "Call the bank", "created_at": 1761400000000, "status": "processed"},
  {"id": "bad id!", "text": "x", "created_at": 1, "status": "inbox"},
  {"id": "v1-blank", "text": "   ", "created_at": 1, "status": "inbox"},
  {"id": "v1-string-time", "text": "x", "created_at": "yesterday", "status": "inbox"},
  {"id": "v1-huge-time", "text": "x", "created_at": 1e20, "status": "inbox"},
  {"id": "v1-deleted", "text": "x", "created_at": 1, "status": "deleted"},
  "not an object",
  {"id": "v1-open", "text": "same id again", "created_at": 1, "status": "inbox"}
]$$);

select is(public.import_v1_items((select rows from v1)), '{"inserted": 3, "skipped": 7}'::jsonb,
  'valid rows are imported and the rest skipped');

select results_eq(
  $$select status, text, transcript, source, processed_by from public.items where id = 'v1-open'$$,
  $$values ('inbox', 'Buy milk', 'Buy milk', 'jot-v1', null::text)$$,
  'an open v1 task becomes an Item in the Inbox');
select is((select captured_at from public.items where id = 'v1-open'), to_timestamp(1761400000),
  'captured_at keeps the v1 creation time');
select is((select status_at from public.items where id = 'v1-open'), now(), 'an imported open Item enters the Inbox now');

select results_eq(
  $$select status, processed_by, status_at from public.items where id = 'v1-done'$$,
  $$values ('processed', 'jot-v1', to_timestamp(1761500000))$$,
  'a done v1 task becomes processed by jot-v1 at its done time');
select is((select status_at from public.items where id = 'v1-done-no-time'), to_timestamp(1761400000),
  'a done task without a done time uses its creation time');

select is(public.import_v1_items((select rows from v1)), '{"inserted": 0, "skipped": 10}'::jsonb,
  'importing again changes nothing');
select is((select count(*)::int from public.items where source = 'jot-v1'), 3, 'no duplicates after a repeat');
select is(public.import_v1_items('[]'), '{"inserted": 0, "skipped": 0}'::jsonb, 'an empty list imports nothing');

select throws_ok($$select public.import_v1_items('{"id": "x"}')$$, '22023', 'invalid_rows', 'rows must be an array');
select throws_ok($$select public.import_v1_items((select jsonb_agg(jsonb_build_object('id', 'r' || n)) from generate_series(1, 5001) n))$$,
  '22023', 'invalid_rows', 'at most 5000 rows per call');

-- Imported Items behave like any other.
select is((public.discard_item('v1-open')).status, 'discarded', 'an imported Item follows the normal lifecycle');

reset role;
select * from finish();
rollback;
