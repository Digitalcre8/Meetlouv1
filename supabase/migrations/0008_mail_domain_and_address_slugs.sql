-- 0008 firm mail domain; inbound_slug now built from the property address.

-- The domain under which this firm's matter addresses live: <inbound_slug>@<mail_domain>.
-- Nullable only so the migration can run over existing rows; the application always sets it.
alter table public.firms
  add column mail_domain text unique
    check (mail_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');

-- <address prefix>-<96 random bits as 24 hex chars>
--   prefix: the first line of the address (up to the first comma), lower-cased, letters and
--           digits only, at most 30 characters, e.g. '14 Meadow Road, Sale M33 2QX' -> '14meadowroad'.
--   suffix: gen_random_bytes(12), a CSPRNG. 2^96 possibilities, so guessing another matter's
--           address is not a threat even when the prefix is known.
-- The prefix is only for humans; the suffix is the security property.
drop function app.make_inbound_slug(text);
create function app.make_inbound_slug(p_property_address text) returns text
language sql volatile set search_path = ''
as $$
  select coalesce(
           nullif(left(regexp_replace(lower(split_part(p_property_address, ',', 1)), '[^a-z0-9]', '', 'g'), 30), ''),
           'matter'
         )
         || '-' || encode(extensions.gen_random_bytes(12), 'hex');
$$;

create or replace function app.matters_before_write() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.inbound_slug := app.make_inbound_slug(new.property_address);
  else
    if new.id is distinct from old.id
       or new.firm_id is distinct from old.firm_id
       or new.inbound_slug is distinct from old.inbound_slug then
      raise exception 'matters.id, firm_id and inbound_slug are immutable'
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;
