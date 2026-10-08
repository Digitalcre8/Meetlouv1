-- 0014 private buckets for inbound email: the raw message and its bodies, and attachments.

-- 'emails' holds <firm>/<matter>/<sha256(message_id)>/raw.eml, body.txt and body.html.
-- Bodies are stored as text/plain, never text/html, so nothing can ever serve them as a page.
-- 'attachments' holds <firm>/<matter>/<sha256> and is stored as opaque bytes: whatever type the
-- sender claimed, it is never served as anything but a download.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('emails', 'emails', false, 33554432, array['message/rfc822', 'text/plain']),
  ('attachments', 'attachments', false, 33554432, array['application/octet-stream'])
on conflict (id) do nothing;

-- As for recordings: a firm's members read their own firm's objects; nobody writes through the
-- user API. (Sharing a document with a client is done by a server minting a short-lived signed
-- URL after checking the attachments policy, not by opening this bucket to participants.)
create policy emails_objects_select_firm on storage.objects
  for select to authenticated
  using (
    bucket_id in ('emails', 'attachments')
    and case
          when (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then app.is_firm_user(((storage.foldername(name))[1])::uuid)
          else false
        end
  );
