-- 0012 transcripts: just enough to make two promises true in the database itself.
--   * a mono recording can never be described as diarised
--   * a transcript with a single speaker suppresses the recording (a two-party call has two)
-- Transcription itself (providers, summaries) is a later milestone.

create table public.transcripts (
  id                 uuid primary key default gen_random_uuid(),
  firm_id            uuid not null,
  matter_id          uuid not null,
  call_recording_id  uuid not null,
  provider           text not null,
  provider_job_id    text not null,
  model              text,
  -- True only if speakers were told apart using the two channels. Enforced below.
  diarised           boolean not null default false,
  -- Distinct speakers the provider found; null if it did not say.
  speaker_count      smallint check (speaker_count >= 0),
  language           text,
  -- The text lives in Storage, never in a column, so it cannot be selected or logged by accident.
  body_storage_path  text not null,
  sha256             text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  produced_at        timestamptz not null default now(),
  foreign key (call_recording_id, matter_id, firm_id)
    references public.call_recordings (id, matter_id, firm_id),
  unique (call_recording_id, provider, provider_job_id)
);

create function app.transcripts_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.diarised and not exists (
    select 1 from public.call_recordings r
     where r.id = new.call_recording_id and r.is_dual_channel
  ) then
    raise exception 'a mono recording cannot be described as diarised'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger transcripts_guard before insert on public.transcripts
  for each row execute function app.transcripts_guard();

create function app.transcripts_single_speaker() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.speaker_count = 1 then
    insert into public.recording_suppressions (firm_id, matter_id, recording_id, reason)
    values (new.firm_id, new.matter_id, new.call_recording_id, 'single_speaker')
    on conflict (recording_id, reason) do nothing;

    insert into public.events
      (firm_id, matter_id, kind, visibility, subject_kind, subject_id, occurred_at, actor_kind, summary)
    values
      (new.firm_id, new.matter_id, 'recording.suppressed', 'firm', 'recording', new.call_recording_id,
       now(), 'system', 'suppressed: single_speaker')
    on conflict (subject_kind, subject_id, kind, visibility) where subject_id is not null do nothing;
  end if;
  return null;
end;
$$;
create trigger transcripts_single_speaker after insert on public.transcripts
  for each row execute function app.transcripts_single_speaker();

create trigger transcripts_append_only before update or delete on public.transcripts
  for each row execute function app.raise_append_only();
create trigger transcripts_no_truncate before truncate on public.transcripts
  for each statement execute function app.raise_append_only();

alter table public.transcripts enable row level security;
alter table public.transcripts force row level security;

create policy transcripts_select_firm on public.transcripts
  for select to authenticated using (app.is_firm_user(firm_id));

grant select on public.transcripts to authenticated;
grant select, insert on public.transcripts to service_role;

-- The hand-off queue for transcription: recordings that are stored, not suppressed, and not yet
-- transcribed. The recording webhook only stores; whatever transcribes reads this.
create view public.recordings_awaiting_transcription with (security_invoker = true) as
  select r.id as recording_id, r.firm_id, r.matter_id, r.call_id, r.storage_path,
         r.channels, r.is_dual_channel, r.recorded_at
    from public.call_recordings r
   where not exists (select 1 from public.recording_suppressions s where s.recording_id = r.id)
     and not exists (select 1 from public.transcripts t where t.call_recording_id = r.id);
grant select on public.recordings_awaiting_transcription to service_role;
