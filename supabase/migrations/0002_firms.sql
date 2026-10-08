-- 0002 firms and firm_users, with the helpers every later policy leans on.

create table public.firms (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  created_at timestamptz not null default now()
);

create table public.firm_users (
  id         uuid primary key default gen_random_uuid(),
  firm_id    uuid not null references public.firms (id),
  user_id    uuid not null references auth.users (id),
  role       text not null check (role in ('fee_earner', 'colp', 'admin')),
  created_at timestamptz not null default now(),
  unique (firm_id, user_id)
);
create index firm_users_user_id_idx on public.firm_users (user_id);

-- SECURITY DEFINER so the lookup is not itself subject to firm_users' RLS (no recursion).
-- The owner has BYPASSRLS on Supabase. search_path is pinned so it cannot be hijacked.
create function app.is_firm_user(p_firm_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.firm_users fu
    where fu.firm_id = p_firm_id and fu.user_id = auth.uid()
  );
$$;

create function app.has_firm_role(p_firm_id uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.firm_users fu
    where fu.firm_id = p_firm_id and fu.user_id = auth.uid() and fu.role = any (p_roles)
  );
$$;

revoke all on function app.is_firm_user(uuid), app.has_firm_role(uuid, text[]) from public;
grant execute on function app.is_firm_user(uuid), app.has_firm_role(uuid, text[]) to authenticated, service_role;

alter table public.firms enable row level security;
alter table public.firms force row level security;
alter table public.firm_users enable row level security;
alter table public.firm_users force row level security;

-- A member sees their own firm.
create policy firms_select_member on public.firms
  for select to authenticated
  using (app.is_firm_user(id));

-- A member sees the membership list of their own firm.
create policy firm_users_select_member on public.firm_users
  for select to authenticated
  using (app.is_firm_user(firm_id));

-- Firms and memberships are provisioned by the operator (service role), never from the browser.
grant select on public.firms, public.firm_users to authenticated;
grant select, insert, update on public.firms, public.firm_users to service_role;
