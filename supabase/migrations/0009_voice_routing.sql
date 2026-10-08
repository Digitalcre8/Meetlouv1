-- 0009 what the inbound voice webhook needs: who to ring, an honest record of withheld
-- numbers, and audit entries for calls that reach no matter.

-- The fee earner's own number, dialled when a call to the matter's line is answered.
alter table public.firm_users
  add column phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  add constraint firm_users_id_firm_id_key unique (id, firm_id);

-- The fee earner responsible for the matter. Composite key: they must belong to the same firm.
alter table public.matters
  add column responsible_fee_earner_id uuid,
  add constraint matters_responsible_fee_earner_fkey
    foreign key (responsible_fee_earner_id, firm_id) references public.firm_users (id, firm_id);

grant insert (responsible_fee_earner_id) on public.matters to authenticated;
grant update (responsible_fee_earner_id) on public.matters to authenticated;

-- A caller who withholds their number has no from_e164. Null says so; inventing a value
-- would put a false fact on the file.
alter table public.calls alter column from_e164 drop not null;

-- Audit entries may now carry the Twilio call SID, the line dialled and a reason code, still
-- no content. (The caller's number is personal data and is not recorded here.)
alter table public.audit_log drop constraint audit_log_detail_check;
alter table public.audit_log add constraint audit_log_detail_check
  check (detail - array['changed_columns', 'counts', 'call_sid', 'to_e164', 'reason'] = '{}'::jsonb);

-- A redelivered webhook for the same unrouted call writes one audit row, not several.
create unique index audit_log_call_unrouted_key
  on public.audit_log ((detail ->> 'call_sid')) where action = 'call.unrouted';

-- Written by the voice webhook (service role only) when a call reaches a number that routes to
-- no matter. Answered politely, and recorded so it is never a silent failure.
create function public.record_unrouted_call(p_call_sid text, p_to_e164 text, p_reason text)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.audit_log (firm_id, action, object_kind, detail)
  values (null, 'call.unrouted', 'call',
          jsonb_build_object('call_sid', p_call_sid, 'to_e164', p_to_e164, 'reason', p_reason))
  on conflict ((detail ->> 'call_sid')) where action = 'call.unrouted' do nothing;
$$;
revoke all on function public.record_unrouted_call(text, text, text) from public;
grant execute on function public.record_unrouted_call(text, text, text) to service_role;
