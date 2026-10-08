-- 0015 transcripts become versioned, and their text gets a private bucket.

alter table public.transcripts
  add column version integer not null default 1 check (version >= 1),
  add column supersedes_id uuid references public.transcripts (id),
  add constraint transcripts_recording_version_key unique (call_recording_id, version),
  add constraint transcripts_id_matter_firm_key unique (id, matter_id, firm_id);

-- Timeline events can point at a transcript or a generated output.
alter table public.events drop constraint events_subject_kind_check;
alter table public.events add constraint events_subject_kind_check
  check (subject_kind in ('call', 'email', 'attachment', 'matter', 'recording', 'transcript', 'output'));

-- The text of a call. Never in a column, so it cannot be selected or logged by accident.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('transcripts', 'transcripts', false, 33554432, array['application/json'])
on conflict (id) do nothing;

create policy transcripts_objects_select_firm on storage.objects
  for select to authenticated
  using (
    bucket_id = 'transcripts'
    and case
          when (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then app.is_firm_user(((storage.foldername(name))[1])::uuid)
          else false
        end
  );

-- The latest transcript of each recording: the one no later version has superseded.
create view public.current_transcripts with (security_invoker = true) as
  select t.* from public.transcripts t
   where not exists (select 1 from public.transcripts n where n.supersedes_id = t.id);
grant select on public.current_transcripts to authenticated, service_role;

-- Store a transcript as the next version of its recording's transcript, atomically. The previous
-- version is not touched; the new row says which one it supersedes. A retry of the same provider
-- job (same recording, provider and job id) returns the row it already wrote.
create function public.store_transcript(
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

  insert into public.events
    (firm_id, matter_id, kind, visibility, subject_kind, subject_id, occurred_at, actor_kind, summary)
  values
    (r.firm_id, r.matter_id, 'call.transcribed', 'firm', 'transcript', v_id, now(), 'system',
     'transcript version ' || v_version)
  on conflict (subject_kind, subject_id, kind, visibility) where subject_id is not null do nothing;

  return query select v_id, v_version, v_prev.id, true;
end;
$$;
revoke all on function public.store_transcript(uuid, text, text, text, boolean, smallint, text, text, text) from public;
grant execute on function public.store_transcript(uuid, text, text, text, boolean, smallint, text, text, text) to service_role;
