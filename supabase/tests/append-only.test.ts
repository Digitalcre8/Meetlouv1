import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, randomCallSid, run, seedFirm } from './db';
import type { Identity } from './db';

type Seed = Awaited<ReturnType<typeof seedFirm>>;

let a: Seed;
let colp: Identity;
let feeEarner: Identity;
const service: Identity = { role: 'service_role' };
const owner: Identity = { role: 'owner' };

beforeAll(async () => {
  a = await seedFirm('AO');
  feeEarner = { role: 'authenticated', userId: a.feeEarnerId };
  // A COLP who may read the audit log.
  const { createUser } = await import('./db');
  const colpId = await createUser('colp');
  await run(
    service,
    `insert into firm_users (firm_id, user_id, role) values ($1, $2, 'colp')`,
    [a.firmId, colpId],
    { commit: true },
  );
  colp = { role: 'authenticated', userId: colpId };
  // A receipt, so every evidence table has a row for the row-level trigger to fire on.
  await run(
    service,
    `insert into receipts (firm_id, matter_id, event_id, user_id) values ($1, $2, $3, $4)`,
    [a.firmId, a.matterId, a.eventIds.firm, a.feeEarnerId],
    { commit: true },
  );
  // Generate audit rows to attack.
  await run(
    service,
    `update matters set property_address = '2 Test Street, Testville' where id = $1`,
    [a.matterId],
    { commit: true },
  );
});

afterAll(async () => {
  await pool.end();
});

// Two independent layers. service_role has no UPDATE/DELETE/TRUNCATE grant (privilege error);
// the owner has every privilege and is stopped only by the trigger. Either way it fails.
const everyone: [string, Identity][] = [
  ['service_role', { role: 'service_role' }],
  ['owner', { role: 'owner' }],
];
const blocked = /append-only|permission denied|cannot truncate/;

describe('audit_log', () => {
  it('records reference-data changes with identifiers and column names only', async () => {
    const rows = await run<{ action: string; detail: unknown }>(
      service,
      `select action, detail from audit_log where object_id = $1 order by id`,
      [a.matterId],
    );
    expect(rows.map((r) => r.action)).toEqual(['matters.insert', 'matters.update']);
    expect(rows[1]?.detail).toEqual({ changed_columns: ['property_address'] });
    expect(JSON.stringify(rows)).not.toContain('Test Street');
  });

  it.each(everyone)('an UPDATE of an audit_log row fails for %s', async (_name, who) => {
    await expect(run(who, `update audit_log set action = 'tampered'`)).rejects.toThrow(blocked);
  });

  it.each(everyone)('a DELETE of an audit_log row fails for %s', async (_name, who) => {
    await expect(run(who, `delete from audit_log`)).rejects.toThrow(blocked);
  });

  it.each(everyone)('a TRUNCATE of audit_log fails for %s', async (_name, who) => {
    await expect(run(who, `truncate audit_log`)).rejects.toThrow(blocked);
  });

  it('an authenticated user, even the COLP, is refused before the trigger is reached', async () => {
    for (const who of [colp, feeEarner]) {
      await expect(run(who, `update audit_log set action = 'x'`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(run(who, `delete from audit_log`)).rejects.toThrow(/permission denied/);
    }
  });

  it('the trigger alone stops the table owner, so the guard does not depend on grants', async () => {
    await expect(run(owner, `update audit_log set action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(run(owner, `delete from audit_log`)).rejects.toThrow(/append-only/);
  });

  it('has no update or delete policy, and no policy for anyone but select', async () => {
    const policies = await run<{ cmd: string; policyname: string }>(
      owner,
      `select cmd, policyname from pg_policies where schemaname = 'public' and tablename = 'audit_log'`,
    );
    expect(policies.map((p) => p.cmd)).toEqual(['SELECT']);
  });

  it('the COLP reads the firm audit log; a fee earner does not', async () => {
    const asColp = await run(colp, `select id from audit_log where firm_id = $1`, [a.firmId]);
    expect(asColp.length).toBeGreaterThan(0);
    expect(await run(feeEarner, `select id from audit_log`)).toEqual([]);
  });

  it('rejects free-form content in detail', async () => {
    await expect(
      run(
        service,
        `insert into audit_log (firm_id, action, object_kind, detail)
         values ($1, 'x', 'y', '{"body": "secret"}')`,
        [a.firmId],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('evidence tables are append-only', () => {
  const evidence: [string, string][] = [
    ['calls', `update calls set from_e164 = '+447700900999'`],
    ['emails', `update emails set subject = 'changed'`],
    ['attachments', `update attachments set filename = 'changed'`],
    ['events', `update events set summary = 'changed'`],
    ['receipts', `update receipts set read_at = now()`],
  ];

  it.each(evidence)(
    '%s cannot be updated, deleted or truncated by anyone',
    async (table, update) => {
      for (const [, who] of everyone) {
        await expect(run(who, update)).rejects.toThrow(blocked);
        await expect(run(who, `delete from ${table}`)).rejects.toThrow(blocked);
        await expect(run(who, `truncate ${table}`)).rejects.toThrow(blocked);
      }
      await expect(run(feeEarner, `delete from ${table}`)).rejects.toThrow(/permission denied/);
    },
  );
});

describe('idempotency keys', () => {
  it('calls.call_sid is unique', async () => {
    const sid = randomCallSid();
    const insert = () =>
      run(
        service,
        `insert into calls (firm_id, matter_id, call_sid, from_e164, to_e164, started_at,
                            consent_announcement_version, consent_outcome)
         values ($1, $2, $3, '+447700900001', $4, now(), 'v1', 'declined')`,
        [a.firmId, a.matterId, sid, a.lineE164],
        { commit: true },
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });

  it('calls.consent_given_at is present exactly when consent was given', async () => {
    const insert = (outcome: string, at: string | null) =>
      run(
        service,
        `insert into calls (firm_id, matter_id, call_sid, from_e164, to_e164, started_at,
                            consent_announcement_version, consent_outcome, consent_given_at)
         values ($1, $2, $3, '+447700900001', $4, now(), 'v1', $5, $6)`,
        [a.firmId, a.matterId, randomCallSid(), a.lineE164, outcome, at],
      );
    await expect(insert('given', null)).rejects.toThrow(/check constraint/);
    await expect(insert('declined', new Date().toISOString())).rejects.toThrow(/check constraint/);
  });

  it('emails.message_id is unique per matter, and cannot carry angle brackets', async () => {
    const messageId = `${randomUUID()}@example.org`;
    const insert = (id: string) =>
      run(
        service,
        `insert into emails (firm_id, matter_id, message_id, from_address, raw_storage_path, raw_sha256)
         values ($1, $2, $3, 'x@example.org', 'p', $4)`,
        [a.firmId, a.matterId, id, 'e'.repeat(64)],
        { commit: true },
      );
    await insert(messageId);
    await expect(insert(messageId)).rejects.toThrow(/duplicate key/);
    await expect(insert(`<${randomUUID()}@example.org>`)).rejects.toThrow(/check constraint/);
  });

  it('a system event is emitted once per subject, kind and audience', async () => {
    const insert = () =>
      run(
        service,
        `insert into events (firm_id, matter_id, kind, visibility, subject_kind, subject_id,
                             occurred_at, actor_kind)
         values ($1, $2, 'call.received', 'firm', 'call', $3, now(), 'system')`,
        [a.firmId, a.matterId, a.callId],
      );
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });

  it('a call cannot be filed under another firm', async () => {
    const b = await seedFirm('AOB');
    await expect(
      run(
        service,
        `insert into calls (firm_id, matter_id, call_sid, from_e164, to_e164, started_at,
                            consent_announcement_version, consent_outcome)
         values ($1, $2, $3, '+447700900001', $4, now(), 'v1', 'declined')`,
        [b.firmId, a.matterId, randomCallSid(), a.lineE164],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('matter routing identifiers', () => {
  it('inbound_slug is a readable prefix plus 96 random bits', () => {
    expect(a.inboundSlug).toMatch(/^1teststreet-[0-9a-f]{24}$/);
  });

  it('inbound_slug is generated and cannot be chosen by the caller', async () => {
    const rows = await run<{ inbound_slug: string }>(
      service,
      `insert into matters (firm_id, reference, kind, property_address, inbound_slug)
       values ($1, 'Weak Slug 1', 'sale', '3 Test Street, Testville', 'guessable-000000000000000000000000')
       returning inbound_slug`,
      [a.firmId],
      { commit: true },
    );
    expect(rows[0]?.inbound_slug).toMatch(/^3teststreet-[0-9a-f]{24}$/);
    expect(rows[0]?.inbound_slug).not.toContain('guessable');
  });

  it('inbound_slug and firm_id are immutable', async () => {
    await expect(
      run(service, `update matters set inbound_slug = 'x-000000000000000000000000' where id = $1`, [
        a.matterId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      run(feeEarner, `update matters set inbound_slug = 'x' where id = $1`, [a.matterId]),
    ).rejects.toThrow(/permission denied/);
  });

  it('inbound_slug and line_e164 are unique', async () => {
    await expect(
      run(
        service,
        `insert into matters (firm_id, reference, kind, property_address, line_e164)
         values ($1, 'Dup Line', 'sale', '4 Test Street', $2)`,
        [a.firmId, a.lineE164],
      ),
    ).rejects.toThrow(/duplicate key/);
    const unique = await run<{ indexdef: string }>(
      owner,
      `select indexdef from pg_indexes where tablename = 'matters'`,
    );
    expect(unique.some((i) => /UNIQUE.*\(inbound_slug\)/.test(i.indexdef))).toBe(true);
  });
});
