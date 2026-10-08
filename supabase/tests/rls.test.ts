import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addParticipant, ids, pool, run, seedFirm } from './db';
import type { Identity } from './db';

type Seed = Awaited<ReturnType<typeof seedFirm>>;

let a: Seed;
let b: Seed;
let asA: Identity;
let asB: Identity;
let asClient: Identity;
let asChain: Identity;

beforeAll(async () => {
  a = await seedFirm('A');
  b = await seedFirm('B');
  asA = { role: 'authenticated', userId: a.feeEarnerId };
  asB = { role: 'authenticated', userId: b.feeEarnerId };
  asClient = { role: 'authenticated', userId: await addParticipant(a, 'client', 'client-on-a') };
  asChain = { role: 'authenticated', userId: await addParticipant(a, 'chain', 'chain-on-a') };
});

afterAll(async () => {
  await pool.end();
});

describe('firm isolation', () => {
  it('a user of firm A sees their own matter, call, email and events', async () => {
    expect(await ids(asA, 'matters')).toContain(a.matterId);
    expect(await ids(asA, 'calls')).toContain(a.callId);
    expect(await ids(asA, 'emails')).toContain(a.emailId);
    expect(await ids(asA, 'events')).toEqual(expect.arrayContaining(Object.values(a.eventIds)));
  });

  it("a user of firm A cannot read firm B's matters", async () => {
    expect(await ids(asA, 'matters')).not.toContain(b.matterId);
    expect(await ids(asA, 'matters', 'id = $1', [b.matterId])).toEqual([]);
  });

  it("a user of firm A cannot read firm B's calls", async () => {
    expect(await ids(asA, 'calls', 'id = $1', [b.callId])).toEqual([]);
    expect(await ids(asA, 'calls', 'matter_id = $1', [b.matterId])).toEqual([]);
  });

  it("a user of firm A cannot read firm B's emails", async () => {
    expect(await ids(asA, 'emails', 'id = $1', [b.emailId])).toEqual([]);
  });

  it("a user of firm A cannot read firm B's events", async () => {
    expect(await ids(asA, 'events', 'matter_id = $1', [b.matterId])).toEqual([]);
  });

  it("a user of firm A cannot read firm B's attachments, participants, receipts or firm", async () => {
    expect(await ids(asA, 'attachments', 'matter_id = $1', [b.matterId])).toEqual([]);
    expect(await ids(asA, 'participants', 'matter_id = $1', [b.matterId])).toEqual([]);
    expect(await ids(asA, 'firms', 'id = $1', [b.firmId])).toEqual([]);
    expect(await ids(asA, 'firm_users', 'firm_id = $1', [b.firmId])).toEqual([]);
  });

  it('the isolation holds in both directions', async () => {
    expect(await ids(asB, 'matters', 'id = $1', [a.matterId])).toEqual([]);
    expect(await ids(asB, 'events', 'matter_id = $1', [a.matterId])).toEqual([]);
  });

  it("a user of firm A cannot write into firm B's matter", async () => {
    await expect(
      run(
        asA,
        `insert into events (firm_id, matter_id, kind, occurred_at, actor_kind, actor_id)
         values ($1, $2, 'note.added', now(), 'fee_earner', $3)`,
        [b.firmId, b.matterId, a.feeEarnerId],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      run(asA, `update matters set property_address = 'x' where id = $1 returning id`, [
        b.matterId,
      ]),
    ).resolves.toEqual([]);
  });

  it('a user of firm A cannot mark firm B events as read', async () => {
    await expect(
      run(
        asA,
        `insert into receipts (firm_id, matter_id, event_id, user_id) values ($1, $2, $3, $4)`,
        [b.firmId, b.matterId, b.eventIds.chain, a.feeEarnerId],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('anon reads nothing at all', async () => {
    const anon: Identity = { role: 'anon' };
    for (const table of ['matters', 'calls', 'emails', 'events', 'attachments', 'audit_log']) {
      await expect(run(anon, `select id from ${table}`)).rejects.toThrow(/permission denied/);
    }
  });
});

describe('participants', () => {
  it('cannot read firm-visibility events', async () => {
    expect(await ids(asClient, 'events', 'id = $1', [a.eventIds.firm])).toEqual([]);
    expect(await ids(asChain, 'events', 'id = $1', [a.eventIds.firm])).toEqual([]);
    expect(await ids(asClient, 'events', "visibility = 'firm'")).toEqual([]);
    expect(await ids(asChain, 'events', "visibility = 'firm'")).toEqual([]);
  });

  it('a client participant sees client and chain events on their own matter', async () => {
    const seen = await ids(asClient, 'events');
    expect(seen.sort()).toEqual(
      [a.eventIds.client, a.eventIds.chain, a.eventIds.documentShared].sort(),
    );
  });

  it('a chain participant sees chain events only', async () => {
    expect(await ids(asChain, 'events')).toEqual([a.eventIds.chain]);
  });

  it("cannot see another firm's events even where the visibility matches", async () => {
    expect(await ids(asClient, 'events', 'matter_id = $1', [b.matterId])).toEqual([]);
    expect(await ids(asChain, 'events', 'matter_id = $1', [b.matterId])).toEqual([]);
  });

  it('cannot read calls, emails or the matter itself', async () => {
    for (const who of [asClient, asChain]) {
      expect(await ids(who, 'calls')).toEqual([]);
      expect(await ids(who, 'emails')).toEqual([]);
      expect(await ids(who, 'matters')).toEqual([]);
    }
  });

  it('can see only their own participant row', async () => {
    expect(await ids(asClient, 'participants')).toHaveLength(1);
    expect(await ids(asChain, 'participants')).toHaveLength(1);
  });

  it('cannot write events, matters or participants', async () => {
    await expect(
      run(
        asClient,
        `insert into events (firm_id, matter_id, kind, occurred_at, actor_kind, actor_id)
         values ($1, $2, 'note.added', now(), 'participant', $3)`,
        [a.firmId, a.matterId, (asClient as { userId: string }).userId],
      ),
    ).rejects.toThrow(/permission denied|row-level security/);
    await expect(
      run(asChain, `update participants set access = 'client' returning id`),
    ).resolves.toEqual([]);
  });

  it('can mark as read an event they can see, and not one they cannot', async () => {
    const userId = (asClient as { userId: string }).userId;
    await run(
      asClient,
      `insert into receipts (firm_id, matter_id, event_id, user_id) values ($1, $2, $3, $4)`,
      [a.firmId, a.matterId, a.eventIds.client, userId],
    );
    await expect(
      run(
        asClient,
        `insert into receipts (firm_id, matter_id, event_id, user_id) values ($1, $2, $3, $4)`,
        [a.firmId, a.matterId, a.eventIds.firm, userId],
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('documents', () => {
  it('a chain participant cannot read attachments', async () => {
    expect(await ids(asChain, 'attachments')).toEqual([]);
    expect(await ids(asChain, 'attachments', 'id = $1', [a.attachmentId])).toEqual([]);
  });

  it('a chain participant still cannot read a document that a chain-visibility event is about', async () => {
    const attachmentId = a.attachmentId;
    await run(
      { role: 'service_role' },
      `insert into events (firm_id, matter_id, kind, visibility, subject_kind, subject_id,
                           occurred_at, actor_kind)
       values ($1, $2, 'document.noted', 'chain', 'attachment', $3, now(), 'system')`,
      [a.firmId, a.matterId, attachmentId],
      { commit: true },
    );
    expect(await ids(asChain, 'events', "kind = 'document.noted'")).toHaveLength(1);
    expect(await ids(asChain, 'attachments')).toEqual([]);
  });

  it('a client participant reads a document only once it has been shared with them', async () => {
    expect(await ids(asClient, 'attachments')).toEqual([a.attachmentId]);

    // A second, unshared document on the same matter stays invisible to the client.
    const unsharedEmail = await run<{ id: string }>(
      { role: 'service_role' },
      `insert into emails (firm_id, matter_id, message_id, from_address, raw_storage_path, raw_sha256)
       values ($1, $2, 'unshared@example.org', 'x@example.org', $4, $3) returning id`,
      [a.firmId, a.matterId, 'c'.repeat(64), `${a.firmId}/${a.matterId}/unshared`],
      { commit: true },
    );
    const emailId = unsharedEmail[0]?.id;
    expect(emailId).toBeDefined();
    const unshared = await run<{ id: string }>(
      { role: 'service_role' },
      `insert into attachments (firm_id, matter_id, email_id, ordinal, filename, content_type,
                                byte_length, sha256, storage_path)
       values ($1, $2, $3, 0, 'private.pdf', 'application/pdf', 1, $4, $5) returning id`,
      [a.firmId, a.matterId, emailId, 'd'.repeat(64), `${a.firmId}/${a.matterId}/private`],
      { commit: true },
    );
    const unsharedId = unshared[0]?.id;
    expect(await ids(asClient, 'attachments')).not.toContain(unsharedId);
    expect(await ids(asA, 'attachments')).toContain(unsharedId);
  });

  it('the firm reads every document on its own matters', async () => {
    expect(await ids(asA, 'attachments')).toContain(a.attachmentId);
  });
});

describe('service role', () => {
  it('bypasses RLS, which is why it must never reach a browser', async () => {
    const all = await ids({ role: 'service_role' }, 'matters');
    expect(all).toEqual(expect.arrayContaining([a.matterId, b.matterId]));
  });
});
