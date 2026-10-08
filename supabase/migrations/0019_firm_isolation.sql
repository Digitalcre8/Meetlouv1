-- 0019 firm isolation: make "no row refers to another firm's, or another matter's, row" a fact the
-- database enforces rather than a habit the code keeps (non-negotiable 11).
--
-- Found by the isolation audit. Nothing here changes what any capture path stores; it removes
-- ways for a row, written by a bug or by a leaked service role key, to point across a boundary.

-- ---------------------------------------------------------------------------
-- 1. A correction must stay on its own matter. supersedes_id was a bare foreign key, so a
--    "correction" could reference any row in the database, another firm's included. The
--    reference now carries the matter and firm, as every other link between evidence rows does.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['calls', 'emails', 'events', 'generated_outputs', 'transcripts'] loop
    execute format('alter table public.%I drop constraint %I', t, t || '_supersedes_id_fkey');
    execute format(
      'alter table public.%I add constraint %I
         foreign key (supersedes_id, matter_id, firm_id) references public.%I (id, matter_id, firm_id)',
      t, t || '_supersedes_same_matter_fkey', t);
  end loop;
end $$;

-- The near-duplicate guard compares recordings on one matter; the constraint now says so too.
alter table public.recording_suppressions
  drop constraint recording_suppressions_duplicate_of_recording_id_fkey;
alter table public.recording_suppressions
  add constraint recording_suppressions_duplicate_of_same_matter_fkey
  foreign key (duplicate_of_recording_id, matter_id, firm_id)
  references public.call_recordings (id, matter_id, firm_id);

-- ---------------------------------------------------------------------------
-- 2. The retention tables (0018) pointed at a matter and at a firm separately, so a row could
--    name firm A and a matter of firm B. Same pairing as the evidence tables.
-- ---------------------------------------------------------------------------
alter table public.legal_holds add constraint legal_holds_id_matter_firm_key unique (id, matter_id, firm_id);
alter table public.erasure_requests
  add constraint erasure_requests_id_matter_firm_key unique (id, matter_id, firm_id);

alter table public.legal_holds drop constraint legal_holds_matter_id_fkey;
alter table public.legal_holds add constraint legal_holds_matter_firm_fkey
  foreign key (matter_id, firm_id) references public.matters (id, firm_id);

alter table public.legal_hold_releases drop constraint legal_hold_releases_matter_id_fkey;
alter table public.legal_hold_releases drop constraint legal_hold_releases_legal_hold_id_fkey;
alter table public.legal_hold_releases add constraint legal_hold_releases_hold_same_matter_fkey
  foreign key (legal_hold_id, matter_id, firm_id) references public.legal_holds (id, matter_id, firm_id);

alter table public.erasure_requests drop constraint erasure_requests_matter_id_fkey;
alter table public.erasure_requests add constraint erasure_requests_matter_firm_fkey
  foreign key (matter_id, firm_id) references public.matters (id, firm_id);

alter table public.erasure_request_decisions drop constraint erasure_request_decisions_matter_id_fkey;
alter table public.erasure_request_decisions
  drop constraint erasure_request_decisions_erasure_request_id_fkey;
alter table public.erasure_request_decisions
  add constraint erasure_request_decisions_request_same_matter_fkey
  foreign key (erasure_request_id, matter_id, firm_id)
  references public.erasure_requests (id, matter_id, firm_id);

alter table public.matter_retention_overrides drop constraint matter_retention_overrides_matter_id_fkey;
alter table public.matter_retention_overrides add constraint matter_retention_overrides_matter_firm_fkey
  foreign key (matter_id, firm_id) references public.matters (id, firm_id);

-- ---------------------------------------------------------------------------
-- 3. Stored objects are named <firm_id>/<matter_id>/..., and a row may only point at an object
--    under its own matter's folder. The pipeline reads whatever path a row names, so without this
--    a row could make one matter's job read, and send to a provider, another firm's audio.
--    NOT VALID: new rows are checked; nothing existing is rewritten (these tables are append-only).
-- ---------------------------------------------------------------------------
alter table public.call_recordings add constraint call_recordings_storage_path_own_matter
  check (starts_with(storage_path, firm_id::text || '/' || matter_id::text || '/')) not valid;
alter table public.transcripts add constraint transcripts_body_path_own_matter
  check (starts_with(body_storage_path, firm_id::text || '/' || matter_id::text || '/')) not valid;
alter table public.attachments add constraint attachments_storage_path_own_matter
  check (starts_with(storage_path, firm_id::text || '/' || matter_id::text || '/')) not valid;
alter table public.emails add constraint emails_object_paths_own_matter
  check (
    starts_with(raw_storage_path, firm_id::text || '/' || matter_id::text || '/')
    and (body_text_storage_path is null
         or starts_with(body_text_storage_path, firm_id::text || '/' || matter_id::text || '/'))
    and (body_html_storage_path is null
         or starts_with(body_html_storage_path, firm_id::text || '/' || matter_id::text || '/'))
  ) not valid;

-- ---------------------------------------------------------------------------
-- 4. The audit entry for an email problem was unique on the message hash alone. The same bytes
--    reaching two firms (the two sides of a transaction copying each other in is exactly that)
--    meant the second firm's entry was silently dropped because the first firm had one. The
--    key now includes the firm. (Twilio SIDs are globally unique and belong to one firm, so the
--    call and recording keys stay as they are.)
-- ---------------------------------------------------------------------------
drop index public.audit_log_email_issue_key;
create unique index audit_log_email_issue_key on public.audit_log
  ((coalesce(firm_id, '00000000-0000-0000-0000-000000000000'::uuid)), (detail ->> 'email_sha256'), action)
  where action like 'email.%' and detail ? 'email_sha256';

create or replace function public.record_email_issue(
  p_action text, p_firm_id uuid, p_email_sha256 text, p_recipient_domain text, p_reason text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_action not in ('email.unrouted', 'email.rejected', 'email.duplicate_mismatch') then
    raise exception 'unknown email issue %', p_action;
  end if;
  insert into public.audit_log (firm_id, action, object_kind, detail)
  values (p_firm_id, p_action, 'email',
          jsonb_strip_nulls(jsonb_build_object('email_sha256', p_email_sha256,
                                               'recipient_domain', p_recipient_domain,
                                               'reason', p_reason)))
  on conflict ((coalesce(firm_id, '00000000-0000-0000-0000-000000000000'::uuid)),
               (detail ->> 'email_sha256'), action)
    where action like 'email.%' and detail ? 'email_sha256' do nothing;
end;
$$;
