-- CI only (ci.yml copies this into migrations/ ahead of the real ones). It removes Supabase's default privileges on
-- the public schema, which the local stack has and a new hosted project doesn't, so every test runs against grants
-- the migrations make themselves (20261126000000_explicit_grants.sql). Never deploy this.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;
