-- 0001 foundation: private helper schema, locked-down default privileges, append-only guard.

-- Helper functions live in `app`, which is not exposed through the API (PostgREST only
-- exposes `public`), so they cannot be called as RPC endpoints.
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

create extension if not exists pgcrypto with schema extensions;

-- Supabase grants ALL on every new public table/sequence/function to anon, authenticated
-- and service_role. Take that away: every migration now grants exactly what it means to.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;
alter default privileges for role postgres revoke execute on functions from public;

-- Evidence tables carry this as a BEFORE UPDATE OR DELETE (row) and BEFORE TRUNCATE
-- (statement) trigger. It fires for every role, including service_role and the owner,
-- because RLS bypass does not bypass triggers.
create function app.raise_append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'append-only: % on %.% is not permitted', tg_op, tg_table_schema, tg_table_name
    using errcode = 'restrict_violation',
          hint = 'Record a correction as a new row that references the old one.';
end;
$$;
