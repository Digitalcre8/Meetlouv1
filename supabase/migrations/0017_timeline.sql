-- 0017 the shared timeline: one event per capture, audience-filtered by RLS, read receipts, and an
-- audit trail of every capture, approval and access to a recording.

-- ---- audiences --------------------------------------------------------------------------------
-- The one place that says which audience sees which visibility. Nested, narrowest first:
--   firm   : the firm only
--   client : the firm and the client
--   chain  : the firm, the client and the rest of the chain
-- The RLS policy on events and the preview function below both call it.
create function app.visibility_allows(p_audience text, p_visibility text) returns boolean
language sql immutable set search_path = ''
as $$
  select case p_audience
           when 'firm'   then true
           when 'client' then p_visibility in ('client', 'chain')
           when 'chain'  then p_visibility = 'chain'
           else false
         end;
$$;
revoke all on function app.visibility_allows(text, text) from public;
grant execute on function app.visibility_allows(text, text) to authenticated, service_role;

create or replace function app.can_see_event(p_firm_id uuid, p_matter_id uuid, p_visibility text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select app.is_firm_user(p_firm_id)
      or coalesce(app.visibility_allows(app.participant_access(p_matter_id), p_visibility), false);
$$;

-- ---- who a capture is visible to --------------------------------------------------------------
-- A capture is visible to the client only when the client is a party to it: the call came from a
-- client participant's number, or the email came from a client participant's address AND the
-- provider's SPF or DKIM check passed (a forged "From" must not appear on the client's timeline
-- as something they sent). Everything else about a capture is the firm's business.
create function app.capture_visibility(
  p_matter_id uuid, p_phone text, p_email text, p_spf text, p_dkim text
) returns text
language sql stable security definer set search_path = ''
as $$
  select case
           when exists (
             select 1 from public.participants p
              where p.matter_id = p_matter_id and p.access = 'client'
                and (
                  (p_phone is not null and p.phone_e164 = p_phone)
                  or (p_email is not null and lower(p.email) = lower(p_email)
                      and (lower(coalesce(p_spf, '')) = 'pass' or lower(coalesce(p_dkim, '')) like '%pass%'))
                )
           ) then 'client'
           else 'firm'
         end;
$$;

-- ---- exactly one event per capture ------------------------------------------------------------
-- Written by a trigger on the capture table itself, in the same transaction, so no capture path
-- can forget it or write it twice. (The unique index on events also keeps it to one.) Findings
-- about a capture (mono audio, suppression) are separate events and stay in the ingest functions.
create function app.event_for_capture() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind text;
  v_subject text;
  v_visibility text := 'firm';
  v_occurred timestamptz := now();
  v_summary text;
begin
  case tg_table_name
    when 'calls' then
      v_subject := 'call';
      v_occurred := new.started_at;
      v_kind := case when new.consent_outcome = 'given' then 'call.received' else 'call.consent_not_given' end;
      v_summary := case when new.consent_outcome = 'given' then 'call received' else 'call received, consent not given' end;
      v_visibility := app.capture_visibility(new.matter_id, new.from_e164, null, null, null);
    when 'call_recordings' then
      v_subject := 'recording'; v_kind := 'call.recording_stored'; v_summary := 'recording stored';
    when 'emails' then
      v_subject := 'email'; v_kind := 'email.received'; v_summary := 'email received';
      v_visibility := app.capture_visibility(new.matter_id, null, new.from_address, new.spf_result, new.dkim_result);
    when 'attachments' then
      v_subject := 'attachment'; v_kind := 'email.attachment_stored'; v_summary := 'attachment stored';
    when 'transcripts' then
      v_subject := 'transcript'; v_kind := 'call.transcribed'; v_summary := 'transcript version ' || new.version;
    when 'generated_outputs' then
      v_subject := 'output'; v_kind := 'call.summarised';
      v_summary := 'summary version ' || new.version || ' awaiting a fee earner''s approval';
  end case;

  insert into public.events
    (firm_id, matter_id, kind, visibility, subject_kind, subject_id, occurred_at, actor_kind, summary)
  values (new.firm_id, new.matter_id, v_kind, v_visibility, v_subject, new.id, v_occurred, 'system', v_summary)
  on conflict (subject_kind, subject_id, kind, visibility) where subject_id is not null do nothing;
  return null;
end;
$$;
create trigger calls_event after insert on public.calls for each row execute function app.event_for_capture();
create trigger call_recordings_event after insert on public.call_recordings for each row execute function app.event_for_capture();
create trigger emails_event after insert on public.emails for each row execute function app.event_for_capture();
create trigger attachments_event after insert on public.attachments for each row execute function app.event_for_capture();
create trigger transcripts_event after insert on public.transcripts for each row execute function app.event_for_capture();
create trigger generated_outputs_event after insert on public.generated_outputs for each row execute function app.event_for_capture();

-- An approval is the firm telling the client their summary is available: it is on the client's
-- timeline (and so can be opened, and the opening recorded). A withdrawal is the firm's own.
create or replace function app.approvals_event() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'approvals' then
    insert into public.events
      (firm_id, matter_id, kind, visibility, subject_kind, subject_id, occurred_at, actor_kind, actor_id, summary)
    values (new.firm_id, new.matter_id, 'output.approved', 'client', 'output', new.generated_output_id,
            new.approved_at, 'fee_earner', new.approved_by, 'a summary of your call is available')
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

-- ---- the audit log carries every capture and every approval -------------------------------------
create function app.audit_capture() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_action text;
  v_object text;
  v_actor uuid := auth.uid();
  v_detail jsonb := '{}'::jsonb;
  v_object_id uuid := new.id;
begin
  case tg_table_name
    when 'calls' then
      v_action := 'call.captured'; v_object := 'call';
      if new.consent_outcome <> 'given' then v_detail := jsonb_build_object('reason', 'consent_' || new.consent_outcome); end if;
    when 'call_recordings' then v_action := 'recording.captured'; v_object := 'recording';
    when 'emails' then v_action := 'email.captured'; v_object := 'email';
    when 'attachments' then v_action := 'attachment.captured'; v_object := 'attachment';
    when 'transcripts' then v_action := 'transcript.created'; v_object := 'transcript';
    when 'generated_outputs' then v_action := 'output.generated'; v_object := 'output';
    when 'approvals' then v_action := 'approval.recorded'; v_object := 'approval'; v_actor := new.approved_by;
    when 'approval_withdrawals' then
      -- recorded against the approval it withdraws
      v_action := 'approval.withdrawn'; v_object := 'approval'; v_actor := new.withdrawn_by; v_object_id := new.approval_id;
  end case;
  insert into public.audit_log (firm_id, actor_id, action, object_kind, object_id, detail)
  values (new.firm_id, v_actor, v_action, v_object, v_object_id, v_detail);
  return null;
end;
$$;
create trigger calls_audit after insert on public.calls for each row execute function app.audit_capture();
create trigger call_recordings_audit after insert on public.call_recordings for each row execute function app.audit_capture();
create trigger emails_audit after insert on public.emails for each row execute function app.audit_capture();
create trigger attachments_audit after insert on public.attachments for each row execute function app.audit_capture();
create trigger transcripts_audit after insert on public.transcripts for each row execute function app.audit_capture();
create trigger generated_outputs_audit after insert on public.generated_outputs for each row execute function app.audit_capture();
create trigger approvals_audit after insert on public.approvals for each row execute function app.audit_capture();
create trigger approval_withdrawals_audit after insert on public.approval_withdrawals for each row execute function app.audit_capture();

-- ---- every access to a recording is audited ---------------------------------------------------
-- Firm members can no longer read the recordings bucket directly: that would be an access nobody
-- writes down. The only way to the audio is the recording-access function, which calls this first.
drop policy recordings_objects_select_firm on storage.objects;

create function public.record_recording_access(p_recording_id uuid, p_user_id uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  r public.call_recordings%rowtype;
begin
  select * into r from public.call_recordings where id = p_recording_id;
  if not found then
    raise exception 'unknown recording' using errcode = 'foreign_key_violation';
  end if;
  if not exists (select 1 from public.firm_users fu where fu.firm_id = r.firm_id and fu.user_id = p_user_id) then
    raise exception 'not a member of the firm' using errcode = 'insufficient_privilege';
  end if;
  insert into public.audit_log (firm_id, actor_id, action, object_kind, object_id)
  values (r.firm_id, p_user_id, 'recording.accessed', 'recording', r.id);
  return r.storage_path;
end;
$$;
revoke all on function public.record_recording_access(uuid, uuid) from public;
grant execute on function public.record_recording_access(uuid, uuid) to service_role;

-- ---- read receipts: who opened which event, and in what capacity -------------------------------
alter table public.receipts add column reader_role text not null default 'unknown';

-- Snapshot the reader's capacity at the moment they read, from the records of the time.
create function app.receipts_reader_role() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.reader_role := coalesce(
    (select fu.role from public.firm_users fu where fu.firm_id = new.firm_id and fu.user_id = new.user_id),
    (select p.access from public.participants p where p.matter_id = new.matter_id and p.user_id = new.user_id),
    'unknown'
  );
  return new;
end;
$$;
create trigger receipts_reader_role before insert on public.receipts
  for each row execute function app.receipts_reader_role();

-- For the firm: who has read what, with the participant's name where there is one.
create view public.matter_event_reads with (security_invoker = true) as
  select r.event_id, r.matter_id, r.user_id, r.reader_role, r.read_at, p.display_name
    from public.receipts r
    left join public.participants p on p.matter_id = r.matter_id and p.user_id = r.user_id;
grant select on public.matter_event_reads to authenticated, service_role;

-- ---- the timeline API --------------------------------------------------------------------------
-- Same request, different caller, different rows: the filtering is the RLS policy on events, not
-- anything here. A participant never sees which firm user wrote an event.
create view public.matter_timeline with (security_invoker = true) as
  select e.id as event_id, e.matter_id, e.kind, e.visibility, e.subject_kind, e.subject_id,
         e.occurred_at, e.recorded_at, e.actor_kind,
         case when app.is_firm_user(e.firm_id) then e.actor_id end as actor_id,
         e.summary, r.read_at
    from public.events e
    left join public.receipts r on r.event_id = e.id and r.user_id = auth.uid();
grant select on public.matter_timeline to authenticated, service_role;

-- What the timeline looks like to another audience, for a firm user checking it. It is the same
-- rule (app.visibility_allows) the RLS policy applies, run over what the caller can already see.
-- It cannot show more than the caller's own RLS allows, and it is not how a participant is served.
create function public.matter_timeline_as(p_matter_id uuid, p_audience text)
returns table (
  event_id uuid, matter_id uuid, kind text, visibility text, subject_kind text, subject_id uuid,
  occurred_at timestamptz, recorded_at timestamptz, actor_kind text, actor_id uuid, summary text, read_at timestamptz
)
language sql stable set search_path = ''
as $$
  select e.id, e.matter_id, e.kind, e.visibility, e.subject_kind, e.subject_id, e.occurred_at,
         e.recorded_at, e.actor_kind,
         case when p_audience = 'firm' then e.actor_id end,
         e.summary, null::timestamptz
    from public.events e
   where e.matter_id = p_matter_id
     and p_audience in ('firm', 'client', 'chain')
     and app.visibility_allows(p_audience, e.visibility);
$$;
revoke all on function public.matter_timeline_as(uuid, text) from public;
grant execute on function public.matter_timeline_as(uuid, text) to authenticated;

-- ---- the ingest functions, without their own primary events (the triggers write those) ---------
create or replace function public.ingest_recording(
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

create or replace function public.ingest_email(
  p_matter_id uuid,
  p_message_id text,
  p_message_id_synthesised boolean,
  p_in_reply_to text,
  p_references text[],
  p_from_address text,
  p_to_addresses text[],
  p_cc_addresses text[],
  p_subject text,
  p_sent_at timestamptz,
  p_raw_storage_path text,
  p_raw_sha256 text,
  p_body_text_storage_path text,
  p_body_html_storage_path text,
  p_spf_result text,
  p_dkim_result text,
  p_attachments jsonb
) returns table (email_id uuid, created boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  v_matter public.matters%rowtype;
  v_id uuid;
  v_existing_sha text;
  a jsonb;
  v_att_id uuid;
begin
  select * into v_matter from public.matters where id = p_matter_id;
  if not found then
    raise exception 'unknown matter' using errcode = 'foreign_key_violation';
  end if;

  insert into public.emails
    (firm_id, matter_id, message_id, message_id_synthesised, in_reply_to, references_ids,
     from_address, to_addresses, cc_addresses, subject, sent_at, raw_storage_path, raw_sha256,
     body_text_storage_path, body_html_storage_path, spf_result, dkim_result)
  values
    (v_matter.firm_id, p_matter_id, p_message_id, p_message_id_synthesised, p_in_reply_to,
     coalesce(p_references, '{}'), p_from_address, coalesce(p_to_addresses, '{}'),
     coalesce(p_cc_addresses, '{}'), p_subject, p_sent_at, p_raw_storage_path, p_raw_sha256,
     p_body_text_storage_path, p_body_html_storage_path, p_spf_result, p_dkim_result)
  on conflict (matter_id, message_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- A redelivery of a message we hold. Nothing is written twice. If the bytes differ from
    -- what we hold under that Message-ID, that is worth a human's attention: the first one stands.
    select e.id, e.raw_sha256 into v_id, v_existing_sha
      from public.emails e where e.matter_id = p_matter_id and e.message_id = p_message_id;
    if v_existing_sha is distinct from p_raw_sha256 then
      perform public.record_email_issue('email.duplicate_mismatch', v_matter.firm_id, p_raw_sha256,
                                        null, 'same_message_id_different_bytes');
    end if;
    return query select v_id, false;
    return;
  end if;

  for a in select * from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
    insert into public.attachments
      (firm_id, matter_id, email_id, ordinal, filename, content_type, sniffed_content_type,
       byte_length, sha256, storage_path)
    values
      (v_matter.firm_id, p_matter_id, v_id, (a ->> 'ordinal')::int, a ->> 'filename',
       a ->> 'content_type', a ->> 'sniffed_content_type', (a ->> 'byte_length')::bigint,
       a ->> 'sha256', a ->> 'storage_path')
    returning id into v_att_id;

  end loop;

  return query select v_id, true;
end;
$$;

create or replace function public.store_transcript(
  p_recording_id uuid,
  p_provider text,
  p_provider_job_id text,
  p_model text,
  p_diarised boolean,
  p_speaker_count smallint,
  p_language text,
  p_body_storage_path text,
  p_sha256 text
) returns table (transcript_id uuid, version integer, superseded_id uuid, created boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  r public.call_recordings%rowtype;
  v_prev public.transcripts%rowtype;
  v_existing public.transcripts%rowtype;
  v_id uuid;
  v_version integer;
begin
  select * into r from public.call_recordings where id = p_recording_id;
  if not found then
    raise exception 'unknown recording' using errcode = 'foreign_key_violation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_recording_id::text, 1));

  select * into v_existing from public.transcripts t
   where t.call_recording_id = p_recording_id and t.provider = p_provider
     and t.provider_job_id = p_provider_job_id;
  if found then
    return query select v_existing.id, v_existing.version, v_existing.supersedes_id, false;
    return;
  end if;

  select * into v_prev from public.transcripts t
   where t.call_recording_id = p_recording_id order by t.version desc limit 1;
  v_version := coalesce(v_prev.version, 0) + 1;

  insert into public.transcripts
    (firm_id, matter_id, call_recording_id, provider, provider_job_id, model, diarised,
     speaker_count, language, body_storage_path, sha256, version, supersedes_id)
  values
    (r.firm_id, r.matter_id, p_recording_id, p_provider, p_provider_job_id, p_model, p_diarised,
     p_speaker_count, p_language, p_body_storage_path, p_sha256, v_version, v_prev.id)
  returning id into v_id;

  return query select v_id, v_version, v_prev.id, true;
end;
$$;

create or replace function public.store_generated_output(
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

  return query select v_id, v_version, v_prev.id, true;
end;
$$;