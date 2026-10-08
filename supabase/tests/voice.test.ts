import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARMSTRONG,
  loadFixture,
  localEnv,
  newVars,
  replayFixture,
  runScenario,
  seedArmstrong,
  serveFunctions,
  stopFunctions,
} from '@meetlou/harness';
import type { SeedResult } from '@meetlou/harness';
import { pool, run } from './db';

/**
 * End to end, offline: the real Deno entrypoint (served by `harness serve`) answering
 * fixtures replayed over HTTP, writing to the real local database.
 */
const env = localEnv();
const owner = { role: 'owner' } as const;
let seed: SeedResult;

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await run<{ n: string }>(owner, sql, params);
  return Number(rows[0]?.n ?? 0);
}
const callsFor = (callSid: string) =>
  count(`select count(*) n from calls where call_sid = $1`, [callSid]);
const allCalls = () => count(`select count(*) n from calls`);
const allMatters = () => count(`select count(*) n from matters`);
const allAudit = () => count(`select count(*) n from audit_log`);
const unroutedAudit = (callSid: string) =>
  count(
    `select count(*) n from audit_log where action = 'call.unrouted' and detail ->> 'call_sid' = $1`,
    [callSid],
  );

beforeAll(async () => {
  seed = await seedArmstrong(env);
  await serveFunctions(env); // always a fresh start, so the tests exercise the code on disk
}, 180_000);

afterAll(async () => {
  if (process.env['KEEP_FUNCTIONS'] === undefined) stopFunctions();
  await pool.end();
});

describe('twilio-voice: authentication', () => {
  it('accepts a valid signature', async () => {
    const result = await replayFixture(loadFixture('voice-incoming.armstrong'), {
      env,
      vars: newVars(),
    });
    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/xml');
    expect(result.body).toContain('<Say');
  });

  it('rejects a tampered request with 403 and writes nothing', async () => {
    const vars = newVars();
    const before = {
      calls: await allCalls(),
      audit: await allAudit(),
      matters: await allMatters(),
    };

    for (const name of ['voice-incoming.armstrong', 'voice-announced.armstrong']) {
      const result = await replayFixture(loadFixture(name), { env, vars, tamper: true });
      expect(result.status).toBe(403);
      expect(result.body).not.toContain('<Response');
    }
    // An unrouted-number request that is tampered must not leave an audit row either.
    const unknown = await replayFixture(loadFixture('voice-incoming.unknown-number'), {
      env,
      vars,
      tamper: true,
    });
    expect(unknown.status).toBe(403);

    expect(await allCalls()).toBe(before.calls);
    expect(await allAudit()).toBe(before.audit);
    expect(await allMatters()).toBe(before.matters);
    expect(await callsFor(vars['callSid'] ?? '')).toBe(0);
  });

  it('rejects a request with no signature header', async () => {
    const result = await replayFixture(loadFixture('voice-incoming.armstrong'), {
      env,
      vars: newVars(),
      unsigned: true,
    });
    expect(result.status).toBe(403);
  });

  it('validates against the configured URL, not the host it was sent to', async () => {
    // Signed for the URL actually requested (127.0.0.1:54326), as a host-trusting server would expect.
    const hostSigned = await replayFixture(loadFixture('voice-incoming.armstrong'), {
      env,
      vars: newVars(),
      signAgainst: 'target',
    });
    expect(hostSigned.status).toBe(403);
  });
});

describe('twilio-voice: a routed call', () => {
  it('announces first and records nothing until the announcement has played', async () => {
    const vars = newVars();
    const announce = await replayFixture(loadFixture('voice-incoming.armstrong'), { env, vars });
    expect(announce.body).toContain('14 Meadow Road, Sale M33 2QX');
    expect(announce.body).toContain('Armstrong &amp; Co');
    expect(announce.body).toContain('This call will be recorded');
    expect(announce.body).not.toContain('record=');
    expect(announce.body).not.toContain('<Dial');
    // The caller may hang up during the announcement: then there is no call row and no consent claim.
    expect(await callsFor(vars['callSid'] ?? '')).toBe(0);
  });

  it('then writes the call with consent, and dials the fee earner dual-channel', async () => {
    const run_ = await runScenario('happy-call', env);
    expect(run_.steps.flatMap((s) => s.failures)).toEqual([]);

    const callSid = run_.vars['callSid'] ?? '';
    const rows = await run<{
      matter_id: string;
      firm_id: string;
      from_e164: string;
      to_e164: string;
      consent_outcome: string;
      consent_announcement_version: string;
      started_at: Date;
      consent_given_at: Date;
    }>(owner, `select * from calls where call_sid = $1`, [callSid]);
    expect(rows).toHaveLength(1);
    const call = rows[0];
    expect(call).toMatchObject({
      matter_id: seed.matter.id,
      firm_id: seed.firm.id,
      from_e164: '+447700900301',
      to_e164: ARMSTRONG.matter.lineE164,
      consent_outcome: 'given',
      consent_announcement_version: '2026-10-08.1',
    });
    // The announcement finished playing after the call began.
    expect(call?.consent_given_at.getTime()).toBeGreaterThanOrEqual(
      call?.started_at.getTime() ?? 0,
    );

    const dial = run_.steps[1]?.result.body ?? '';
    expect(dial).toContain(`<Number>${ARMSTRONG.feeEarner.phoneE164}</Number>`);
    expect(dial).toContain(
      'recordingStatusCallback="https://meetlou-local.example.org/functions/v1/twilio-voice/recording-status"',
    );
  });

  it('delivered several times, produces one call and the same answer', async () => {
    const vars = newVars();
    const callsBefore = await allCalls();
    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await replayFixture(loadFixture('voice-announced.armstrong'), { env, vars });
      expect(result.status).toBe(200);
      bodies.push(result.body);
    }
    expect(await callsFor(vars['callSid'] ?? '')).toBe(1);
    expect(await allCalls()).toBe(callsBefore + 1);
    expect(new Set(bodies).size).toBe(1);
  });

  it('the duplicate-delivery scenario passes', async () => {
    const outcome = await runScenario('duplicate-delivery', env);
    expect(outcome.steps.flatMap((s) => s.failures)).toEqual([]);
    expect(await callsFor(outcome.vars['callSid'] ?? '')).toBe(1);
  });
});

describe('twilio-voice: an unknown number', () => {
  it('is answered politely, audited, and creates no matter, call or recording', async () => {
    const vars = newVars();
    const before = {
      calls: await allCalls(),
      matters: await allMatters(),
      audit: await allAudit(),
    };

    const result = await replayFixture(loadFixture('voice-incoming.unknown-number'), { env, vars });
    expect(result.status).toBe(200);
    expect(result.body).toContain('cannot connect this number');
    expect(result.body).toContain('<Hangup/>');
    expect(result.body).not.toContain('record');
    expect(result.body).not.toContain('<Dial');

    expect(await allMatters()).toBe(before.matters);
    expect(await allCalls()).toBe(before.calls);
    expect(await allAudit()).toBe(before.audit + 1);

    const audit = await run<{
      firm_id: string | null;
      object_kind: string;
      detail: Record<string, string>;
    }>(
      owner,
      `select firm_id, object_kind, detail from audit_log
        where action = 'call.unrouted' and detail ->> 'call_sid' = $1`,
      [vars['callSid'] ?? ''],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      firm_id: null,
      object_kind: 'call',
      detail: {
        call_sid: vars['callSid'],
        to_e164: '+442079460999',
        reason: 'no_matter_for_line',
      },
    });
    // The caller's number is personal data and stays out of the audit row.
    expect(JSON.stringify(audit[0]?.detail)).not.toContain('+447700900399');
  });

  it('writes one audit row however often Twilio redelivers it', async () => {
    const vars = newVars();
    for (let i = 0; i < 3; i++) {
      const result = await replayFixture(loadFixture('voice-incoming.unknown-number'), {
        env,
        vars,
      });
      expect(result.status).toBe(200);
    }
    expect(await unroutedAudit(vars['callSid'] ?? '')).toBe(1);
  });

  it('the unknown-number and tampered-signature scenarios pass', async () => {
    for (const name of ['unknown-number', 'tampered-signature']) {
      const outcome = await runScenario(name, env);
      expect(
        outcome.steps.flatMap((s) => s.failures),
        name,
      ).toEqual([]);
    }
  });
});
