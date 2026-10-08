-- 0011 the private bucket recordings are stored in.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 157286400,
        array['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'])
on conflict (id) do nothing;

-- Objects are named <firm_id>/<matter_id>/<recording_sid>.wav. A fee earner (any member of the
-- firm) may read their own firm's recordings; nobody else, and no participant, may read any.
-- There is no insert/update/delete policy: only the service role (the webhook, and later the
-- retention job) writes or removes objects.
create policy recordings_objects_select_firm on storage.objects
  for select to authenticated
  using (
    bucket_id = 'recordings'
    and case
          when (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then app.is_firm_user(((storage.foldername(name))[1])::uuid)
          else false
        end
  );
