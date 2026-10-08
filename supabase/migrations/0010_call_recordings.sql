-- 0010 call_recordings and recording_suppressions: the audio of a call, and why (if at all)
-- it is not to be treated as a real conversation. Both are append-only.

-- Lets recordings prove that call, matter and firm agree.
alter table public.calls add constraint calls_id_matter_firm_key unique (id, matter_id, firm_id);

create table public.call_recordings (
  id                   uuid primary key default gen_random_uuid(),
  firm_id              uuid not null,
  matter_id            uuid not null,
  call_id              uuid not null,
  -- Idempotency key.
  twilio_recording_sid text not null unique check (twilio_recording_sid ~ '^RE[0-9a-f]{32}$'),
  -- <firm_id>/<matter_id>/<recording_sid>.wav in the private 'recordings' bucket.
  storage_path         text not null,
  sha256               text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length          bigint not null check (byte_length > 0),
  -- As reported by Twilio's callback.
  duration_seconds     integer not null check (duration_seconds >= 0),
  -- Read from bytes 22-23 of the WAV header of what we actually downloaded, never taken
  -- on trust from Twilio's callback.
  channels             smallint not null check (channels in (1, 2)),
  -- We always ask for two (RequestedChannels=2). A mono result means Twilio gave us a mixdown.
  requested_channels   smallint not null default 2 check (requested_channels = 2),
  -- The one place that says whether a recording can have speakers told apart by channel.
  -- Anything downstream that labels speakers must go through this (see transcripts).
  is_dual_channel      boolean generated always as (channels = 2) stored,
  recorded_at          timestamptz not null default now(),
  foreign key (call_id, matter_id, firm_id) references public.calls (id, matter_id, firm_id),
  unique (id, matter_id, firm_id)
);
create index call_recordings_matter_id_idx on public.call_recordings (matter_id, recorded_at);
create index call_recordings_call_id_idx on public.call_recordings (call_id);

-- Non-negotiable 1, enforced where it cannot be bypassed: no recording without consent.
create function app.require_consented_call() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.calls c where c.id = new.call_id and c.consent_outcome = 'given'
  ) then
    raise exception 'a recording needs a call with consent given'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger call_recordings_require_consent before insert on public.call_recordings
  for each row execute function app.require_consented_call();

create trigger call_recordings_append_only before update or delete on public.call_recordings
  for each row execute function app.raise_append_only();
create trigger call_recordings_no_truncate before truncate on public.call_recordings
  for each statement execute function app.raise_append_only();

-- A recording that is not to be treated as a real conversation, and the reason. Nothing is
-- deleted: the audio and the row remain, and the suppression is itself a row on the file.
create table public.recording_suppressions (
  id                        uuid primary key default gen_random_uuid(),
  firm_id                   uuid not null,
  matter_id                 uuid not null,
  recording_id              uuid not null,
  reason                    text not null check (reason in ('misdial', 'near_duplicate', 'single_speaker')),
  duplicate_of_recording_id uuid references public.call_recordings (id),
  duration_seconds          integer,
  decided_at                timestamptz not null default now(),
  foreign key (recording_id, matter_id, firm_id)
    references public.call_recordings (id, matter_id, firm_id),
  unique (recording_id, reason),
  check ((reason = 'near_duplicate') = (duplicate_of_recording_id is not null))
);

create trigger recording_suppressions_append_only before update or delete on public.recording_suppressions
  for each row execute function app.raise_append_only();
create trigger recording_suppressions_no_truncate before truncate on public.recording_suppressions
  for each statement execute function app.raise_append_only();

-- Timeline events about recordings point at the recording itself.
alter table public.events drop constraint events_subject_kind_check;
alter table public.events add constraint events_subject_kind_check
  check (subject_kind in ('call', 'email', 'attachment', 'matter', 'recording'));

-- Audit entries about recordings that could not be stored may name the recording SID.
alter table public.audit_log drop constraint audit_log_detail_check;
alter table public.audit_log add constraint audit_log_detail_check
  check (detail - array['changed_columns', 'counts', 'call_sid', 'to_e164', 'reason', 'recording_sid'] = '{}'::jsonb);

-- One audit row per recording and kind of problem, however often Twilio retries.
create unique index audit_log_recording_issue_key
  on public.audit_log ((detail ->> 'recording_sid'), action) where action like 'recording.%';

alter table public.call_recordings enable row level security;
alter table public.call_recordings force row level security;
alter table public.recording_suppressions enable row level security;
alter table public.recording_suppressions force row level security;

-- Recordings are firm material. A participant never reads one.
create policy call_recordings_select_firm on public.call_recordings
  for select to authenticated using (app.is_firm_user(firm_id));
create policy recording_suppressions_select_firm on public.recording_suppressions
  for select to authenticated using (app.is_firm_user(firm_id));

grant select on public.call_recordings, public.recording_suppressions to authenticated;
grant select, insert on public.call_recordings, public.recording_suppressions to service_role;

-- The whole ingest of a stored recording in one transaction, so a retry or a race can neither
-- duplicate it nor skip a guard. Called by the recording-status webhook (service role only).
--
-- Guards (each sets a suppression; none deletes anything):
--   misdial        shorter than 15 seconds
--   near_duplicate same matter, same UK calendar day as the call, duration within 90 seconds of
--                  another recording on that matter that is not itself suppressed
-- single_speaker is applied when a transcript reports one speaker (see transcripts).
create function public.ingest_recording(
  p_call_id uuid,
  p_recording_sid text,
  p_storage_path text,
  p_sha256 text,
  p_byte_length bigint,
  p_duration_seconds integer,
  p_channels smallint
) returns table (recording_id uuid, created boolean, suppressed text[])
language plpgsql security definer set search_path = ''
as $$
declare
  v_call public.calls%rowtype;
  v_id uuid;
  v_created boolean := true;
  v_dup uuid;
  v_reasons text[] := '{}';
begin
  select * into v_call from public.calls where id = p_call_id;
  if not found then
    raise exception 'unknown call' using errcode = 'foreign_key_violation';
  end if;

  -- Serialise ingests on one matter, so two simultaneous recordings see each other.
  perform pg_advisory_xact_lock(hashtextextended(v_call.matter_id::text, 0));

  insert into public.call_recordings
    (firm_id, matter_id, call_id, twilio_recording_sid, storage_path, sha256, byte_length,
     duration_seconds, channels)
  values
    (v_call.firm_id, v_call.matter_id, p_call_id, p_recording_sid, p_storage_path, p_sha256,
     p_byte_length, p_duration_seconds, p_channels)
  on conflict (twilio_recording_sid) do nothing
  returning id into v_id;

  if v_id is null then
    -- A redelivery: nothing is written twice.
    select r.id into v_id from public.call_recordings r where r.twilio_recording_sid = p_recording_sid;
    return query
      select v_id, false,
             coalesce((select array_agg(s.reason order by s.reason)
                         from public.recording_suppressions s where s.recording_id = v_id), '{}');
    return;
  end if;

  insert into public.events
    (firm_id, matter_id, kind, visibility, subject_kind, subject_id, occurred_at, actor_kind, summary)
  values
    (v_call.firm_id, v_call.matter_id, 'call.recording_stored', 'firm', 'recording', v_id, now(),
     'system', 'recording stored')
  on conflict (subject_kind, subject_id, kind, visibility) where subject_id is not null do nothing;

  -- Non-negotiable 5: say so when the audio is not dual-channel.
  if p_channels = 1 then
    insert into public.events
      (firm_id, matter_id, kind, visibility, subject_kind, subject_id, occurred_at, actor_kind, summary)
    values
      (v_call.firm_id, v_call.matter_id, 'call.recording_mono', 'firm', 'call', p_call_id, now(),
       'system', 'recording is mono: speakers cannot be told apart by channel')
    on conflict (subject_kind, subject_id, kind, visibility) where subject_id is not null do nothing;
  end if;

  if p_duration_seconds < 15 then
    insert into public.recording_suppressions
      (firm_id, matter_id, recording_id, reason, duration_seconds)
    values (v_call.firm_id, v_call.matter_id, v_id, 'misdial', p_duration_seconds);
    v_reasons := array_append(v_reasons, 'misdial');
  end if;

  select r.id into v_dup
    from public.call_recordings r
    join public.calls c on c.id = r.call_id
   where r.matter_id = v_call.matter_id
     and r.id <> v_id
     and r.call_id <> p_call_id
     and (c.started_at at time zone 'Europe/London')::date
         = (v_call.started_at at time zone 'Europe/London')::date
     and abs(r.duration_seconds - p_duration_seconds) <= 90
     and not exists (select 1 from public.recording_suppressions s where s.recording_id = r.id)
   order by r.recorded_at, r.id
   limit 1;
  if v_dup is not null then
    insert into public.recording_suppressions
      (firm_id, matter_id, recording_id, reason, duplicate_of_recording_id, duration_seconds)
    values (v_call.firm_id, v_call.matter_id, v_id, 'near_duplicate', v_dup, p_duration_seconds);
    v_reasons := array_append(v_reasons, 'near_duplicate');
  end if;

  if cardinality(v_reasons) > 0 then
    insert into public.events
      (firm_id, matter_id, kind, visibility, subject_kind, subject_id, occurred_at, actor_kind, summary)
    values
      (v_call.firm_id, v_call.matter_id, 'recording.suppressed', 'firm', 'recording', v_id, now(),
       'system', 'suppressed: ' || array_to_string(v_reasons, ', '))
    on conflict (subject_kind, subject_id, kind, visibility) where subject_id is not null do nothing;
  end if;

  return query select v_id, true, v_reasons;
end;
$$;
revoke all on function public.ingest_recording(uuid, text, text, text, bigint, integer, smallint) from public;
grant execute on function public.ingest_recording(uuid, text, text, text, bigint, integer, smallint) to service_role;

-- A recording that could not be stored (or should not be) leaves an audit row naming it, so
-- it is never lost silently. The audio itself stays at Twilio, which we do not delete.
create function public.record_recording_issue(
  p_action text, p_recording_sid text, p_call_sid text, p_firm_id uuid, p_reason text
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_action not in ('recording.quarantined', 'recording.rejected', 'recording.not_completed',
                      'recording.download_failed') then
    raise exception 'unknown recording issue %', p_action;
  end if;
  insert into public.audit_log (firm_id, action, object_kind, detail)
  values (p_firm_id, p_action, 'recording',
          jsonb_build_object('recording_sid', p_recording_sid, 'call_sid', p_call_sid, 'reason', p_reason))
  on conflict ((detail ->> 'recording_sid'), action) where action like 'recording.%' do nothing;
end;
$$;
revoke all on function public.record_recording_issue(text, text, text, uuid, text) from public;
grant execute on function public.record_recording_issue(text, text, text, uuid, text) to service_role;
