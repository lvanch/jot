-- Grant the API roles exactly what the schema needs, instead of relying on Supabase's default privileges.
--
-- The local stack's default privileges grant every new table to anon, authenticated and service_role, so the first
-- migration only had to revoke. A new hosted project doesn't: there, service_role couldn't read members (health
-- answered 503), signed-in clients couldn't read Items, and transcribe couldn't park them. Row-level security still
-- decides which rows each member sees; these grants only open the tables to it. anon stays shut out (first migration).

grant usage on schema public to authenticated, service_role;

-- Members (the Owner and processors). Items change only through the lifecycle functions, never directly.
grant select on public.items, public.members, public.transcription_log to authenticated;
grant select, insert, delete on public.vocabulary to authenticated;

-- The service role, inside the Edge Functions: transcribe checks membership, parks Items, logs every call and reads
-- the Vocabulary; health counts members. Runbooks use it to add and remove processors (docs/inbox-contract.md).
grant select, insert, update, delete on public.items, public.members, public.vocabulary, public.transcription_log
  to service_role;
