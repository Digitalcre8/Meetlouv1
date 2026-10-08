-- 0016 model output, and the approval gate (non-negotiable 4).
--
-- Nothing a model writes reaches a client until a fee earner has written an approval row. There
-- is deliberately NO "client visible" flag on an output: the only path a client has to a
-- summary is the view client_visible_outputs, which reads the approval.

create table public.generated_outputs (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null,
  matter_id       uuid not null,
  call_id         uuid not null,
  transcript_id   uuid not null,
  kind            text not null check (kind in ('call_summary')),
  provider        text not null,
  model           text not null,
  prompt_version  text not null,
  -- One run of the pipeline: a retry of the same run is a no-op, a deliberate re-run is a new version.
  run_id          uuid not null,
  -- Per (call, kind). A re-run writes the next version; the previous is never touched.
  version         integer not null check (version >= 1),
  supersedes_id   uuid references public.generated_outputs (id),
  -- The validated summary: { summary, actions[], keyDates[] }. The transcript text itself is in Storage.
  content         jsonb not null check (jsonb_typeof(content) = 'object'),
  content_sha256  text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  produced_at     timestamptz not null default now(),
  foreign key (call_id, matter_id, firm_id) references public.calls (id, matter_id, firm_id),
  foreign key (transcript_id, matter_id, firm_id) references public.transcripts (id, matter_id, firm_id),
  unique (call_id, kind, version),
  unique (call_id, kind, run_id),
  unique (id, matter_id, firm_id)
);
create index generated_outputs_call_id_idx on public.generated_outputs (call_id);

create trigger generated_outputs_append_only before update or delete on public.generated_outputs
  for each row execute function app.raise_append_only();
create trigger generated_outputs_no_truncate before truncate on public.generated_outputs
  for each statement execute function app.raise_append_only();

alter table public.generated_outputs enable row level security;
alter table public.generated_outputs force row level security;

-- Firm staff read every output on their firm's matters. There is NO policy for participants: a
-- client cannot read this table, approved or not. Their one route is client_visible_outputs.
create policy generated_outputs_select_firm on public.generated_outputs
  for select to authenticated using (app.is_firm_user(firm_id));

grant select on public.generated_outputs to authenticated;
grant select, insert on public.generated_outputs to service_role;

-- ---- approvals: written by a fee earner, never by the system ---------------------------------
create table public.approvals (
  id                  uuid primary key default gen_random_uuid(),
  firm_id             uuid not null,
  matter_id           uuid not null,
  generated_output_id uuid not null,
  approved_by         uuid not null references auth.users (id),
  approved_at         timestamptz not null default now(),
  foreign key (generated_output_id, matter_id, firm_id)
    references public.generated_outputs (id, matter_id, firm_id),
  -- One approval per output. A new version of a summary needs its own approval.
  unique (generated_output_id),
  unique (id, matter_id, firm_id)
);

-- An approval is final until withdrawn; a withdrawal is final too (approve the next version instead).
create table public.approval_withdrawals (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null,
  matter_id    uuid not null,
  approval_id  uuid not null,
  withdrawn_by uuid not null references auth.users (id),
  withdrawn_at timestamptz not null default now(),
  foreign key (approval_id, matter_id, firm_id) references public.approvals (id, matter_id, firm_id),
  unique (approval_id)
);

-- An output that has been replaced by a newer version cannot be approved: it is superseded because
-- it is no longer the best account of the call.
create function app.approvals_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.generated_outputs n where n.supersedes_id = new.generated_output_id) then
    raise exception 'a superseded output cannot be approved' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger approvals_guard before insert on public.approvals
  for each row execute function app.approvals_guard();

-- The timeline shows who approved what, and when.
create function app.approvals_event() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'approvals' then
    insert into public.events
      (firm_id, matter_id, kind, visibility, subject_kind, subject_id, occurred_at, actor_kind, actor_id, summary)
    values (new.firm_id, new.matter_id, 'output.approved', 'firm', 'output', new.generated_output_id,
            new.approved_at, 'fee_earner', new.approved_by, 'summary approved for the client')
    on conflict (subject_kind, subject_id, kind, visibility) where subject_id is not null do nothing;
  else
    insert into public.events
      (firm_id, matter_id, kind, visibility, subject_kind, subject_id, occurred_at, actor_kind, actor_id, summary)
    select new.firm_id, new.matter_id, 'output.approval_withdrawn', 'firm', 'output', a.generated_output_id,
           new.withdrawn_at, 'fee_earner', new.withdrawn_by, 'approval withdrawn'
      from public.approvals a where a.id = new.approval_id
    on conflict (subject_kind, subject_id, kind, visibility) where subject_id is not null do nothing;
  end if;
  return null;
end;
$$;
create trigger approvals_event after insert on public.approvals
  for each row execute function app.approvals_event();
create trigger approval_withdrawals_event after insert on public.approval_withdrawals
  for each row execute function app.approvals_event();

create trigger approvals_append_only before update or delete on public.approvals
  for each row execute function app.raise_append_only();
create trigger approvals_no_truncate before truncate on public.approvals
  for each statement execute function app.raise_append_only();
create trigger approval_withdrawals_append_only before update or delete on public.approval_withdrawals
  for each row execute function app.raise_append_only();
create trigger approval_withdrawals_no_truncate before truncate on public.approval_withdrawals
  for each statement execute function app.raise_append_only();

alter table public.approvals enable row level security;
alter table public.approvals force row level security;
alter table public.approval_withdrawals enable row level security;
alter table public.approval_withdrawals force row level security;

create policy approvals_select_firm on public.approvals
  for select to authenticated using (app.is_firm_user(firm_id));
create policy approval_withdrawals_select_firm on public.approval_withdrawals
  for select to authenticated using (app.is_firm_user(firm_id));

-- Only a FEE EARNER of the firm, and only as themselves. Not the COLP or an admin acting for
-- them, not a participant, and not the service role (it is granted no INSERT on this table).
create policy approvals_insert_fee_earner on public.approvals
  for insert to authenticated
  with check (approved_by = auth.uid() and app.has_firm_role(firm_id, array['fee_earner']));

-- Withdrawing an approval is a safety valve, so the COLP and admins may do it too.
create policy approval_withdrawals_insert_firm on public.approval_withdrawals
  for insert to authenticated
  with check (withdrawn_by = auth.uid() and app.has_firm_role(firm_id, array['fee_earner', 'colp', 'admin']));

grant select on public.approvals, public.approval_withdrawals to authenticated;
grant insert (firm_id, matter_id, generated_output_id, approved_by) on public.approvals to authenticated;
grant insert (firm_id, matter_id, approval_id, withdrawn_by) on public.approval_withdrawals to authenticated;
grant select on public.approvals, public.approval_withdrawals to service_role;

-- ---- the serving path --------------------------------------------------------------------------
-- What a client participant may read: the outputs on their own matter that a fee earner has
-- approved, that have not been withdrawn, and that no newer version has replaced. It reads the
-- APPROVAL ROW; nothing on the output says "visible". Only 'client' participants (not 'chain')
-- are served, and the columns exclude provider, model and prompt.
--
-- Owned by the table owner so it can read approvals, which participants cannot; its WHERE clause
-- is the whole access check, and security_barrier stops a caller's own predicates running before it.
create view public.client_visible_outputs with (security_barrier = true) as
  select o.id as output_id, o.matter_id, o.call_id, o.kind, o.version, o.content, a.approved_at
    from public.generated_outputs o
    join public.approvals a on a.generated_output_id = o.id
   where app.participant_access(o.matter_id) = 'client'
     and not exists (select 1 from public.approval_withdrawals w where w.approval_id = a.id)
     and not exists (select 1 from public.generated_outputs n where n.supersedes_id = o.id);
grant select on public.client_visible_outputs to authenticated;

-- For the fee earner: the current output of each call and where it stands. The status is computed
-- from the approval rows when read; it is not stored.
create view public.call_summaries_current with (security_invoker = true) as
  select o.id as output_id, o.firm_id, o.matter_id, o.call_id, o.version, o.content,
         o.provider, o.model, o.prompt_version, o.produced_at,
         case
           when a.id is null then 'awaiting_approval'
           when w.id is not null then 'approval_withdrawn'
           else 'approved'
         end as approval_status
    from public.generated_outputs o
    left join public.approvals a on a.generated_output_id = o.id
    left join public.approval_withdrawals w on w.approval_id = a.id
   where o.kind = 'call_summary'
     and not exists (select 1 from public.generated_outputs n where n.supersedes_id = o.id);
grant select on public.call_summaries_current to authenticated, service_role;

-- ---- store an output as the next version, atomically -----------------------------------------
create function public.store_generated_output(
  p_call_id uuid,
  p_transcript_id uuid,
  p_kind text,
  p_provider text,
  p_model text,
  p_prompt_version text,
  p_run_id uuid,
  p_content jsonb,
  p_content_sha256 text
) returns table (output_id uuid, version integer, superseded_id uuid, created boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  c public.calls%rowtype;
  v_prev public.generated_outputs%rowtype;
  v_existing public.generated_outputs%rowtype;
  v_id uuid;
  v_version integer;
begin
  select * into c from public.calls where id = p_call_id;
  if not found then
    raise exception 'unknown call' using errcode = 'foreign_key_violation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_call_id::text, 2));

  select * into v_existing from public.generated_outputs o
   where o.call_id = p_call_id and o.kind = p_kind and o.run_id = p_run_id;
  if found then
    return query select v_existing.id, v_existing.version, v_existing.supersedes_id, false;
    return;
  end if;

  select * into v_prev from public.generated_outputs o
   where o.call_id = p_call_id and o.kind = p_kind order by o.version desc limit 1;
  v_version := coalesce(v_prev.version, 0) + 1;

  insert into public.generated_outputs
    (firm_id, matter_id, call_id, transcript_id, kind, provider, model, prompt_version, run_id,
     version, supersedes_id, content, content_sha256)
  values
    (c.firm_id, c.matter_id, p_call_id, p_transcript_id, p_kind, p_provider, p_model,
     p_prompt_version, p_run_id, v_version, v_prev.id, p_content, p_content_sha256)
  returning id into v_id;

  insert into public.events
    (firm_id, matter_id, kind, visibility, subject_kind, subject_id, occurred_at, actor_kind, summary)
  values
    (c.firm_id, c.matter_id, 'call.summarised', 'firm', 'output', v_id, now(), 'system',
     'summary version ' || v_version || ' awaiting a fee earner''s approval')
  on conflict (subject_kind, subject_id, kind, visibility) where subject_id is not null do nothing;

  return query select v_id, v_version, v_prev.id, true;
end;
$$;
revoke all on function public.store_generated_output(uuid, uuid, text, text, text, text, uuid, jsonb, text) from public;
grant execute on function public.store_generated_output(uuid, uuid, text, text, text, text, uuid, jsonb, text) to service_role;

-- ---- the work queues ----------------------------------------------------------------------------
-- A permanent failure (the model refused, the output failed validation) parks the item with an audit
-- row so it is not retried, and not paid for, forever; a person re-runs it deliberately. A transient
-- failure (network, outage) leaves no row and is simply tried again.
create or replace view public.recordings_awaiting_transcription with (security_invoker = true) as
  select r.id as recording_id, r.firm_id, r.matter_id, r.call_id, r.storage_path,
         r.channels, r.is_dual_channel, r.recorded_at
    from public.call_recordings r
   where not exists (select 1 from public.recording_suppressions s where s.recording_id = r.id)
     and not exists (select 1 from public.transcripts t where t.call_recording_id = r.id)
     and not exists (select 1 from public.audit_log a
                      where a.action = 'recording.transcription_failed'
                        and a.detail ->> 'recording_sid' = r.twilio_recording_sid);

-- Transcribed, not suppressed, no summary yet.
create view public.transcripts_awaiting_summary with (security_invoker = true) as
  select t.id as transcript_id, t.call_recording_id as recording_id, t.firm_id, t.matter_id,
         r.call_id, t.body_storage_path, r.channels
    from public.current_transcripts t
    join public.call_recordings r on r.id = t.call_recording_id
   where not exists (select 1 from public.recording_suppressions s where s.recording_id = r.id)
     and not exists (select 1 from public.generated_outputs o
                      where o.transcript_id = t.id and o.kind = 'call_summary')
     and not exists (select 1 from public.audit_log a
                      where a.action = 'recording.summary_failed'
                        and a.detail ->> 'recording_sid' = r.twilio_recording_sid);
grant select on public.transcripts_awaiting_summary to service_role;

-- Failures of the pipeline are audited like the other ingest problems.
create or replace function public.record_recording_issue(
  p_action text, p_recording_sid text, p_call_sid text, p_firm_id uuid, p_reason text
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_action not in ('recording.quarantined', 'recording.rejected', 'recording.not_completed',
                      'recording.download_failed', 'recording.transcription_failed',
                      'recording.summary_failed') then
    raise exception 'unknown recording issue %', p_action;
  end if;
  insert into public.audit_log (firm_id, action, object_kind, detail)
  values (p_firm_id, p_action, 'recording',
          jsonb_build_object('recording_sid', p_recording_sid, 'call_sid', p_call_sid, 'reason', p_reason))
  on conflict ((detail ->> 'recording_sid'), action) where action like 'recording.%' do nothing;
end;
$$;
