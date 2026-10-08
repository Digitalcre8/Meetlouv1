-- 0018 retention, legal hold and erasure.
--
-- Deletion is a scheduled job, never an application action (non-negotiable 3). The shape:
--
--   * Nobody who serves an application route can delete a row. anon, authenticated and
--     service_role have no DELETE or TRUNCATE on any evidence table, and the append-only triggers
--     still raise for every one of them, the owner included. (Storage objects are different:
--     the platform owns the grants on storage.objects and service_role can delete there. The
--     job removes objects only after begin_erasure() has authorised the matter, and a guard
--     forbids object removal anywhere else in the repo. See THREAT-MODEL.)
--   * One role, retention_runner, can delete. It is NOLOGIN; the job reaches it through a token
--     whose role claim is retention_runner. It can execute exactly the functions below.
--   * It can delete a matter's rows only while an OPEN ERASURE RUN exists for that
--     matter and the matter is not on legal hold. An erasure run is written only by
--     begin_erasure(), which checks eligibility itself. The database, not the job, decides.
--   * The audit log is never deleted by anyone. Erasure writes an audit entry naming the fact
--     (matter id, counts per table, basis) and nothing about content.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'retention_runner') then
    create role retention_runner nologin noinherit;
  end if;
end $$;

-- PostgREST and Storage connect as authenticator and switch to the role named in the token.
grant retention_runner to authenticator;
grant usage on schema public, app to retention_runner;

-- ---------------------------------------------------------------------------
-- The retention clock starts when the closure was RECORDED, never earlier.
-- matters.closed_at is editable by fee earners; if the clock trusted it, backdating it would
-- be an application action that causes deletion. closed_recorded_at is set by the database
-- whenever closed_at changes, so the period can only ever be longer than the firm asked for.
-- ---------------------------------------------------------------------------
alter table public.matters add column closed_recorded_at timestamptz;
update public.matters set closed_recorded_at = now() where closed_at is not null;

create or replace function app.matters_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.inbound_slug := app.make_inbound_slug(new.property_address);
    new.closed_recorded_at := case when new.closed_at is null then null else now() end;
  else
    if new.id is distinct from old.id
       or new.firm_id is distinct from old.firm_id
       or new.inbound_slug is distinct from old.inbound_slug then
      raise exception 'matters.id, firm_id and inbound_slug are immutable'
        using errcode = 'restrict_violation';
    end if;
    if new.closed_at is distinct from old.closed_at then
      new.closed_recorded_at := case when new.closed_at is null then null else now() end;
    elsif not (current_setting('role') = 'none' and session_user in ('postgres', 'supabase_admin')) then
      -- Only an operator connected directly as the database owner may set this (to correct a
      -- record). Inside a SECURITY DEFINER trigger current_user is always the function owner, so
      -- ask who is really connected: every API role, the service role included, has switched
      -- role (so current_setting('role') is not 'none') and keeps what was recorded.
      new.closed_recorded_at := old.closed_recorded_at;
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The firm's retention period, and a per-matter override. Both are versioned (insert-only) so
-- the file shows what the period was on any date. There is deliberately no default: a firm with
-- no stated period has nothing scheduled and nothing is ever erased for it.
-- ---------------------------------------------------------------------------
create table public.retention_policies (
  id                     uuid primary key default gen_random_uuid(),
  firm_id                uuid not null references public.firms (id),
  retention_period_years integer not null check (retention_period_years between 1 and 100),
  set_by                 uuid not null references auth.users (id),
  set_at                 timestamptz not null default now()
);
create index retention_policies_firm_idx on public.retention_policies (firm_id, set_at desc);

create table public.matter_retention_overrides (
  id                     uuid primary key default gen_random_uuid(),
  firm_id                uuid not null references public.firms (id),
  matter_id              uuid not null references public.matters (id),
  retention_period_years integer not null check (retention_period_years between 1 and 100),
  reason_code            text not null
                         check (reason_code in ('indemnity_insurance', 'build_over_agreement',
                                                'regulatory', 'client_agreement', 'other')),
  set_by                 uuid not null references auth.users (id),
  set_at                 timestamptz not null default now()
);
create index matter_retention_overrides_matter_idx
  on public.matter_retention_overrides (matter_id, set_at desc);

-- ---------------------------------------------------------------------------
-- Legal hold. A matter is held while any hold on it has no release. A held matter is never
-- touched by the job: not for the retention period, not for an erasure request.
-- ---------------------------------------------------------------------------
create table public.legal_holds (
  id          uuid primary key default gen_random_uuid(),
  firm_id     uuid not null references public.firms (id),
  matter_id   uuid not null references public.matters (id),
  reason_code text not null check (reason_code in ('complaint', 'claim', 'regulatory', 'other')),
  placed_by   uuid not null references auth.users (id),
  placed_at   timestamptz not null default now()
);
create index legal_holds_matter_idx on public.legal_holds (matter_id);

create table public.legal_hold_releases (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null references public.firms (id),
  matter_id     uuid not null references public.matters (id),
  legal_hold_id uuid not null unique references public.legal_holds (id),
  released_by   uuid not null references auth.users (id),
  released_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Erasure requests. The firm is the controller: someone records that a request arrived, and the
-- COLP decides. Only an approved request is acted on, and only by the job, and never while the
-- matter is held or still open.
-- ---------------------------------------------------------------------------
create table public.erasure_requests (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null references public.firms (id),
  matter_id    uuid not null references public.matters (id),
  requested_by uuid not null references auth.users (id),
  requested_at timestamptz not null default now()
);
create index erasure_requests_matter_idx on public.erasure_requests (matter_id);

create table public.erasure_request_decisions (
  id                 uuid primary key default gen_random_uuid(),
  firm_id            uuid not null references public.firms (id),
  matter_id          uuid not null references public.matters (id),
  erasure_request_id uuid not null unique references public.erasure_requests (id),
  decision           text not null check (decision in ('approved', 'refused')),
  reason_code        text not null
                     check (reason_code in ('data_subject_request', 'legal_obligation',
                                            'legal_claims', 'other')),
  decided_by         uuid not null references auth.users (id),
  decided_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- The erasure run is the authorisation, and afterwards the proof. matter_id has NO foreign key
-- on purpose: these rows must outlive the matter they describe. They hold the firm's own file
-- reference and counts, never content.
-- ---------------------------------------------------------------------------
create table public.erasure_runs (
  id                 uuid primary key default gen_random_uuid(),
  firm_id            uuid not null references public.firms (id),
  matter_id          uuid not null,
  matter_reference   text not null,
  basis              text not null check (basis in ('retention_period', 'erasure_request')),
  erasure_request_id uuid,
  started_at         timestamptz not null default now()
);
create index erasure_runs_matter_idx on public.erasure_runs (matter_id);

create table public.erasure_run_completions (
  id             uuid primary key default gen_random_uuid(),
  firm_id        uuid not null references public.firms (id),
  erasure_run_id uuid not null unique references public.erasure_runs (id),
  counts         jsonb not null,
  completed_at   timestamptz not null default now()
);

do $$
declare
  t text;
begin
  foreach t in array array['retention_policies', 'matter_retention_overrides', 'legal_holds',
                           'legal_hold_releases', 'erasure_requests', 'erasure_request_decisions',
                           'erasure_runs', 'erasure_run_completions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('create trigger %I before update or delete on public.%I
                    for each row execute function app.raise_append_only()',
                   t || '_append_only', t);
    execute format('create trigger %I before truncate on public.%I
                    for each statement execute function app.raise_append_only()',
                   t || '_no_truncate', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Helpers (private schema). All read through the owner, so a caller learns only the answer.
-- ---------------------------------------------------------------------------

-- Held while any hold has no release.
create function app.matter_on_hold(p_matter_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.legal_holds h
     where h.matter_id = p_matter_id
       and not exists (select 1 from public.legal_hold_releases r where r.legal_hold_id = h.id)
  )
$$;

-- The period that applies: the latest override, else the firm's latest stated policy, else null.
create function app.effective_retention_years(p_matter_id uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select o.retention_period_years
       from public.matter_retention_overrides o
      where o.matter_id = p_matter_id
      order by o.set_at desc, o.id desc
      limit 1),
    (select p.retention_period_years
       from public.retention_policies p
       join public.matters m on m.firm_id = p.firm_id
      where m.id = p_matter_id
      order by p.set_at desc, p.id desc
      limit 1)
  )
$$;

-- Why this matter may be erased now, or null. A hold beats everything. A matter that is not
-- closed is never erased. An approved erasure request needs no waiting; otherwise the period
-- runs from the later of the stated closure and the day it was recorded.
create function app.matter_erasure_basis(p_matter_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when m.id is null then null
    when app.matter_on_hold(m.id) then null
    when m.closed_at is null then null
    when exists (
      select 1 from public.erasure_request_decisions d
       where d.matter_id = m.id and d.decision = 'approved'
    ) then 'erasure_request'
    when app.effective_retention_years(m.id) is not null
         and greatest(m.closed_at, m.closed_recorded_at)
             + make_interval(years => app.effective_retention_years(m.id)) <= now()
      then 'retention_period'
    else null
  end
  from (select p_matter_id as id) q
  left join public.matters m on m.id = q.id
$$;

-- An open erasure run (no completion) on a matter that is not held. This is the only thing
-- the delete policies below accept.
create function app.erasure_authorised(p_matter_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_matter_id is not null
     and not app.matter_on_hold(p_matter_id)
     and exists (
       select 1 from public.erasure_runs r
        where r.matter_id = p_matter_id
          and not exists (select 1 from public.erasure_run_completions c where c.erasure_run_id = r.id)
     )
$$;

-- The firm of a matter, readable by the job whether or not it is yet authorised to see the row.
create function app.matter_firm(p_matter_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.firm_id from public.matters m where m.id = p_matter_id
$$;

revoke all on function app.matter_on_hold(uuid), app.effective_retention_years(uuid),
  app.matter_erasure_basis(uuid), app.erasure_authorised(uuid), app.matter_firm(uuid)
  from public;
grant execute on function app.matter_on_hold(uuid), app.matter_erasure_basis(uuid),
  app.effective_retention_years(uuid), app.erasure_authorised(uuid),
  app.matter_firm(uuid) to retention_runner;

-- ---------------------------------------------------------------------------
-- Who can read and write the new tables (names: <table>_<verb>_<who>)
-- ---------------------------------------------------------------------------
grant select on public.retention_policies, public.matter_retention_overrides,
  public.legal_holds, public.legal_hold_releases, public.erasure_requests,
  public.erasure_request_decisions, public.erasure_runs, public.erasure_run_completions
  to authenticated;
grant insert (firm_id, retention_period_years, set_by) on public.retention_policies to authenticated;
grant insert (firm_id, matter_id, retention_period_years, reason_code, set_by)
  on public.matter_retention_overrides to authenticated;
grant insert (firm_id, matter_id, reason_code, placed_by) on public.legal_holds to authenticated;
grant insert (firm_id, matter_id, legal_hold_id, released_by)
  on public.legal_hold_releases to authenticated;
grant insert (firm_id, matter_id, requested_by) on public.erasure_requests to authenticated;
grant insert (firm_id, matter_id, erasure_request_id, decision, reason_code, decided_by)
  on public.erasure_request_decisions to authenticated;

-- Every firm member can see the period, the overrides and any hold (a fee earner needs to know a
-- matter is held). Only the COLP states a period or an override or decides a request; the COLP or
-- an admin places and releases a hold; any fee earner, the COLP or an admin records a request.
create policy retention_policies_select_firm on public.retention_policies
  for select to authenticated using (app.is_firm_user(firm_id));
create policy retention_policies_insert_colp on public.retention_policies
  for insert to authenticated
  with check (app.has_firm_role(firm_id, array['colp']) and set_by = auth.uid());

create policy matter_retention_overrides_select_firm on public.matter_retention_overrides
  for select to authenticated using (app.is_firm_user(firm_id));
create policy matter_retention_overrides_insert_colp on public.matter_retention_overrides
  for insert to authenticated
  with check (
    app.has_firm_role(firm_id, array['colp']) and set_by = auth.uid()
    and exists (select 1 from public.matters m where m.id = matter_id and m.firm_id = firm_id)
  );

create policy legal_holds_select_firm on public.legal_holds
  for select to authenticated using (app.is_firm_user(firm_id));
create policy legal_holds_insert_colp_admin on public.legal_holds
  for insert to authenticated
  with check (
    app.has_firm_role(firm_id, array['colp', 'admin']) and placed_by = auth.uid()
    and exists (select 1 from public.matters m where m.id = matter_id and m.firm_id = firm_id)
  );

create policy legal_hold_releases_select_firm on public.legal_hold_releases
  for select to authenticated using (app.is_firm_user(firm_id));
create policy legal_hold_releases_insert_colp_admin on public.legal_hold_releases
  for insert to authenticated
  with check (
    app.has_firm_role(firm_id, array['colp', 'admin']) and released_by = auth.uid()
    and exists (
      select 1 from public.legal_holds h
       where h.id = legal_hold_id and h.firm_id = firm_id and h.matter_id = matter_id
    )
  );

create policy erasure_requests_select_firm on public.erasure_requests
  for select to authenticated using (app.is_firm_user(firm_id));
create policy erasure_requests_insert_firm on public.erasure_requests
  for insert to authenticated
  with check (
    app.is_firm_user(firm_id) and requested_by = auth.uid()
    and exists (select 1 from public.matters m where m.id = matter_id and m.firm_id = firm_id)
  );

create policy erasure_request_decisions_select_firm on public.erasure_request_decisions
  for select to authenticated using (app.is_firm_user(firm_id));
create policy erasure_request_decisions_insert_colp on public.erasure_request_decisions
  for insert to authenticated
  with check (
    app.has_firm_role(firm_id, array['colp']) and decided_by = auth.uid()
    and exists (
      select 1 from public.erasure_requests r
       where r.id = erasure_request_id and r.firm_id = firm_id and r.matter_id = matter_id
    )
  );

-- The proof of erasure is for the COLP and admins. Nobody inserts through the API: begin_erasure
-- and finish_erasure_run write these.
create policy erasure_runs_select_colp_admin on public.erasure_runs
  for select to authenticated using (app.has_firm_role(firm_id, array['colp', 'admin']));
create policy erasure_run_completions_select_colp_admin on public.erasure_run_completions
  for select to authenticated using (app.has_firm_role(firm_id, array['colp', 'admin']));

-- Placing a hold takes the matter's row lock, as the job does before it deletes, so a hold and an
-- erasure on one matter are ordered: either the hold lands first and the job sees it, or the
-- erasure lands first and the hold is refused because the matter no longer exists.
create function app.lock_matter(p_matter_id uuid) returns void
language sql security definer set search_path = '' as $$
  select 1 from public.matters where id = p_matter_id for update
$$;
revoke all on function app.lock_matter(uuid) from public;
grant execute on function app.lock_matter(uuid) to retention_runner;

create function app.legal_holds_lock_matter() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.lock_matter(new.matter_id);
  return new;
end;
$$;
create trigger legal_holds_lock_matter before insert on public.legal_holds
  for each row execute function app.legal_holds_lock_matter();

-- ---------------------------------------------------------------------------
-- The audit trail for the firm's own retention decisions: facts and identifiers only.
-- ---------------------------------------------------------------------------
create function app.audit_retention_decision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_action text;
  v_reason text;
  v_object uuid := (to_jsonb(new) ->> 'matter_id')::uuid;
begin
  if tg_table_name = 'retention_policies' then
    v_action := 'retention_policy.set';  v_object := new.id;
  elsif tg_table_name = 'matter_retention_overrides' then
    v_action := 'retention_override.set'; v_reason := new.reason_code;
  elsif tg_table_name = 'legal_holds' then
    v_action := 'legal_hold.placed';     v_reason := new.reason_code;
  elsif tg_table_name = 'legal_hold_releases' then
    v_action := 'legal_hold.released';
  elsif tg_table_name = 'erasure_requests' then
    v_action := 'erasure.requested';
  else
    v_action := 'erasure.' || new.decision; v_reason := new.reason_code;
  end if;
  insert into public.audit_log (firm_id, actor_id, action, object_kind, object_id, detail)
  values (new.firm_id, auth.uid(), v_action,
          case when tg_table_name = 'retention_policies' then 'retention_policy' else 'matter' end,
          v_object,
          case when v_reason is null then '{}'::jsonb else jsonb_build_object('reason', v_reason) end);
  return null;
end;
$$;

create trigger retention_policies_audit after insert on public.retention_policies
  for each row execute function app.audit_retention_decision();
create trigger matter_retention_overrides_audit after insert on public.matter_retention_overrides
  for each row execute function app.audit_retention_decision();
create trigger legal_holds_audit after insert on public.legal_holds
  for each row execute function app.audit_retention_decision();
create trigger legal_hold_releases_audit after insert on public.legal_hold_releases
  for each row execute function app.audit_retention_decision();
create trigger erasure_requests_audit after insert on public.erasure_requests
  for each row execute function app.audit_retention_decision();
create trigger erasure_request_decisions_audit after insert on public.erasure_request_decisions
  for each row execute function app.audit_retention_decision();

-- ---------------------------------------------------------------------------
-- The only deletes. raise_append_only() lets the retention role through for DELETE and for
-- nothing else, and never on the audit log.
-- ---------------------------------------------------------------------------
create or replace function app.raise_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_user = 'retention_runner' and tg_table_name <> 'audit_log' then
    return old;
  end if;
  raise exception 'append-only: % on %.% is not permitted', tg_op, tg_table_schema, tg_table_name
    using errcode = 'restrict_violation',
          hint = 'Record a correction as a new row that references the old one.';
end;
$$;

-- What retention_runner may select and delete, and the single condition: an open erasure run on
-- a matter that is not held. (The matters table is keyed by id, the rest by matter_id.)
do $$
declare
  t text;
begin
  foreach t in array array['receipts', 'events', 'approval_withdrawals', 'approvals',
                           'generated_outputs', 'transcripts', 'recording_suppressions',
                           'call_recordings', 'attachments', 'emails', 'calls', 'participants',
                           'legal_hold_releases', 'legal_holds', 'erasure_request_decisions',
                           'erasure_requests', 'matter_retention_overrides', 'matters'] loop
    execute format('grant select, delete on public.%I to retention_runner', t);
    execute format('create policy %I on public.%I for select to retention_runner
                    using (app.erasure_authorised(%s))',
                   t || '_select_retention', t, case when t = 'matters' then 'id' else 'matter_id' end);
    execute format('create policy %I on public.%I for delete to retention_runner
                    using (app.erasure_authorised(%s))',
                   t || '_delete_retention', t, case when t = 'matters' then 'id' else 'matter_id' end);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The job's interface. Execute: retention_runner only.
-- ---------------------------------------------------------------------------

-- Audit entries the job writes. A fixed set of actions; detail is ids, a reason code and counts.
create function app.retention_audit(
  p_firm_id uuid, p_action text, p_object_id uuid, p_detail jsonb
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_action not in ('erasure.started', 'erasure.blocked', 'evidence.erased',
                      'retention.skipped_hold', 'retention.run') then
    raise exception 'retention_audit: unknown action';
  end if;
  insert into public.audit_log (firm_id, actor_id, action, object_kind, object_id, detail)
  values (p_firm_id, null, p_action,
          case when p_action = 'retention.run' then 'retention_run' else 'matter' end,
          p_object_id, p_detail);
end;
$$;
revoke all on function app.retention_audit(uuid, text, uuid, jsonb) from public;
grant execute on function app.retention_audit(uuid, text, uuid, jsonb) to retention_runner;

-- Matters that have reached the end of their period or have an approved request, with whether a
-- hold stops them. Identifiers only.
create function public.retention_due()
returns table (matter_id uuid, firm_id uuid, basis text, on_hold boolean)
language sql stable security definer set search_path = '' as $$
  select m.id, m.firm_id,
         coalesce(
           case when exists (select 1 from public.erasure_request_decisions d
                              where d.matter_id = m.id and d.decision = 'approved')
                then 'erasure_request' end,
           'retention_period'),
         app.matter_on_hold(m.id)
    from public.matters m
   where m.closed_at is not null
     and (
       exists (select 1 from public.erasure_request_decisions d
                where d.matter_id = m.id and d.decision = 'approved')
       or (app.effective_retention_years(m.id) is not null
           and greatest(m.closed_at, m.closed_recorded_at)
               + make_interval(years => app.effective_retention_years(m.id)) <= now())
     )
   order by m.closed_at, m.id
$$;

-- Open (or reopen) the erasure of one matter and return the object folders to empty. Writes the
-- authorisation row only if the matter is erasable right now; otherwise says why not.
create function public.begin_erasure(p_matter_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_matter public.matters;
  v_basis  text;
  v_open   public.erasure_runs;
begin
  select * into v_matter from public.matters where id = p_matter_id;
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;
  perform app.lock_matter(p_matter_id);

  if app.matter_on_hold(p_matter_id) then
    return jsonb_build_object('status', 'held');
  end if;
  v_basis := app.matter_erasure_basis(p_matter_id);
  if v_basis is null then
    return jsonb_build_object('status', 'not_due');
  end if;

  select r.* into v_open
    from public.erasure_runs r
   where r.matter_id = p_matter_id
     and not exists (select 1 from public.erasure_run_completions c where c.erasure_run_id = r.id)
   order by r.started_at desc
   limit 1;
  if not found then
    insert into public.erasure_runs (firm_id, matter_id, matter_reference, basis, erasure_request_id)
    values (v_matter.firm_id, p_matter_id, v_matter.reference, v_basis,
            (select d.erasure_request_id from public.erasure_request_decisions d
              where d.matter_id = p_matter_id and d.decision = 'approved'
              order by d.decided_at limit 1))
    returning * into v_open;
    perform app.retention_audit(v_matter.firm_id, 'erasure.started', p_matter_id,
                                jsonb_build_object('reason', v_basis));
  end if;

  return jsonb_build_object(
    'status', 'authorised',
    'run_id', v_open.id,
    'firm_id', v_matter.firm_id,
    'prefix', v_matter.firm_id::text || '/' || p_matter_id::text
  );
end;
$$;

-- Written by complete_erasure, in the same transaction as the deletes.
create function app.finish_erasure_run(p_matter_id uuid, p_counts jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.erasure_runs;
begin
  select r.* into v_run
    from public.erasure_runs r
   where r.matter_id = p_matter_id
     and not exists (select 1 from public.erasure_run_completions c where c.erasure_run_id = r.id)
   order by r.started_at desc
   limit 1;
  insert into public.erasure_run_completions (firm_id, erasure_run_id, counts)
  values (v_run.firm_id, v_run.id, p_counts);
  perform app.retention_audit(v_run.firm_id, 'evidence.erased', p_matter_id,
                              jsonb_build_object('reason', v_run.basis, 'counts', p_counts));
end;
$$;
revoke all on function app.finish_erasure_run(uuid, jsonb) from public;
grant execute on function app.finish_erasure_run(uuid, jsonb) to retention_runner;

-- Delete the matter's rows. Runs as retention_runner, so every delete is held to the policies
-- above: if the matter is held, or has no open run, each delete sees no rows. The check up front
-- turns that into an answer, and the lock orders this against a hold being placed.
create function public.complete_erasure(p_matter_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_counts jsonb := '{}'::jsonb;
  v_n      integer;
  v_releases integer;
  v_holds  integer;
  v_firm   uuid;
  v_table  text;
begin
  perform app.lock_matter(p_matter_id);
  v_firm := app.matter_firm(p_matter_id);

  if app.matter_on_hold(p_matter_id) then
    perform app.retention_audit(v_firm, 'erasure.blocked', p_matter_id,
                                jsonb_build_object('reason', 'legal_hold'));
    return jsonb_build_object('status', 'held');
  end if;
  if not app.erasure_authorised(p_matter_id) then
    return jsonb_build_object('status', 'not_authorised');
  end if;

  -- Children before parents.
  foreach v_table in array array['receipts', 'events', 'approval_withdrawals', 'approvals',
                                 'generated_outputs', 'transcripts', 'recording_suppressions',
                                 'call_recordings', 'attachments', 'emails', 'calls',
                                 'participants', 'erasure_request_decisions',
                                 'erasure_requests', 'matter_retention_overrides'] loop
    execute format('delete from public.%I where matter_id = $1', v_table) using p_matter_id;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object(v_table, v_n);
  end loop;
  -- Holds and their releases go in ONE statement. Taken apart, deleting the releases first would
  -- make the matter look held again and the policies would then refuse every later delete.
  with r as (delete from public.legal_hold_releases where matter_id = p_matter_id returning 1),
       h as (delete from public.legal_holds where matter_id = p_matter_id returning 1)
  select (select count(*) from r), (select count(*) from h) into v_releases, v_holds;
  v_counts := v_counts || jsonb_build_object('legal_hold_releases', v_releases, 'legal_holds', v_holds);

  delete from public.matters where id = p_matter_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('matters', v_n);
  if v_n <> 1 then
    raise exception 'complete_erasure: matter not removed';
  end if;

  perform app.finish_erasure_run(p_matter_id, v_counts);
  return jsonb_build_object('status', 'erased', 'counts', v_counts);
end;
$$;

-- Say, once per hold, that a matter was due and a hold stopped the job.
create function public.note_retention_hold(p_matter_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_firm   uuid;
  v_placed timestamptz;
begin
  select m.firm_id into v_firm from public.matters m where m.id = p_matter_id;
  select max(h.placed_at) into v_placed from public.legal_holds h where h.matter_id = p_matter_id;
  if v_firm is null or v_placed is null then
    return;
  end if;
  if not exists (
    select 1 from public.audit_log a
     where a.action = 'retention.skipped_hold' and a.object_id = p_matter_id
       and a.occurred_at >= v_placed
  ) then
    perform app.retention_audit(v_firm, 'retention.skipped_hold', p_matter_id,
                                jsonb_build_object('reason', 'legal_hold'));
  end if;
end;
$$;

-- One entry per job run: how many it looked at, erased, held back, and failed.
create function public.record_retention_run(
  p_examined integer, p_erased integer, p_held integer, p_failed integer
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.retention_audit(null, 'retention.run', null, jsonb_build_object('counts',
    jsonb_build_object('examined', p_examined, 'erased', p_erased,
                       'held', p_held, 'failed', p_failed)));
end;
$$;

revoke all on function public.retention_due(), public.begin_erasure(uuid),
  public.complete_erasure(uuid), public.note_retention_hold(uuid),
  public.record_retention_run(integer, integer, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.retention_due(), public.begin_erasure(uuid),
  public.complete_erasure(uuid), public.note_retention_hold(uuid),
  public.record_retention_run(integer, integer, integer, integer)
  to retention_runner;

-- complete_erasure is the one function that must run AS retention_runner (the append-only
-- triggers and the delete policies look at the role); the others only read or write the
-- authorisation and are owned by the migration role.
grant create on schema public to retention_runner;
alter function public.complete_erasure(uuid) owner to retention_runner;
revoke create on schema public from retention_runner;
