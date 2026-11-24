-- The Inbox: members, Items, Vocabulary, transcription log, Recordings bucket, and the lifecycle functions.
-- Spec: docs/spec/jot-v2.md §3–§4. Decisions: ADRs 0005, 0006, 0007, 0010, 0011. Terms: CONTEXT.md.
--
-- Error contract for every function here: the exception message is a stable code, and the SQLSTATE picks the
-- REST status.
--   not_allowed  42501 → 403
--   not_found    P0002 → 404
--   wrong_state  P0001 → 400
--   invalid_text 22023 → 400

-- ---------- Members: the Owner and agent Processors ----------

create table public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'processor')),
  -- Shown as processed_by. 'jot-v1' is reserved for Items imported from Jot v1.
  name text not null unique check (name ~ '^[a-z0-9][a-z0-9_-]{0,31}$' and name <> 'jot-v1'),
  created_at timestamptz not null default now()
);

-- At most one Owner.
create unique index members_one_owner on public.members ((true)) where role = 'owner';

create function public.is_member() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.members m where m.user_id = auth.uid());
$$;

create function public.is_owner() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.members m where m.user_id = auth.uid() and m.role = 'owner');
$$;

create function public.member_name() returns text
language sql stable security definer set search_path = ''
as $$
  select m.name from public.members m where m.user_id = auth.uid();
$$;

-- ---------- Items ----------

create table public.items (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  transcript text not null check (char_length(transcript) <= 10000),
  text text not null check (char_length(text) between 1 and 2000 and text ~ '\S'),
  captured_at timestamptz not null,
  parked_at timestamptz not null default now(),
  status text not null default 'inbox' check (status in ('inbox', 'processed', 'discarded')),
  status_at timestamptz not null default now(),
  processed_by text,
  outcome jsonb check (outcome is null or octet_length(outcome::text) <= 16384),
  source text not null check (source in ('jot', 'jot-v1')),
  device text check (char_length(device) <= 64),
  transcriber text check (char_length(transcriber) <= 100),
  language text check (char_length(language) <= 16),
  duration_ms integer check (duration_ms >= 0),
  recording_path text check (char_length(recording_path) <= 200),
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object' and octet_length(meta::text) <= 16384),
  constraint items_processed_has_processor check (status <> 'processed' or processed_by is not null)
);

create index items_status_parked_at on public.items (status, parked_at);

-- What was heard, when and where never changes after parking (ADR-0006).
create function public.items_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.transcript is distinct from old.transcript
     or new.captured_at is distinct from old.captured_at
     or new.parked_at is distinct from old.parked_at
     or new.source is distinct from old.source then
    raise exception 'transcript_immutable' using errcode = 'P0001',
      detail = 'id, transcript, captured_at, parked_at and source never change';
  end if;
  return new;
end;
$$;

create trigger items_guard before update on public.items
for each row execute function public.items_guard();

-- ---------- Vocabulary ----------

create table public.vocabulary (
  id bigint generated always as identity primary key,
  term text not null check (char_length(term) between 1 and 50),
  created_at timestamptz not null default now()
);

create unique index vocabulary_term_ci on public.vocabulary (lower(term));

-- Trims each term and caps the list at 100 (ADR-0007).
create function public.vocabulary_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.term := btrim(new.term);
  -- Serialise inserts so two at once can't both squeeze in at 99.
  perform pg_advisory_xact_lock(hashtext('public.vocabulary cap'));
  if (select count(*) from public.vocabulary) >= 100 then
    raise exception 'vocabulary_full' using errcode = 'P0001', detail = 'the Vocabulary holds at most 100 terms';
  end if;
  return new;
end;
$$;

create trigger vocabulary_guard before insert on public.vocabulary
for each row execute function public.vocabulary_guard();

-- ---------- Transcription log: one row per Transcriber call (daily cap, cost) ----------

create table public.transcription_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  item_id text,
  duration_ms integer,
  outcome text not null check (outcome in ('parked', 'empty', 'refused', 'unavailable'))
);

create index transcription_log_at on public.transcription_log (at);

-- ---------- Row-level security and grants ----------
-- Nobody writes Items, the log or members directly: Items change only through the functions below, and
-- parking, logging and membership go through the service role. RLS denies anything without a policy;
-- the revokes are a second lock.

alter table public.members enable row level security;
alter table public.items enable row level security;
alter table public.vocabulary enable row level security;
alter table public.transcription_log enable row level security;

revoke all on public.members, public.items, public.vocabulary, public.transcription_log from anon;
revoke insert, update, delete, truncate on public.members, public.items, public.transcription_log from authenticated;
revoke update, truncate on public.vocabulary from authenticated;

create policy members_select_own on public.members
  for select to authenticated using (user_id = (select auth.uid()));

create policy items_select_members on public.items
  for select to authenticated using ((select public.is_member()));

create policy vocabulary_select_owner on public.vocabulary
  for select to authenticated using ((select public.is_owner()));
create policy vocabulary_insert_owner on public.vocabulary
  for insert to authenticated with check ((select public.is_owner()));
create policy vocabulary_delete_owner on public.vocabulary
  for delete to authenticated using ((select public.is_owner()));

create policy transcription_log_select_owner on public.transcription_log
  for select to authenticated using ((select public.is_owner()));

-- ---------- Lifecycle functions (spec §4) ----------
-- Each checks the caller's role, locks the Item, and returns it. Repeating a call whose target state already
-- holds returns the Item unchanged.

create function public.process_item(item_id text, outcome jsonb default null) returns public.items
language plpgsql security definer set search_path = ''
as $$
declare
  me text := public.member_name();
  it public.items;
begin
  if me is null then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  select * into it from public.items i where i.id = process_item.item_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if it.status = 'processed' and it.processed_by = me then
    return it;
  end if;
  if it.status <> 'inbox' then
    raise exception 'wrong_state' using errcode = 'P0001', detail = 'item is ' || it.status;
  end if;
  update public.items i
     set status = 'processed', status_at = now(), processed_by = me, outcome = process_item.outcome
   where i.id = process_item.item_id
  returning * into it;
  return it;
end;
$$;

create function public.discard_item(item_id text) returns public.items
language plpgsql security definer set search_path = ''
as $$
declare
  it public.items;
begin
  if not public.is_owner() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  select * into it from public.items i where i.id = discard_item.item_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if it.status = 'discarded' then
    return it;
  end if;
  if it.status <> 'inbox' then
    raise exception 'wrong_state' using errcode = 'P0001', detail = 'item is ' || it.status;
  end if;
  update public.items i set status = 'discarded', status_at = now()
   where i.id = discard_item.item_id
  returning * into it;
  return it;
end;
$$;

create function public.restore_item(item_id text) returns public.items
language plpgsql security definer set search_path = ''
as $$
declare
  it public.items;
begin
  if not public.is_owner() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  select * into it from public.items i where i.id = restore_item.item_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if it.status = 'inbox' then
    return it;
  end if;
  if it.status <> 'discarded' then
    raise exception 'wrong_state' using errcode = 'P0001', detail = 'item is ' || it.status;
  end if;
  update public.items i set status = 'inbox', status_at = now()
   where i.id = restore_item.item_id
  returning * into it;
  return it;
end;
$$;

create function public.edit_item_text(item_id text, new_text text) returns public.items
language plpgsql security definer set search_path = ''
as $$
declare
  it public.items;
  t text := btrim(coalesce(new_text, ''));
begin
  if not public.is_owner() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if t !~ '\S' or char_length(t) > 2000 then
    raise exception 'invalid_text' using errcode = '22023', detail = 'text must be 1-2000 characters, not blank';
  end if;
  select * into it from public.items i where i.id = edit_item_text.item_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if it.status <> 'inbox' then
    raise exception 'wrong_state' using errcode = 'P0001', detail = 'item is ' || it.status;
  end if;
  if it.text = t then
    return it;
  end if;
  update public.items i set text = t
   where i.id = edit_item_text.item_id
  returning * into it;
  return it;
end;
$$;

-- One-time import of the Jot v1 list (spec §7). rows is a JSON array of
--   { "id": text, "text": text, "created_at": ms, "status": "inbox" | "processed", "status_at": ms | null }
-- with times as milliseconds since the epoch, as v1 stored them. Invalid rows and ids that already exist are
-- skipped, so running it twice is safe. Returns { "inserted": n, "skipped": n }.
create function public.import_v1_items(rows jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r jsonb;
  t text;
  created timestamptz;
  done_at timestamptz;
  n_inserted integer := 0;
  n_skipped integer := 0;
begin
  if not public.is_owner() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(rows) is distinct from 'array' then
    raise exception 'invalid_rows' using errcode = '22023', detail = 'rows must be a JSON array';
  end if;
  if jsonb_array_length(rows) > 5000 then
    raise exception 'invalid_rows' using errcode = '22023', detail = 'at most 5000 rows';
  end if;

  for r in select value from jsonb_array_elements(rows) loop
    -- Checked one step at a time: SQL doesn't promise to evaluate OR left to right, and a cast must never
    -- see a non-number.
    if jsonb_typeof(r) <> 'object' then
      n_skipped := n_skipped + 1;
      continue;
    end if;
    t := btrim(coalesce(r ->> 'text', ''));
    if coalesce(r ->> 'id', '') !~ '^[A-Za-z0-9_-]{1,64}$'
       or t !~ '\S' or char_length(t) > 2000
       or coalesce(r ->> 'status', '') not in ('inbox', 'processed')
       or jsonb_typeof(r -> 'created_at') is distinct from 'number'
       or coalesce(jsonb_typeof(r -> 'status_at'), 'null') not in ('number', 'null') then
      n_skipped := n_skipped + 1;
      continue;
    end if;
    -- Plausible ms timestamps only (1970 to 9999), so to_timestamp can't overflow.
    if (r ->> 'created_at')::numeric not between 0 and 253402300799999
       -- Parenthesised: PL/pgSQL would otherwise end the IF condition at CASE's own THEN.
       or (case when jsonb_typeof(r -> 'status_at') = 'number'
                then (r ->> 'status_at')::numeric not between 0 and 253402300799999
                else false end) then
      n_skipped := n_skipped + 1;
      continue;
    end if;

    created := to_timestamp((r ->> 'created_at')::numeric / 1000);
    done_at := case when jsonb_typeof(r -> 'status_at') = 'number'
                    then to_timestamp((r ->> 'status_at')::numeric / 1000) end;

    insert into public.items (id, transcript, text, captured_at, status, status_at, processed_by, source)
    values (
      r ->> 'id', t, t, created, r ->> 'status',
      case when r ->> 'status' = 'processed' then coalesce(done_at, created) else now() end,
      case when r ->> 'status' = 'processed' then 'jot-v1' end,
      'jot-v1'
    )
    on conflict (id) do nothing;

    if found then
      n_inserted := n_inserted + 1;
    else
      n_skipped := n_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object('inserted', n_inserted, 'skipped', n_skipped);
end;
$$;

-- Only signed-in callers may run any of these; each still checks the role itself.
revoke execute on function
  public.is_member(), public.is_owner(), public.member_name(),
  public.process_item(text, jsonb), public.discard_item(text), public.restore_item(text),
  public.edit_item_text(text, text), public.import_v1_items(jsonb)
from public, anon;
grant execute on function
  public.is_member(), public.is_owner(), public.member_name(),
  public.process_item(text, jsonb), public.discard_item(text), public.restore_item(text),
  public.edit_item_text(text, text), public.import_v1_items(jsonb)
to authenticated;

-- Trigger functions are never called directly.
revoke execute on function public.items_guard(), public.vocabulary_guard() from public, anon, authenticated;

-- ---------- Recordings bucket ----------
-- Private. Only the transcribe function (service role) writes to it; members may read, e.g. via signed URLs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 1048576, array['audio/webm', 'audio/ogg', 'audio/mp4'])
on conflict (id) do nothing;

create policy recordings_select_members on storage.objects
  for select to authenticated using (bucket_id = 'recordings' and (select public.is_member()));

-- ---------- Realtime: Processors may subscribe to new Items (RLS still applies) ----------

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  alter publication supabase_realtime add table public.items;
end;
$$;
