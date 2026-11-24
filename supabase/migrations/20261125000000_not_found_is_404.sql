-- not_found was raised as SQLSTATE P0002, which PostgREST answers with HTTP 500, not the 404 that spec §4
-- promises. A 500 tells a Processor "server trouble, try again", which is wrong for an Item that doesn't exist.
-- PostgREST maps SQLSTATE PTxyz to HTTP xyz, so the four lifecycle functions now raise PT404. They're otherwise
-- unchanged; `create or replace` keeps their grants. Clients match on the message, `not_found`, as before.

create or replace function public.process_item(item_id text, outcome jsonb default null) returns public.items
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
    raise exception 'not_found' using errcode = 'PT404';
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

create or replace function public.discard_item(item_id text) returns public.items
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
    raise exception 'not_found' using errcode = 'PT404';
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

create or replace function public.restore_item(item_id text) returns public.items
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
    raise exception 'not_found' using errcode = 'PT404';
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

create or replace function public.edit_item_text(item_id text, new_text text) returns public.items
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
    raise exception 'not_found' using errcode = 'PT404';
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
