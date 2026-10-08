// Safe to import anywhere on the server, including the web app: these helpers work through
// whatever client they are given, so a fee earner's session client is bound by RLS.
// Anything that needs the service role lives in './admin' and must never be imported by
// apps/web.
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createMatterInput,
  createParticipantInput,
  err,
  firmRow,
  firmRole,
  inboundAddress,
  matterRow,
  ok,
  participantRow,
} from '@meetlou/domain';
import type {
  CreateMatterInput,
  CreateParticipantInput,
  FirmRow,
  FirmRole,
  MatterRow,
  ParticipantRow,
  Result,
} from '@meetlou/domain';
import { z } from 'zod';
import { fromPostgrest, invalidInput } from './errors';
import type { RecordError } from './errors';

export type { RecordError, RecordErrorCode } from './errors';

const MATTER_COLUMNS = 'id, firm_id, reference, kind, property_address, inbound_slug, line_e164';
const PARTICIPANT_COLUMNS = 'id, firm_id, matter_id, user_id, access, role, display_name';

export interface SessionFirm {
  firm: FirmRow;
  role: FirmRole;
}

/** The firm the signed-in user belongs to, or null if they have no firm (or no session). */
export async function getSessionFirm(
  db: SupabaseClient,
): Promise<Result<SessionFirm | null, RecordError>> {
  const membership = await db
    .from('firm_users')
    .select('firm_id, role')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (membership.error !== null) return fromPostgrest(membership.error);
  if (membership.data === null) return ok(null);

  const parsed = z.object({ firm_id: z.uuid(), role: firmRole }).parse(membership.data);
  const firm = await db
    .from('firms')
    .select('id, name, mail_domain')
    .eq('id', parsed.firm_id)
    .single();
  if (firm.error !== null) return fromPostgrest(firm.error);
  return ok({ firm: firmRow.parse(firm.data), role: parsed.role });
}

export interface CreatedMatter {
  matter: MatterRow;
  /** Where mail for this matter is addressed, or null if the firm has no mail domain yet. */
  inboundAddress: string | null;
}

export async function createMatter(
  db: SupabaseClient,
  input: unknown,
): Promise<Result<CreatedMatter, RecordError>> {
  const parsed = createMatterInput.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const i: CreateMatterInput = parsed.data;

  const firm = await db.from('firms').select('mail_domain').eq('id', i.firmId).maybeSingle();
  if (firm.error !== null) return fromPostgrest(firm.error);
  if (firm.data === null) {
    return err({ code: 'not_permitted', message: 'firm not found or not visible to this user' });
  }

  // inbound_slug is deliberately not sent: the database generates it and ignores any value.
  const inserted = await db
    .from('matters')
    .insert({
      firm_id: i.firmId,
      reference: i.reference,
      kind: i.kind,
      property_address: i.propertyAddress,
      ...(i.lineE164 === undefined ? {} : { line_e164: i.lineE164 }),
    })
    .select(MATTER_COLUMNS)
    .single();
  if (inserted.error !== null) return fromPostgrest(inserted.error);

  const matter = matterRow.parse(inserted.data);
  const domain = z.object({ mail_domain: z.string().nullable() }).parse(firm.data).mail_domain;
  return ok({
    matter,
    inboundAddress: domain === null ? null : inboundAddress(matter.inbound_slug, domain),
  });
}

export async function createParticipant(
  db: SupabaseClient,
  input: unknown,
): Promise<Result<ParticipantRow, RecordError>> {
  const parsed = createParticipantInput.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const i: CreateParticipantInput = parsed.data;

  const inserted = await db
    .from('participants')
    .insert({
      firm_id: i.firmId,
      matter_id: i.matterId,
      display_name: i.displayName,
      access: i.access,
      role: i.role,
      ...(i.phoneE164 === undefined ? {} : { phone_e164: i.phoneE164 }),
      ...(i.email === undefined ? {} : { email: i.email }),
    })
    .select(PARTICIPANT_COLUMNS)
    .single();
  if (inserted.error !== null) return fromPostgrest(inserted.error);
  return ok(participantRow.parse(inserted.data));
}
