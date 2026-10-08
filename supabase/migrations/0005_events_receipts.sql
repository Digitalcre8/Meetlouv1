-- 0005 events (the shared timeline) and receipts (read receipts).

create table public.events (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null,
  matter_id     uuid not null,
  kind          text not null check (kind ~ '^[a-z_]+(\.[a-z_]+)+$'),
  -- Who may see it. Defaults to the narrowest.
  visibility    text not null default 'firm' check (visibility in ('firm', 'client', 'chain')),
  subject_kind  text check (subject_kind in ('call', 'email', 'attachment', 'matter')),
  subject_id    uuid,
  occurred_at   timestamptz not null,
  recorded_at   timestamptz not null default now(),
  actor_kind    text not null check (actor_kind in ('system', 'fee_earner', 'participant')),
  actor_id      uuid,
  -- Short, fixed-vocabulary text. Never message content.
  summary       text check (length(summary) <= 200),
  supersedes_id uuid references public.events (id),
  foreign key (matter_id, firm_id) references public.matters (id, firm_id),
  unique (id, matter_id, firm_id),
  check ((subject_kind is null) = (subject_id is null)),
  check ((actor_kind = 'system') = (actor_id is null))
);
-- System events are emitted once per subject, kind and audience.
create unique index events_subject_kind_visibility_key
  on public.events (subject_kind, subject_id, kind, visibility) where subject_id is not null;
create index events_matter_id_idx on public.events (matter_id, occurred_at);

create trigger events_append_only before update or delete on public.events
  for each row execute function app.raise_append_only();
create trigger events_no_truncate before truncate on public.events
  for each statement execute function app.raise_append_only();

-- The one place the visibility rules live.
--   firm user    : everything on their firm's matters
--   client       : client + chain events on their own matter
--   chain        : chain events on their own matter
create function app.can_see_event(p_firm_id uuid, p_matter_id uuid, p_visibility text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select app.is_firm_user(p_firm_id)
      or case app.participant_access(p_matter_id)
           when 'client' then p_visibility in ('client', 'chain')
           when 'chain'  then p_visibility = 'chain'
           else false
         end;
$$;

create function app.can_see_event_id(p_event_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.events e
    where e.id = p_event_id and app.can_see_event(e.firm_id, e.matter_id, e.visibility)
  );
$$;

revoke all on function app.can_see_event(uuid, uuid, text), app.can_see_event_id(uuid) from public;
grant execute on function app.can_see_event(uuid, uuid, text), app.can_see_event_id(uuid)
  to authenticated, service_role;

create table public.receipts (
  id        uuid primary key default gen_random_uuid(),
  firm_id   uuid not null,
  matter_id uuid not null,
  event_id  uuid not null,
  user_id   uuid not null references auth.users (id),
  read_at   timestamptz not null default now(),
  foreign key (event_id, matter_id, firm_id) references public.events (id, matter_id, firm_id),
  unique (event_id, user_id)
);
create index receipts_matter_id_idx on public.receipts (matter_id);

create trigger receipts_append_only before update or delete on public.receipts
  for each row execute function app.raise_append_only();
create trigger receipts_no_truncate before truncate on public.receipts
  for each statement execute function app.raise_append_only();

alter table public.events enable row level security;
alter table public.events force row level security;
alter table public.receipts enable row level security;
alter table public.receipts force row level security;

-- Firm: every event on its matters. Participant: only the audiences app.can_see_event allows.
create policy events_select_by_visibility on public.events
  for select to authenticated
  using (app.can_see_event(firm_id, matter_id, visibility));

-- A fee earner can add to their own firm's timeline (e.g. "document shared with client"),
-- as themselves. Everything else is written by the service role.
create policy events_insert_firm on public.events
  for insert to authenticated
  with check (
    app.has_firm_role(firm_id, array['fee_earner', 'colp', 'admin'])
    and actor_kind = 'fee_earner' and actor_id = auth.uid()
  );

-- The firm sees every receipt on its matters; anyone sees their own.
create policy receipts_select_firm_or_self on public.receipts
  for select to authenticated
  using (app.is_firm_user(firm_id) or user_id = auth.uid());

-- You can only mark as read, as yourself, an event you are allowed to see.
create policy receipts_insert_self on public.receipts
  for insert to authenticated
  with check (user_id = auth.uid() and app.can_see_event_id(event_id));

grant select on public.events, public.receipts to authenticated;
grant insert (firm_id, matter_id, kind, visibility, subject_kind, subject_id, occurred_at,
              actor_kind, actor_id, summary)
  on public.events to authenticated;
grant insert (firm_id, matter_id, event_id, user_id) on public.receipts to authenticated;
grant select, insert on public.events, public.receipts to service_role;
