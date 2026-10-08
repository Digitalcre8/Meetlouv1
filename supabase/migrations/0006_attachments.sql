-- 0006 attachments (documents). The one thing a chain participant never sees.

create table public.attachments (
  id           uuid primary key default gen_random_uuid(),
  firm_id      uuid not null,
  matter_id    uuid not null,
  email_id     uuid not null,
  ordinal      integer not null check (ordinal >= 0),
  filename     text not null,
  content_type text not null,
  byte_length  bigint not null check (byte_length >= 0),
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text not null,
  recorded_at  timestamptz not null default now(),
  foreign key (email_id, matter_id, firm_id) references public.emails (id, matter_id, firm_id),
  unique (email_id, ordinal)
);
create index attachments_matter_id_idx on public.attachments (matter_id);

create trigger attachments_append_only before update or delete on public.attachments
  for each row execute function app.raise_append_only();
create trigger attachments_no_truncate before truncate on public.attachments
  for each statement execute function app.raise_append_only();

-- A document is shared with the client only by a client-visibility event about it. Sharing
-- is therefore itself on the timeline, and a chain-visibility event never unlocks a document.
create function app.attachment_shared_with_client(p_attachment_id uuid, p_matter_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.events e
    where e.subject_kind = 'attachment' and e.subject_id = p_attachment_id
      and e.matter_id = p_matter_id and e.visibility = 'client'
  );
$$;
revoke all on function app.attachment_shared_with_client(uuid, uuid) from public;
grant execute on function app.attachment_shared_with_client(uuid, uuid) to authenticated, service_role;

alter table public.attachments enable row level security;
alter table public.attachments force row level security;

-- Firm: all documents on its matters. Client participant: only those shared with them.
-- Chain participant: never (no branch of this policy admits access = 'chain').
create policy attachments_select_firm_or_shared_client on public.attachments
  for select to authenticated
  using (
    app.is_firm_user(firm_id)
    or (app.participant_access(matter_id) = 'client'
        and app.attachment_shared_with_client(id, matter_id))
  );

grant select on public.attachments to authenticated;
grant select, insert on public.attachments to service_role;
