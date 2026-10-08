import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveOutput } from '@meetlou/records';
import { localEnv, seedArmstrong, serviceClient, signedInClient } from '@meetlou/harness';
import type { SeedResult } from '@meetlou/harness';
import { transcribeRecording } from '@meetlou/pipeline';
import {
  EVIDENCE_BUCKETS,
  SupabaseObjectStore,
  SupabaseRetentionDb,
  runRetention,
} from '@meetlou/retention';
import { pool, randomE164, run, seedFirm } from './db';
import { depsFor, recordedCall } from './pipeline-helpers';

/**
 * Retention, legal hold and erasure. Time travel is done by moving a matter's closure into the
 * past in the database: the job reads the database clock, so there is no clock to inject and
 * nothing the job is told that could make it erase early.
 */
const env = localEnv();
const owner = { role: 'owner' } as const;
const service = { role: 'service_role' } as const;
const admin = serviceClient(env);
const PASSWORD = 'a-long-enough-password';
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } } as const;
const retentionClient = createClient(env.apiUrl, env.retentionKey, clientOptions);
const retentionDb = new SupabaseRetentionDb(retentionClient);
const objects = new SupabaseObjectStore(admin);
/** One pass of the job. A failure is a test failure, with the reason (identifiers and outcomes only). */
async function runJob() {
  const failures: string[] = [];
  const summary = await runRetention({
    db: retentionDb,
    objects,
    log: {
      info: () => undefined,
      error: (event, fields) => {
        failures.push(JSON.stringify({ event, ...fields }));
      },
    },
  });
  if (summary.failed > 0) throw new Error(`the job failed: ${failures.join(' | ')}`);
  return summary;
}

type Db = Awaited<ReturnType<typeof signedInClient>>;
let seed: SeedResult;
let feeEarner: Db;
let colp: Db;
let colpUserId = '';

function idOf(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'id' in data && typeof data.id === 'string')
    return data.id;
  throw new Error('row has no id');
}

const count = async (sql: string, params: unknown[] = []) =>
  Number((await run<{ n: string }>(owner, sql, params))[0]?.n ?? 0);
const exists = async (matterId: string) =>
  (await count(`select count(*) n from matters where id = $1`, [matterId])) === 1;

/** Move a matter's closure into the past, the way an operator would correct a record. */
async function closeMatter(matterId: string, ago: string): Promise<void> {
  await run(
    owner,
    `update matters set closed_at = now() - $2::interval where id = $1`,
    [matterId, ago],
    { commit: true },
  );
  await run(owner, `update matters set closed_recorded_at = closed_at where id = $1`, [matterId], {
    commit: true,
  });
}

async function newLogin(label: string, role: 'colp' | 'fee_earner') {
  const email = `${label}-${randomUUID()}@example.org`;
  const created = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (created.error !== null) throw new Error(created.error.message);
  await run(
    service,
    `insert into firm_users (firm_id, user_id, role) values ($1, $2, $3)`,
    [seed.firm.id, created.data.user.id, role],
    { commit: true },
  );
  return { userId: created.data.user.id, db: await signedInClient(env, email, PASSWORD) };
}

async function setPolicy(years: number): Promise<void> {
  const inserted = await colp
    .from('retention_policies')
    .insert({ firm_id: seed.firm.id, retention_period_years: years, set_by: colpUserId });
  if (inserted.error !== null) throw new Error(inserted.error.message);
}

/** A matter with a row in every kind of table and an object in every evidence bucket. */
interface Populated {
  matterId: string;
  firmId: string;
  markers: string[];
}
async function populate(): Promise<Populated> {
  const base = await recordedCall(env, seed);
  const tag = randomBytes(4).toString('hex');
  const address = `${tag} Quillfeather Gardens, Hushwick`;
  const clientName = `Zebediah Quillfeather ${tag}`;
  const clientEmail = `zebediah-${tag}@example.org`;
  const clientPhone = randomE164();
  const subject = `Sealed lorry ${tag}`;
  await run(
    owner,
    `update matters set property_address = $2 where id = $1`,
    [base.matterId, address],
    { commit: true },
  );
  await run(
    owner,
    `insert into participants (firm_id, matter_id, access, role, display_name, phone_e164, email)
     values ($1, $2, 'client', 'client', $3, $4, $5)`,
    [seed.firm.id, base.matterId, clientName, clientPhone, clientEmail],
    { commit: true },
  );

  const job = await depsFor(env).store.getRecording(base.recordingId);
  if (job === null) throw new Error('no recording job');
  const outcome = await transcribeRecording(depsFor(env), job);
  if (outcome.status !== 'summarised') throw new Error(JSON.stringify(outcome));
  const approved = await approveOutput(feeEarner, outcome.outputId);
  if (!approved.ok) throw new Error(approved.error.message);

  const prefix = `${seed.firm.id}/${base.matterId}`;
  const rawPath = `${prefix}/${tag}/raw.eml`;
  const attachmentSha = randomBytes(32).toString('hex');
  const attachmentPath = `${prefix}/${attachmentSha}`;
  const up1 = await admin.storage
    .from('emails')
    .upload(rawPath, new TextEncoder().encode(`Subject: ${subject}\r\n\r\nbody`), {
      contentType: 'message/rfc822',
    });
  const up2 = await admin.storage
    .from('attachments')
    .upload(attachmentPath, new TextEncoder().encode('%PDF-1.4 fake'), {
      contentType: 'application/octet-stream',
    });
  if (up1.error !== null || up2.error !== null)
    throw new Error(`upload failed: ${up1.error?.message ?? ''} ${up2.error?.message ?? ''}`);
  const ingested = await admin.rpc('ingest_email', {
    p_matter_id: base.matterId,
    p_message_id: `${randomUUID()}@x.example.org`,
    p_message_id_synthesised: false,
    p_in_reply_to: null,
    p_references: [],
    p_from_address: clientEmail,
    p_to_addresses: [],
    p_cc_addresses: [],
    p_subject: subject,
    p_sent_at: null,
    p_raw_storage_path: rawPath,
    p_raw_sha256: 'a'.repeat(64),
    p_body_text_storage_path: null,
    p_body_html_storage_path: null,
    p_spf_result: 'pass',
    p_dkim_result: '{@example.org : pass}',
    p_attachments: [
      {
        ordinal: 0,
        filename: `TA6-${tag}.pdf`,
        content_type: 'application/pdf',
        sniffed_content_type: 'application/pdf',
        byte_length: 13,
        sha256: attachmentSha,
        storage_path: attachmentPath,
      },
    ],
  });
  if (ingested.error !== null) throw new Error(ingested.error.message);
  await run(
    owner,
    `insert into events (firm_id, matter_id, kind, visibility, occurred_at, actor_kind, summary)
     values ($1, $2, 'matter.client_update', 'client', now(), 'system', $3)`,
    [seed.firm.id, base.matterId, `Please sign the TA10 ${tag}`],
    { commit: true },
  );
  return {
    matterId: base.matterId,
    firmId: seed.firm.id,
    markers: [
      address,
      clientName,
      clientEmail,
      clientPhone,
      subject,
      `TA6-${tag}`,
      `TA10 ${tag}`,
      'searches going',
      'chase the provider',
    ],
  };
}

const TABLES = [
  'calls',
  'call_recordings',
  'transcripts',
  'generated_outputs',
  'approvals',
  'emails',
  'attachments',
  'events',
  'participants',
] as const;
const rowsOf = (matterId: string) =>
  Promise.all(
    TABLES.map((t) => count(`select count(*) n from ${t} where matter_id = $1`, [matterId])),
  );
const objectsOf = async (p: Populated) => {
  const found: string[] = [];
  for (const bucket of EVIDENCE_BUCKETS)
    found.push(...(await objects.list(bucket, `${p.firmId}/${p.matterId}`)));
  return found;
};

/** A matter with a call on it, for the rules that do not need every table. */
async function lightMatter(): Promise<string> {
  const matter = await run<{ id: string }>(
    owner,
    `insert into matters (firm_id, reference, kind, property_address)
     values ($1, $2, 'purchase', '2 Light Street, Hushwick') returning id`,
    [seed.firm.id, `LIGHT-${randomUUID()}`],
    { commit: true },
  );
  const id = matter[0]?.id ?? '';
  await run(
    owner,
    `insert into events (firm_id, matter_id, kind, visibility, occurred_at, actor_kind)
     values ($1, $2, 'matter.opened', 'firm', now(), 'system')`,
    [seed.firm.id, id],
    { commit: true },
  );
  return id;
}

/** Run SQL as the retention role itself, the way the job's functions would. */
async function asRetention(sql: string, params: unknown[] = []): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role retention_runner');
    const result = await client.query(sql, params);
    return result.rowCount ?? 0;
  } finally {
    await client.query('rollback');
    client.release();
  }
}

beforeAll(async () => {
  seed = await seedArmstrong(env);
  feeEarner = await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password);
  const c = await newLogin('colp', 'colp');
  colp = c.db;
  colpUserId = c.userId;
  await setPolicy(6);
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe('the retention period belongs to the firm, and the COLP states it', () => {
  it('a fee earner cannot state the period; the COLP can, and it is audited', async () => {
    const refused = await feeEarner
      .from('retention_policies')
      .insert({ firm_id: seed.firm.id, retention_period_years: 1, set_by: seed.feeEarner.userId });
    expect(refused.error).not.toBeNull();
    const audited = await count(
      `select count(*) n from audit_log where firm_id = $1 and action = 'retention_policy.set' and actor_id = $2`,
      [seed.firm.id, colpUserId],
    );
    expect(audited).toBeGreaterThanOrEqual(1);
  });

  it('a firm that has stated no period has nothing erased, however old its matters are', async () => {
    const other = await seedFirm('no-period');
    await closeMatter(other.matterId, '40 years');
    await runJob();
    expect(await exists(other.matterId)).toBe(true);
  });

  it('a fee earner cannot override the period on a matter; the COLP can, and a longer one protects it', async () => {
    const matterId = await lightMatter();
    await closeMatter(matterId, '7 years');
    const asFeeEarner = await feeEarner.from('matter_retention_overrides').insert({
      firm_id: seed.firm.id,
      matter_id: matterId,
      retention_period_years: 1,
      reason_code: 'other',
      set_by: seed.feeEarner.userId,
    });
    expect(asFeeEarner.error).not.toBeNull();

    const longer = await colp.from('matter_retention_overrides').insert({
      firm_id: seed.firm.id,
      matter_id: matterId,
      retention_period_years: 12,
      reason_code: 'indemnity_insurance',
      set_by: colpUserId,
    });
    expect(longer.error).toBeNull();
    await runJob();
    expect(await exists(matterId)).toBe(true);

    // A later, shorter override is what applies (the latest wins, and both stay on the file).
    const shorter = await colp.from('matter_retention_overrides').insert({
      firm_id: seed.firm.id,
      matter_id: matterId,
      retention_period_years: 2,
      reason_code: 'client_agreement',
      set_by: colpUserId,
    });
    expect(shorter.error).toBeNull();
    await runJob();
    expect(await exists(matterId)).toBe(false);
  });
});

describe('a matter past its retention period is cleared and audited', () => {
  let p: Populated;
  let auditIdsBefore: number[] = [];
  beforeAll(async () => {
    p = await populate();
    auditIdsBefore = (
      await run<{ id: string }>(owner, `select id from audit_log where firm_id = $1`, [p.firmId])
    ).map((row) => Number(row.id));
  }, 120_000);

  it('is not touched the day before it is due, and is erased the day it is due', async () => {
    const before = await rowsOf(p.matterId);
    const objectsBefore = await objectsOf(p);
    expect(before.every((n) => n > 0)).toBe(true);
    // One object per bucket: recording, transcript, raw email, attachment.
    expect(objectsBefore.length).toBeGreaterThanOrEqual(4);

    await closeMatter(p.matterId, '6 years - 1 day');
    await runJob();
    expect(await rowsOf(p.matterId)).toEqual(before);
    expect(await objectsOf(p)).toEqual(objectsBefore);

    await closeMatter(p.matterId, '6 years');
    const summary = await runJob();
    expect(summary.erased).toBeGreaterThanOrEqual(1);

    expect(await rowsOf(p.matterId)).toEqual(TABLES.map(() => 0));
    expect(await exists(p.matterId)).toBe(false);
    expect(await objectsOf(p)).toEqual([]);
  });

  it('leaves the fact of deletion on the audit log, with counts and no content', async () => {
    const entries = await run<{
      action: string;
      object_id: string;
      detail: Record<string, unknown>;
    }>(
      owner,
      `select action, object_id, detail from audit_log
        where firm_id = $1 and object_id = $2 and action in ('erasure.started', 'evidence.erased')
        order by id`,
      [p.firmId, p.matterId],
    );
    expect(entries.map((e) => e.action)).toEqual(['erasure.started', 'evidence.erased']);
    const erased = entries[1]?.detail as { reason: string; counts: Record<string, number> };
    expect(erased.reason).toBe('retention_period');
    expect(Object.keys(erased).sort()).toEqual(['counts', 'reason']);
    expect(erased.counts['calls']).toBe(1);
    expect(erased.counts['matters']).toBe(1);
    expect(Object.values(erased.counts).every((n) => Number.isInteger(n))).toBe(true);

    // Nothing the matter contained appears in any audit entry the firm has, new or old.
    const everything = JSON.stringify(
      await run(
        owner,
        `select action, object_kind, object_id, detail from audit_log where firm_id = $1`,
        [p.firmId],
      ),
    );
    for (const marker of p.markers) expect(everything).not.toContain(marker);

    const proof = await run<{
      matter_reference: string;
      basis: string;
      counts: Record<string, number>;
    }>(
      owner,
      `select r.matter_reference, r.basis, c.counts
         from erasure_runs r join erasure_run_completions c on c.erasure_run_id = r.id
        where r.matter_id = $1`,
      [p.matterId],
    );
    expect(proof).toHaveLength(1);
    expect(proof[0]?.matter_reference).toMatch(/^PIPE-/);
    expect(proof[0]?.basis).toBe('retention_period');
  });

  it('leaves the audit trail intact: every entry written before the erasure is still there', async () => {
    expect(auditIdsBefore.length).toBeGreaterThan(0);
    expect(
      await count(`select count(*) n from audit_log where id = any($1::bigint[])`, [
        auditIdsBefore,
      ]),
    ).toBe(auditIdsBefore.length);
    // The capture of this matter's own call and email is among them.
    expect(
      await count(
        `select count(*) n from audit_log where id = any($1::bigint[]) and action in ('call.captured', 'email.captured')`,
        [auditIdsBefore],
      ),
    ).toBeGreaterThanOrEqual(2);
    // And the job itself says what it did on each run.
    expect(
      await count(`select count(*) n from audit_log where action = 'retention.run'`),
    ).toBeGreaterThanOrEqual(1);
  });

  it('cannot be run twice into a second deletion: re-running finds nothing to do', async () => {
    const before = await count(
      `select count(*) n from audit_log where action = 'evidence.erased' and object_id = $1`,
      [p.matterId],
    );
    await runJob();
    expect(
      await count(
        `select count(*) n from audit_log where action = 'evidence.erased' and object_id = $1`,
        [p.matterId],
      ),
    ).toBe(before);
  });
});

describe('a closure cannot be backdated into an erasure', () => {
  it('a fee earner who closes a matter with a date years ago starts the clock today', async () => {
    const matterId = await lightMatter();
    const closed = await feeEarner
      .from('matters')
      .update({ closed_at: '2001-01-01T00:00:00Z' })
      .eq('id', matterId);
    expect(closed.error).toBeNull();
    await runJob();
    expect(await exists(matterId)).toBe(true);
    const direct = await feeEarner
      .from('matters')
      .update({ closed_recorded_at: '2001-01-01T00:00:00Z' })
      .eq('id', matterId);
    expect(direct.error).not.toBeNull();
    const asService = await run<{ closed_recorded_at: Date }>(
      service,
      `update matters set closed_recorded_at = '2001-01-01' where id = $1 returning closed_recorded_at`,
      [matterId],
    ).catch(() => []);
    // Even where the statement is allowed, the database keeps what it recorded.
    expect(asService.every((r) => r.closed_recorded_at.getUTCFullYear() > 2001)).toBe(true);
  });
});

describe('a matter on legal hold is never touched', () => {
  it('only the COLP or an admin can place a hold', async () => {
    const matterId = await lightMatter();
    const refused = await feeEarner.from('legal_holds').insert({
      firm_id: seed.firm.id,
      matter_id: matterId,
      reason_code: 'complaint',
      placed_by: seed.feeEarner.userId,
    });
    expect(refused.error).not.toBeNull();
  });

  it('is untouched even when past retention, says so once, and is erased after the hold is released', async () => {
    const p = await populate();
    const before = await rowsOf(p.matterId);
    const objectsBefore = await objectsOf(p);

    const placed = await colp
      .from('legal_holds')
      .insert({
        firm_id: seed.firm.id,
        matter_id: p.matterId,
        reason_code: 'complaint',
        placed_by: colpUserId,
      })
      .select('id')
      .single();
    expect(placed.error).toBeNull();
    const holdId = idOf(placed.data);

    await closeMatter(p.matterId, '30 years');
    const first = await runJob();
    expect(first.held).toBeGreaterThanOrEqual(1);
    await runJob();
    expect(await rowsOf(p.matterId)).toEqual(before);
    expect(await exists(p.matterId)).toBe(true);
    expect(await objectsOf(p)).toEqual(objectsBefore);
    expect(
      await count(`select count(*) n from erasure_runs where matter_id = $1`, [p.matterId]),
    ).toBe(0);
    // Said once per hold, not once per run.
    expect(
      await count(
        `select count(*) n from audit_log where action = 'retention.skipped_hold' and object_id = $1`,
        [p.matterId],
      ),
    ).toBe(1);

    const released = await colp.from('legal_hold_releases').insert({
      firm_id: seed.firm.id,
      matter_id: p.matterId,
      legal_hold_id: holdId,
      released_by: colpUserId,
    });
    expect(released.error).toBeNull();
    await runJob();
    expect(await exists(p.matterId)).toBe(false);
    expect(await objectsOf(p)).toEqual([]);
  });

  it('a hold placed after the job has begun stops the deletion, at the database', async () => {
    const matterId = await lightMatter();
    await closeMatter(matterId, '30 years');
    const begun = await retentionDb.begin(matterId);
    expect(begun.status).toBe('authorised');

    const placed = await colp.from('legal_holds').insert({
      firm_id: seed.firm.id,
      matter_id: matterId,
      reason_code: 'claim',
      placed_by: colpUserId,
    });
    expect(placed.error).toBeNull();

    // The function refuses, and so would the delete itself: the policy sees the hold.
    expect(await retentionDb.complete(matterId)).toEqual({ status: 'held' });
    expect(await exists(matterId)).toBe(true);
    expect(await asRetention(`delete from events where matter_id = $1`, [matterId])).toBe(0);
    expect(
      await count(
        `select count(*) n from audit_log where action = 'erasure.blocked' and object_id = $1`,
        [matterId],
      ),
    ).toBe(1);
    expect(
      await count(`select count(*) n from events where matter_id = $1`, [matterId]),
    ).toBeGreaterThan(0);
  });

  it('the job’s role cannot delete anything without an open erasure run, hold or no hold', async () => {
    const matterId = await lightMatter();
    await closeMatter(matterId, '30 years');
    for (const table of ['calls', 'events', 'participants', 'emails']) {
      expect(await asRetention(`delete from ${table} where matter_id = $1`, [matterId])).toBe(0);
    }
    expect(await asRetention(`delete from matters where id = $1`, [matterId])).toBe(0);
    // And never the audit log.
    await expect(
      asRetention(`delete from audit_log where firm_id = $1`, [seed.firm.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(asRetention(`truncate events`)).rejects.toThrow(/permission denied/);
  });
});

describe('an erasure request is honoured by the firm as controller', () => {
  it('only an approved request on a closed, unheld matter is acted on, and it needs no waiting', async () => {
    const approved = await lightMatter();
    const refused = await lightMatter();
    const undecided = await lightMatter();
    const open = await lightMatter();
    const held = await lightMatter();
    for (const id of [approved, refused, undecided, held]) await closeMatter(id, '1 year');

    const request = async (matterId: string) => {
      const r = await feeEarner
        .from('erasure_requests')
        .insert({ firm_id: seed.firm.id, matter_id: matterId, requested_by: seed.feeEarner.userId })
        .select('id')
        .single();
      if (r.error !== null) throw new Error(r.error.message);
      return idOf(r.data);
    };
    const decide = (
      requestId: string,
      matterId: string,
      decision: 'approved' | 'refused',
      who: Db,
      userId: string,
    ) =>
      who.from('erasure_request_decisions').insert({
        firm_id: seed.firm.id,
        matter_id: matterId,
        erasure_request_id: requestId,
        decision,
        reason_code: decision === 'approved' ? 'data_subject_request' : 'legal_obligation',
        decided_by: userId,
      });

    const approvedRequest = await request(approved);
    // The fee earner who took the request cannot decide it.
    expect(
      (await decide(approvedRequest, approved, 'approved', feeEarner, seed.feeEarner.userId)).error,
    ).not.toBeNull();
    expect(
      (await decide(approvedRequest, approved, 'approved', colp, colpUserId)).error,
    ).toBeNull();
    const refusedRequest = await request(refused);
    expect((await decide(refusedRequest, refused, 'refused', colp, colpUserId)).error).toBeNull();
    await request(undecided);
    const openRequest = await request(open);
    expect((await decide(openRequest, open, 'approved', colp, colpUserId)).error).toBeNull();
    const heldRequest = await request(held);
    expect((await decide(heldRequest, held, 'approved', colp, colpUserId)).error).toBeNull();
    expect(
      (
        await colp.from('legal_holds').insert({
          firm_id: seed.firm.id,
          matter_id: held,
          reason_code: 'regulatory',
          placed_by: colpUserId,
        })
      ).error,
    ).toBeNull();

    await runJob();
    expect(await exists(approved)).toBe(false);
    for (const id of [refused, undecided, open, held]) expect(await exists(id)).toBe(true);

    const erased = await run<{ detail: { reason: string } }>(
      owner,
      `select detail from audit_log where action = 'evidence.erased' and object_id = $1`,
      [approved],
    );
    expect(erased[0]?.detail.reason).toBe('erasure_request');
  });
});

describe('no route can trigger deletion', () => {
  const jobFunctions: [string, Record<string, unknown>][] = [
    ['retention_due', {}],
    ['begin_erasure', { p_matter_id: randomUUID() }],
    ['complete_erasure', { p_matter_id: randomUUID() }],
    ['note_retention_hold', { p_matter_id: randomUUID() }],
    ['record_retention_run', { p_examined: 0, p_erased: 0, p_held: 0, p_failed: 0 }],
  ];

  it('anon, a fee earner, the COLP and the service role cannot call any of the job’s functions', async () => {
    const anon = createClient(env.apiUrl, env.anonKey, clientOptions);
    for (const [who, client] of [
      ['anon', anon],
      ['fee earner', feeEarner],
      ['colp', colp],
      ['service role', admin],
    ] as const) {
      for (const [name, args] of jobFunctions) {
        const result = await client.rpc(name, args);
        expect(result.error, `${who} calling ${name}`).not.toBeNull();
      }
    }
  });

  it('nobody who serves a request can delete a row from any table, over the API or in SQL', async () => {
    const matterId = await lightMatter();
    await closeMatter(matterId, '30 years');
    const tables = [
      ...TABLES,
      'matters',
      'receipts',
      'audit_log',
      'legal_holds',
      'legal_hold_releases',
      'erasure_requests',
      'erasure_request_decisions',
      'erasure_runs',
      'erasure_run_completions',
      'retention_policies',
      'matter_retention_overrides',
    ];
    for (const [name, client] of [
      ['fee earner', feeEarner],
      ['colp', colp],
      ['service role', admin],
    ] as const) {
      for (const table of tables) {
        await client.from(table).delete().eq('firm_id', seed.firm.id);
        expect(await exists(matterId), `${name} deleting ${table}`).toBe(true);
      }
    }
    for (const identity of [
      service,
      { role: 'anon' } as const,
      { role: 'authenticated', userId: colpUserId } as const,
    ]) {
      for (const table of tables) {
        await expect(
          run(identity, `delete from ${table}`),
          `${identity.role} deleting ${table}`,
        ).rejects.toThrow(/permission denied|append-only/);
        await expect(run(identity, `truncate ${table}`)).rejects.toThrow(
          /permission denied|append-only/,
        );
      }
    }
    // Not even the owner can delete evidence rows outside the job.
    await expect(run(owner, `delete from events where matter_id = $1`, [matterId])).rejects.toThrow(
      /append-only/,
    );
  });

  it('the job’s own token can see no evidence and write no row; the job reaches it only through the functions', async () => {
    const seen = await retentionClient.from('calls').select('id').limit(5);
    expect(seen.data ?? []).toEqual([]);
    expect((await retentionClient.from('audit_log').select('id').limit(1)).error).not.toBeNull();
    const inserted = await retentionClient
      .from('events')
      .insert({ firm_id: seed.firm.id, kind: 'x' });
    expect(inserted.error).not.toBeNull();
  });
});
