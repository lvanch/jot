-- Vocabulary rules (spec §3, ADR-0007), as the Owner.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);

select lives_ok($$insert into public.vocabulary (term) values ('  Ngaio  ')$$, 'the Owner adds a term');
select is((select term from public.vocabulary), 'Ngaio', 'terms are trimmed');
select throws_ok($$insert into public.vocabulary (term) values ('NGAIO')$$, '23505', null, 'terms are unique, ignoring case');
select throws_ok($$insert into public.vocabulary (term) values ('   ')$$, '23514', null, 'a blank term is refused');
select throws_ok($$insert into public.vocabulary (term) values (repeat('x', 51))$$, '23514', null, 'terms are at most 50 characters');

select lives_ok($$insert into public.vocabulary (term) select 'term-' || n from generate_series(2, 100) n$$,
  'the Vocabulary fills to 100 terms');
select throws_ok($$insert into public.vocabulary (term) values ('one too many')$$, 'P0001', 'vocabulary_full',
  'the 101st term is refused');
select lives_ok($$delete from public.vocabulary where term = 'term-2'$$, 'the Owner deletes a term');
select is((select count(*)::int from public.vocabulary), 99, 'deleting frees a slot');

reset role;
select * from finish();
rollback;
