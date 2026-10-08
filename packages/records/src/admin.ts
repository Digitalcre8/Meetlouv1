// Operator-only helpers. They need a service-role client, which bypasses RLS, so this
// entry point must never be imported by apps/web (scripts/check-guards.sh enforces it).
import type { SupabaseClient } from '@supabase/supabase-js';
import { createFeeEarnerInput, createFirmInput, err, firmRole, firmRow, ok } from '@meetlou/domain';
import type { FirmRole, FirmRow, Result } from '@meetlou/domain';
import { z } from 'zod';
import { fromPostgrest, invalidInput } from './errors';
import type { RecordError } from './errors';

export async function createFirm(
  admin: SupabaseClient,
  input: unknown,
): Promise<Result<FirmRow, RecordError>> {
  const parsed = createFirmInput.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);

  const inserted = await admin
    .from('firms')
    .insert({ name: parsed.data.name, mail_domain: parsed.data.mailDomain })
    .select('id, name, mail_domain')
    .single();
  if (inserted.error !== null) return fromPostgrest(inserted.error);
  return ok(firmRow.parse(inserted.data));
}

export interface CreatedFeeEarner {
  /** firm_users.id: what a matter's responsible_fee_earner_id points at. */
  memberId: string;
  userId: string;
  firmId: string;
  role: FirmRole;
}

/**
 * Creates the login (confirmed, with a password) and attaches it to the firm. Public
 * sign-up is disabled on the auth server, so this is the only way a firm user comes to exist.
 */
export async function createFeeEarner(
  admin: SupabaseClient,
  input: unknown,
): Promise<Result<CreatedFeeEarner, RecordError>> {
  const parsed = createFeeEarnerInput.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const i = parsed.data;

  const created = await admin.auth.admin.createUser({
    email: i.email,
    password: i.password,
    email_confirm: true,
  });
  if (created.error !== null) {
    return err({ code: 'database', message: `auth: ${created.error.message}` });
  }
  const userId = z.uuid().parse(created.data.user.id);

  const member = await admin
    .from('firm_users')
    .insert({
      firm_id: i.firmId,
      user_id: userId,
      role: firmRole.parse(i.role),
      ...(i.phoneE164 === undefined ? {} : { phone_e164: i.phoneE164 }),
    })
    .select('id')
    .single();
  if (member.error !== null) {
    // Do not leave a login with no firm behind.
    await admin.auth.admin.deleteUser(userId);
    return fromPostgrest(member.error);
  }
  return ok({
    memberId: z.uuid().parse(member.data.id),
    userId,
    firmId: i.firmId,
    role: i.role,
  });
}

export interface InboundEmailKey {
  keyId: string;
  /** Shown once. Only its SHA-256 is stored. */
  secret: string;
  /** Append to the function URL: https://<project>.supabase.co/functions/v1/sendgrid-inbound + this. */
  urlPath: string;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(value: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  );
}

/** Register a secret you already hold (the harness's fixed local one). Prefer createInboundEmailKey. */
export async function registerInboundEmailKey(
  admin: SupabaseClient,
  firmId: string,
  secret: string,
): Promise<Result<InboundEmailKey, RecordError>> {
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    return err({ code: 'invalid_input', message: 'invalid: secret' });
  }
  const registered = await admin.rpc('register_inbound_email_key', {
    p_firm_id: firmId,
    p_secret_sha256: await sha256Hex(secret),
  });
  if (registered.error !== null) return fromPostgrest(registered.error);
  const keyId = z.uuid().parse(registered.data);
  return ok({ keyId, secret, urlPath: `/${keyId}/${secret}` });
}

/**
 * Mint a new Inbound Parse URL credential for a firm: 256 random bits, returned once. Give
 * `urlPath` to whoever configures the SendGrid hostname, and treat it like a password.
 */
export async function createInboundEmailKey(
  admin: SupabaseClient,
  firmId: string,
): Promise<Result<InboundEmailKey, RecordError>> {
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  return registerInboundEmailKey(admin, firmId, secret);
}
