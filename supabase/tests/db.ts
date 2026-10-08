import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { QueryResultRow } from 'pg';

const url =
  process.env['MEETLOU_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export const pool = new pg.Pool({ connectionString: url, max: 4 });

/** Who is making the query. `owner` is the migration/superuser connection itself. */
export type Identity =
  | { role: 'owner' }
  | { role: 'service_role' }
  | { role: 'anon' }
  | { role: 'authenticated'; userId: string };

interface RunOptions {
  /** Commit instead of rolling back. Only used to seed. */
  commit?: boolean;
}

/**
 * Run one statement as an identity, the way PostgREST would: switch to the API role and set
 * the JWT claims that auth.uid() reads. Rolled back unless `commit` is set, so a failing or
 * mutating probe never leaks into another test.
 */
export async function run<R extends QueryResultRow = Record<string, unknown>>(
  who: Identity,
  sql: string,
  params: unknown[] = [],
  options: RunOptions = {},
): Promise<R[]> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (who.role !== 'owner') {
      await client.query(`set local role ${who.role}`);
    }
    if (who.role === 'authenticated') {
      const claims = JSON.stringify({ sub: who.userId, role: 'authenticated' });
      await client.query(
        `select set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [who.userId, claims],
      );
    }
    const result = await client.query<R>(sql, params);
    await client.query(options.commit === true ? 'commit' : 'rollback');
    return result.rows;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const service: Identity = { role: 'service_role' };

export function randomE164(): string {
  return `+447${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

export function randomCallSid(): string {
  return `CA${randomBytes(16).toString('hex')}`;
}

export async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  await run(
    { role: 'owner' },
    `insert into auth.users (id, aud, role, email) values ($1, 'authenticated', 'authenticated', $2)`,
    [id, `${label}-${id}@example.org`],
    { commit: true },
  );
  return id;
}

interface FirmSeed {
  firmId: string;
  feeEarnerId: string;
  matterId: string;
  inboundSlug: string;
  lineE164: string;
  callId: string;
  emailId: string;
  attachmentId: string;
  eventIds: { firm: string; client: string; chain: string; documentShared: string };
}

async function insertOne(sql: string, params: unknown[]): Promise<string> {
  const rows = await run<{ id: string }>(service, sql, params, { commit: true });
  const row = rows[0];
  if (row === undefined) throw new Error('insert returned no row');
  return row.id;
}

/** A firm with a fee earner, one matter, and one of everything on it. */
export async function seedFirm(label: string): Promise<FirmSeed> {
  const feeEarnerId = await createUser(`fee-earner-${label}`);
  const firmId = await insertOne(`insert into firms (name) values ($1) returning id`, [
    `Firm ${label}`,
  ]);
  await run(
    service,
    `insert into firm_users (firm_id, user_id, role) values ($1, $2, 'fee_earner')`,
    [firmId, feeEarnerId],
    { commit: true },
  );
  const lineE164 = randomE164();
  const matter = (
    await run<{ id: string; inbound_slug: string }>(
      service,
      `insert into matters (firm_id, reference, kind, property_address, line_e164)
       values ($1, $2, 'purchase', '1 Test Street, Testville', $3) returning id, inbound_slug`,
      [firmId, `${label}-0001`, lineE164],
      { commit: true },
    )
  )[0];
  if (matter === undefined) throw new Error('matter insert returned no row');
  const matterId = matter.id;

  const callId = await insertOne(
    `insert into calls (firm_id, matter_id, call_sid, from_e164, to_e164, started_at,
                        consent_announcement_version, consent_outcome, consent_given_at)
     values ($1, $2, $3, $4, $5, now(), 'v1', 'given', now()) returning id`,
    [firmId, matterId, randomCallSid(), randomE164(), lineE164],
  );
  const emailId = await insertOne(
    `insert into emails (firm_id, matter_id, message_id, from_address, subject,
                         raw_storage_path, raw_sha256)
     values ($1, $2, $3, 'sender@example.org', 'Subject', 'emails/x/raw.eml', $4) returning id`,
    [firmId, matterId, `${randomUUID()}@example.org`, 'a'.repeat(64)],
  );
  const attachmentId = await insertOne(
    `insert into attachments (firm_id, matter_id, email_id, ordinal, filename, content_type,
                              byte_length, sha256, storage_path)
     values ($1, $2, $3, 0, 'TA6.pdf', 'application/pdf', 10, $4, 'attachments/x') returning id`,
    [firmId, matterId, emailId, 'b'.repeat(64)],
  );

  const event = (kind: string, visibility: string, subject?: { kind: string; id: string }) =>
    insertOne(
      `insert into events (firm_id, matter_id, kind, visibility, subject_kind, subject_id,
                           occurred_at, actor_kind)
       values ($1, $2, $3, $4, $5, $6, now(), 'system') returning id`,
      [firmId, matterId, kind, visibility, subject?.kind ?? null, subject?.id ?? null],
    );

  return {
    firmId,
    feeEarnerId,
    matterId,
    inboundSlug: matter.inbound_slug,
    lineE164,
    callId,
    emailId,
    attachmentId,
    eventIds: {
      // Written by the trigger on calls, not by hand: every capture writes its own event.
      firm: await insertOne(
        `select id from events where subject_kind = 'call' and subject_id = $1 and kind = 'call.received'`,
        [callId],
      ),
      client: await event('email.noted', 'client', { kind: 'email', id: emailId }),
      chain: await event('matter.exchanged', 'chain'),
      // The fee earner has shared the TA6 with the client; the chain is told only that
      // a document exists, which must not unlock the document itself.
      documentShared: await event('document.shared', 'client', {
        kind: 'attachment',
        id: attachmentId,
      }),
    },
  };
}

export async function addParticipant(
  seed: FirmSeed,
  access: 'client' | 'chain',
  label: string,
): Promise<string> {
  const userId = await createUser(label);
  await run(
    service,
    `insert into participants (firm_id, matter_id, user_id, access, role, display_name)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      seed.firmId,
      seed.matterId,
      userId,
      access,
      access === 'client' ? 'client' : 'estate_agent',
      label,
    ],
    { commit: true },
  );
  return userId;
}

export async function ids(
  who: Identity,
  table: string,
  where = 'true',
  params: unknown[] = [],
): Promise<string[]> {
  const rows = await run<{ id: string }>(
    who,
    `select id::text from ${table} where ${where}`,
    params,
  );
  return rows.map((r) => r.id);
}
