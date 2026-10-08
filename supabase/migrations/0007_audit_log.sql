-- 0007 audit_log: append-only, with no update or delete policy, ever.

create table public.audit_log (
  id          bigint generated always as identity primary key,
  firm_id     uuid references public.firms (id),
  occurred_at timestamptz not null default now(),
  actor_id    uuid,
  action      text not null,
  object_kind text not null,
  object_id   uuid,
  -- Identifiers and column names only. Never values, never content.
  detail      jsonb not null default '{}'::jsonb
                check (detail - array['changed_columns', 'counts'] = '{}'::jsonb)
);
create index audit_log_firm_id_idx on public.audit_log (firm_id, occurred_at);

create trigger audit_log_append_only before update or delete on public.audit_log
  for each row execute function app.raise_append_only();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function app.raise_append_only();

alter table public.audit_log enable row level security;
alter table public.audit_log force row level security;

-- The COLP and admins of a firm may read its audit log. There is deliberately no INSERT,
-- UPDATE or DELETE policy: entries are written by the trigger below (SECURITY DEFINER) or
-- by the service role, and can never be changed or removed.
create policy audit_log_select_colp_admin on public.audit_log
  for select to authenticated
  using (app.has_firm_role(firm_id, array['colp', 'admin']));

grant select on public.audit_log to authenticated;
grant select, insert on public.audit_log to service_role;

-- Reference data is mutable, so every change to it is audited: who, what, which columns.
create function app.audit_change() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_firm uuid := case when tg_table_name = 'firms' then (v_row ->> 'id')::uuid
                      else (v_row ->> 'firm_id')::uuid end;
  v_changed text[];
begin
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}')
      into v_changed
      from jsonb_each(v_new) n
      join jsonb_each(v_old) o on o.key = n.key
     where n.value is distinct from o.value;
    if v_changed = '{}' then
      return null;
    end if;
  end if;

  insert into public.audit_log (firm_id, actor_id, action, object_kind, object_id, detail)
  values (
    v_firm,
    auth.uid(),
    tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    (v_row ->> 'id')::uuid,
    case when tg_op = 'UPDATE' then jsonb_build_object('changed_columns', to_jsonb(v_changed))
         else '{}'::jsonb end
  );
  return null;
end;
$$;

create trigger firms_audit after insert or update or delete on public.firms
  for each row execute function app.audit_change();
create trigger firm_users_audit after insert or update or delete on public.firm_users
  for each row execute function app.audit_change();
create trigger matters_audit after insert or update or delete on public.matters
  for each row execute function app.audit_change();
create trigger participants_audit after insert or update or delete on public.participants
  for each row execute function app.audit_change();
