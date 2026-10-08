import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveOutput, getClientVisibleSummaries, withdrawApproval } from '@meetlou/records';
import { createFeeEarner, createFirm } from '@meetlou/records/admin';
import { localEnv, seedArmstrong, serviceClient, signedInClient } from '@meetlou/harness';
import type { SeedResult } from '@meetlou/harness';
import { resummariseCall, transcribeRecording } from '@meetlou/pipeline';
import { FakeSummariser } from '@meetlou/providers';
import { pool, run } from './db';
import { SUMMARY, depsFor, recordedCall } from './pipeline-helpers';

/**
 * Rule four: nothing a model wrote reaches a client until a fee earner has written an approval
 * row. The route a client uses reads the approval, not a flag on the summary; these tests go at
 * it as a client would (a signed-in participant over the real API) and as everyone who must not
 * be able to approve.
 */
const env = localEnv();
const owner = { role: 'owner' } as const;
const admin = serviceClient(env);
const PASSWORD = 'a-long-enough-password';
let seed: SeedResult;

async function login(label: string, firmId?: string, role: 'fee_earner' | 'colp' = 'fee_earner') {
  const email = `${label}-${randomUUID()}@example.org`;
  if (firmId === undefined) {
    const created = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (created.error !== null) throw new Error(created.error.message);
    return { userId: created.data.user.id, db: await signedInClient(env, email, PASSWORD) };
  }
  const earner = await createFeeEarner(admin, { firmId, email, password: PASSWORD, role });
  if (!earner.ok) throw new Error(earner.error.message);
  return { userId: earner.value.userId, db: await signedInClient(env, email, PASSWORD) };
}

/** A participant with a real login on a matter. */
async function participant(matterId: string, access: 'client' | 'chain') {
  const who = await login(`participant-${access}`);
  await run(
    { role: 'service_role' },
    `insert into participants (firm_id, matter_id, user_id, access, role, display_name)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      seed.firm.id,
      matterId,
      who.userId,
      access,
      access === 'client' ? 'client' : 'estate_agent',
      `${access} ${randomUUID()}`,
    ],
    { commit: true },
  );
  return who.db;
}

async function summarisedCall() {
  const call = await recordedCall(env, seed);
  await transcribeRecording(depsFor(env), call.job);
  const output = (
    await run<{ id: string }>(
      owner,
      `select id from generated_outputs where call_id = $1 order by version desc limit 1`,
      [call.callId],
    )
  )[0];
  return { ...call, outputId: output?.id ?? '' };
}

let feeEarner: Awaited<ReturnType<typeof login>>;
let colp: Awaited<ReturnType<typeof login>>;
let otherFirmEarner: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  seed = await seedArmstrong(env);
  const real = await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password);
  feeEarner = { userId: seed.feeEarner.userId, db: real };
  colp = await login('colp', seed.firm.id, 'colp');
  const other = await createFirm(admin, {
    name: `Gate other ${Date.now()}`,
    mailDomain: `gate${Date.now()}.example.org`,
  });
  if (!other.ok) throw new Error(other.error.message);
  otherFirmEarner = await login('other-firm', other.value.id);
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe('unapproved model output cannot be read through the client-visible route', () => {
  it('serves a client nothing while no fee earner has approved, by every path they have', async () => {
    const call = await summarisedCall();
    const client = await participant(call.matterId, 'client');
    const chain = await participant(call.matterId, 'chain');

    // The output exists, and the firm can see it, awaiting approval.
    const seen = await feeEarner.db
      .from('call_summaries_current')
      .select('output_id, approval_status')
      .eq('call_id', call.callId);
    expect(seen.data).toEqual([{ output_id: call.outputId, approval_status: 'awaiting_approval' }]);

    for (const who of [client, chain]) {
      // The route that serves clients: nothing.
      const served = await getClientVisibleSummaries(who);
      expect(served).toEqual({ ok: true, value: [] });
      // Asking for this output by name changes nothing.
      const byId = await who
        .from('client_visible_outputs')
        .select('content')
        .eq('output_id', call.outputId);
      expect(byId.data).toEqual([]);
      // The tables behind it are closed to them.
      expect(
        (await who.from('generated_outputs').select('id, content').eq('id', call.outputId)).data ??
          [],
      ).toEqual([]);
      expect((await who.from('approvals').select('id')).data ?? []).toEqual([]);
      expect(
        (await who.from('call_summaries_current').select('content').eq('call_id', call.callId))
          .data ?? [],
      ).toEqual([]);
    }
  });

  it('anonymous callers have no route at all', async () => {
    const anon = (await import('@meetlou/harness')).anonClient(env);
    expect((await anon.from('client_visible_outputs').select('content')).error).not.toBeNull();
    expect((await anon.from('generated_outputs').select('content')).error).not.toBeNull();
  });

  it('there is no flag on an output that could be set instead of an approval', async () => {
    const columns = await run<{ column_name: string; data_type: string }>(
      owner,
      `select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'generated_outputs'`,
    );
    expect(columns.filter((c) => c.data_type === 'boolean')).toEqual([]);
    expect(columns.some((c) => /visible|approved|published|client/i.test(c.column_name))).toBe(
      false,
    );
  });
});

describe('who can approve', () => {
  it('only a fee earner of the output’s firm, as themselves', async () => {
    const call = await summarisedCall();
    const client = await participant(call.matterId, 'client');

    for (const [who, label] of [
      [colp.db, 'a COLP'],
      [client, 'a participant'],
      [otherFirmEarner.db, 'a fee earner of another firm'],
    ] as const) {
      const result = await approveOutput(who, call.outputId);
      expect(result.ok, label).toBe(false);
    }
    // The service role (the pipeline itself) holds no INSERT on approvals.
    await expect(
      run(
        { role: 'service_role' },
        `insert into approvals (firm_id, matter_id, generated_output_id, approved_by) values ($1, $2, $3, $4)`,
        [call.firmId, call.matterId, call.outputId, feeEarner.userId],
      ),
    ).rejects.toThrow(/permission denied/);
    // A fee earner cannot approve in someone else's name.
    const spoof = await feeEarner.db.from('approvals').insert({
      firm_id: call.firmId,
      matter_id: call.matterId,
      generated_output_id: call.outputId,
      approved_by: colp.userId,
    });
    expect(spoof.error).not.toBeNull();

    expect(
      await run(owner, `select 1 from approvals where generated_output_id = $1`, [call.outputId]),
    ).toHaveLength(0);
    expect(await getClientVisibleSummaries(client)).toEqual({ ok: true, value: [] });
  });

  it('a fee earner approving writes an approval row and an event that names them', async () => {
    const call = await summarisedCall();
    const approved = await approveOutput(feeEarner.db, call.outputId);
    expect(approved.ok).toBe(true);
    const rows = await run<{ approved_by: string }>(
      owner,
      `select approved_by from approvals where generated_output_id = $1`,
      [call.outputId],
    );
    expect(rows).toEqual([{ approved_by: feeEarner.userId }]);
    const event = await run<{ actor_kind: string; actor_id: string; kind: string }>(
      owner,
      `select actor_kind, actor_id, kind from events where subject_id = $1 and kind = 'output.approved'`,
      [call.outputId],
    );
    expect(event).toEqual([
      { actor_kind: 'fee_earner', actor_id: feeEarner.userId, kind: 'output.approved' },
    ]);
    await expect(
      run(owner, `update approvals set approved_by = $1`, [colp.userId]),
    ).rejects.toThrow(/append-only/);
  });
});

describe('after approval', () => {
  it('the client sees exactly the approved summary; nobody else does', async () => {
    const call = await summarisedCall();
    const client = await participant(call.matterId, 'client');
    const chain = await participant(call.matterId, 'chain');
    const strangerClient = await participant((await recordedCall(env, seed)).matterId, 'client');

    expect((await approveOutput(feeEarner.db, call.outputId)).ok).toBe(true);

    const served = await getClientVisibleSummaries(client);
    expect(served.ok && served.value).toHaveLength(1);
    const first = served.ok ? served.value[0] : undefined;
    expect(first).toMatchObject({
      outputId: call.outputId,
      matterId: call.matterId,
      callId: call.callId,
      version: 1,
      content: SUMMARY,
    });
    // What a client gets carries no provider, model or prompt.
    expect(Object.keys(first ?? {}).sort()).toEqual([
      'approvedAt',
      'callId',
      'content',
      'matterId',
      'outputId',
      'version',
    ]);

    // A chain participant on the same matter, and a client of a different matter: nothing.
    expect(await getClientVisibleSummaries(chain)).toEqual({ ok: true, value: [] });
    expect(await getClientVisibleSummaries(strangerClient)).toEqual({ ok: true, value: [] });
    // Even now the client cannot read the table itself.
    expect((await client.from('generated_outputs').select('id')).data ?? []).toEqual([]);
  });

  it('withdrawing the approval takes the summary away again', async () => {
    const call = await summarisedCall();
    const client = await participant(call.matterId, 'client');
    const approved = await approveOutput(feeEarner.db, call.outputId);
    if (!approved.ok) throw new Error(approved.error.message);
    expect(
      (await getClientVisibleSummaries(client)).ok && (await getClientVisibleSummaries(client)),
    ).toMatchObject({ value: [expect.anything()] });

    expect((await withdrawApproval(feeEarner.db, approved.value.approvalId)).ok).toBe(true);
    expect(await getClientVisibleSummaries(client)).toEqual({ ok: true, value: [] });
    const status = await feeEarner.db
      .from('call_summaries_current')
      .select('approval_status')
      .eq('call_id', call.callId);
    expect(status.data).toEqual([{ approval_status: 'approval_withdrawn' }]);
    // A client cannot withdraw (nor approve) anything.
    expect((await withdrawApproval(client, approved.value.approvalId)).ok).toBe(false);
  });

  it('a newer version is not served until it has been approved itself', async () => {
    const call = await summarisedCall();
    const client = await participant(call.matterId, 'client');
    expect((await approveOutput(feeEarner.db, call.outputId)).ok).toBe(true);
    expect((await getClientVisibleSummaries(client)).ok).toBe(true);

    // A better model reads the same call. Version 1 was approved, but it has been superseded.
    const better: ReturnType<typeof depsFor> = depsFor(env, {
      summariser: new FakeSummariser({ ...SUMMARY, summary: 'A corrected account of the call.' }),
    });
    const outcome = await resummariseCall(better, call.callId);
    expect(outcome).toMatchObject({ status: 'summarised', version: 2 });
    expect(await getClientVisibleSummaries(client)).toEqual({ ok: true, value: [] });

    const v2 =
      (
        await run<{ id: string }>(
          owner,
          `select id from generated_outputs where call_id = $1 and version = 2`,
          [call.callId],
        )
      )[0]?.id ?? '';
    expect((await approveOutput(feeEarner.db, v2)).ok).toBe(true);
    const served = await getClientVisibleSummaries(client);
    expect(served.ok && served.value.map((s) => [s.version, s.content.summary])).toEqual([
      [2, 'A corrected account of the call.'],
    ]);
  });

  it('a superseded output can no longer be approved', async () => {
    const call = await summarisedCall();
    await resummariseCall(
      depsFor(env, { summariser: new FakeSummariser({ ...SUMMARY, summary: 'Newer.' }) }),
      call.callId,
    );
    const result = await approveOutput(feeEarner.db, call.outputId); // version 1, now superseded
    expect(result.ok).toBe(false);
    expect(
      await run(owner, `select 1 from approvals where generated_output_id = $1`, [call.outputId]),
    ).toHaveLength(0);
  });

  it('an approval is for one output and cannot be repeated', async () => {
    const call = await summarisedCall();
    expect((await approveOutput(feeEarner.db, call.outputId)).ok).toBe(true);
    const again = await approveOutput(feeEarner.db, call.outputId);
    expect(again).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });
});
