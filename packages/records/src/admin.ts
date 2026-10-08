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
    .insert({ firm_id: i.firmId, user_id: userId, role: firmRole.parse(i.role) });
  if (member.error !== null) {
    // Do not leave a login with no firm behind.
    await admin.auth.admin.deleteUser(userId);
    return fromPostgrest(member.error);
  }
  return ok({ userId, firmId: i.firmId, role: i.role });
}
