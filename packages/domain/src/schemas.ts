import { z } from 'zod';

export const e164 = z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'must be E.164, e.g. +447700900123');

export const mailDomain = z
  .string()
  .toLowerCase()
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    'must be a domain name, e.g. matters.example.co.uk',
  );

export const matterKind = z.enum([
  'sale',
  'purchase',
  'sale_and_purchase',
  'remortgage',
  'transfer_of_equity',
]);
export type MatterKind = z.infer<typeof matterKind>;

export const firmRole = z.enum(['fee_earner', 'colp', 'admin']);
export type FirmRole = z.infer<typeof firmRole>;

/** What a participant may see: the client, or the rest of the chain. */
export const participantAccess = z.enum(['client', 'chain']);
export type ParticipantAccess = z.infer<typeof participantAccess>;

export const participantRole = z.enum([
  'client',
  'other_side_client',
  'other_side_representative',
  'estate_agent',
  'lender',
  'mortgage_broker',
  'other',
]);
export type ParticipantRole = z.infer<typeof participantRole>;

const nonEmpty = z.string().trim().min(1);
const uuid = z.uuid();

export const createFirmInput = z.object({ name: nonEmpty, mailDomain });
export type CreateFirmInput = z.infer<typeof createFirmInput>;

export const createFeeEarnerInput = z.object({
  firmId: uuid,
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(12),
  role: firmRole.default('fee_earner'),
  phoneE164: e164.optional(),
});
export type CreateFeeEarnerInput = z.input<typeof createFeeEarnerInput>;

export const createMatterInput = z.object({
  firmId: uuid,
  reference: nonEmpty,
  kind: matterKind,
  propertyAddress: nonEmpty,
  lineE164: e164.optional(),
  responsibleFeeEarnerId: uuid.optional(),
});
export type CreateMatterInput = z.infer<typeof createMatterInput>;

export const createParticipantInput = z.object({
  firmId: uuid,
  matterId: uuid,
  displayName: nonEmpty,
  access: participantAccess,
  role: participantRole,
  phoneE164: e164.optional(),
  email: z.string().trim().toLowerCase().pipe(z.email()).optional(),
});
export type CreateParticipantInput = z.infer<typeof createParticipantInput>;

export const firmRow = z.object({
  id: uuid,
  name: z.string(),
  mail_domain: z.string().nullable(),
});
export type FirmRow = z.infer<typeof firmRow>;

export const matterRow = z.object({
  id: uuid,
  firm_id: uuid,
  reference: z.string(),
  kind: matterKind,
  property_address: z.string(),
  inbound_slug: z.string(),
  line_e164: z.string().nullable(),
  responsible_fee_earner_id: uuid.nullable(),
});
export type MatterRow = z.infer<typeof matterRow>;

export const participantRow = z.object({
  id: uuid,
  firm_id: uuid,
  matter_id: uuid,
  user_id: uuid.nullable(),
  access: participantAccess,
  role: participantRole,
  display_name: z.string(),
});
export type ParticipantRow = z.infer<typeof participantRow>;
