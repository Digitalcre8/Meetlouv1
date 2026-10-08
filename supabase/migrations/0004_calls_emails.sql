-- 0004 calls and emails: evidence, append-only. Written only by the service role.

create table public.calls (
  id                           uuid primary key default gen_random_uuid(),
  firm_id                      uuid not null,
  matter_id                    uuid not null,
  -- Idempotency key. Twilio call SIDs are 'CA' + 32 hex.
  call_sid                     text not null unique check (call_sid ~ '^CA[0-9a-f]{32}$'),
  direction                    text not null default 'inbound' check (direction = 'inbound'),
  from_e164                    text not null check (from_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  to_e164                      text not null check (to_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  started_at                   timestamptz not null,
  recorded_at                  timestamptz not null default now(),
  consent_announcement_version text not null,
  consent_outcome              text not null check (consent_outcome in ('given', 'declined', 'no_response')),
  consent_given_at             timestamptz,
  supersedes_id                uuid references public.calls (id),
  foreign key (matter_id, firm_id) references public.matters (id, firm_id),
  -- Consent is a fact with a time: present exactly when it was given.
  check ((consent_outcome = 'given') = (consent_given_at is not null))
);
create index calls_matter_id_idx on public.calls (matter_id, started_at);

create table public.emails (
  id                      uuid primary key default gen_random_uuid(),
  firm_id                 uuid not null,
  matter_id               uuid not null,
  -- Idempotency key, normalised (no angle brackets or whitespace). Scoped to the matter, so
  -- a Message-ID cannot collide across firms and one email addressed to two matters is
  -- evidence on both.
  message_id              text not null check (length(message_id) > 0 and message_id !~ '[<>[:space:]]'),
  in_reply_to             text,
  references_ids          text[] not null default '{}',
  from_address            text not null,
  to_addresses            text[] not null default '{}',
  cc_addresses            text[] not null default '{}',
  subject                 text,
  sent_at                 timestamptz,
  recorded_at             timestamptz not null default now(),
  raw_storage_path        text not null,
  raw_sha256              text not null check (raw_sha256 ~ '^[0-9a-f]{64}$'),
  body_text_storage_path  text,
  body_html_storage_path  text,
  spf_result              text,
  dkim_result             text,
  supersedes_id           uuid references public.emails (id),
  foreign key (matter_id, firm_id) references public.matters (id, firm_id),
  unique (matter_id, message_id),
  unique (id, matter_id, firm_id)
);
create index emails_matter_id_idx on public.emails (matter_id, recorded_at);

create trigger calls_append_only before update or delete on public.calls
  for each row execute function app.raise_append_only();
create trigger calls_no_truncate before truncate on public.calls
  for each statement execute function app.raise_append_only();
create trigger emails_append_only before update or delete on public.emails
  for each row execute function app.raise_append_only();
create trigger emails_no_truncate before truncate on public.emails
  for each statement execute function app.raise_append_only();

alter table public.calls enable row level security;
alter table public.calls force row level security;
alter table public.emails enable row level security;
alter table public.emails force row level security;

-- Calls and emails are firm material. Participants never read them directly; what they
-- may know is surfaced through events.
create policy calls_select_firm on public.calls
  for select to authenticated using (app.is_firm_user(firm_id));
create policy emails_select_firm on public.emails
  for select to authenticated using (app.is_firm_user(firm_id));

grant select on public.calls, public.emails to authenticated;
grant select, insert on public.calls, public.emails to service_role;
