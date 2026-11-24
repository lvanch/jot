-- Local development only: `supabase db reset` runs this. It never runs against the hosted project.
--
--   Owner   owner@jot.local   signs in with the emailed code; read it in Mailpit (http://127.0.0.1:54324)
--   Agent   claude@jot.local  password local-claude-password, role processor
--
-- Token columns are '' rather than NULL because GoTrue can't read NULLs there.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated',
   'owner@jot.local', '', now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated',
   'claude@jot.local', extensions.crypt('local-claude-password', extensions.gen_salt('bf')), now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');

insert into auth.identities (user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select u.id, u.id::text, 'email', jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       now(), now(), now()
from auth.users u
where u.email in ('owner@jot.local', 'claude@jot.local');

insert into public.members (user_id, role, name) values
  ('00000000-0000-4000-8000-00000000000a', 'owner', 'owner'),
  ('00000000-0000-4000-8000-00000000000b', 'processor', 'claude');
