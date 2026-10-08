import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseAccessStore, createRecordingAccessHandler } from '@meetlou/access';
import { createLogger } from '@meetlou/domain';
import { createFeeEarner, createFirm } from '@meetlou/records/admin';
import {
  FIXTURES_DIR,
  localEnv,
  seedArmstrong,
  serviceClient,
  signedInClient,
} from '@meetlou/harness';
import type { SeedResult } from '@meetlou/harness';
import { pool, run } from './db';
import { recordedCall } from './pipeline-helpers';
import type { RecordedCall } from './pipeline-helpers';

/**
 * Every access to a recording is an audit row. The audio is reachable only through this route:
 * direct reads of the bucket are closed, so there is no access that nobody wrote down.
 */
const env = localEnv();
const owner = { role: 'owner' } as const;
const admin = serviceClient(env);
const PASSWORD = 'a-long-enough-password';
const log: string[] = [];
const handler = createRecordingAccessHandler({
  store: new SupabaseAccessStore(admin, { url: env.apiUrl, anonKey: env.anonKey }),
  logger: createLogger((line) => log.push(line)),
});
let seed: SeedResult;
let rec: RecordedCall;
let feeEarnerToken = '';

const tokenOf = async (db: Awaited<ReturnType<typeof signedInClient>>) =>
  (await db.auth.getSession()).data.session?.access_token ?? '';
const ask = (token: string | null, recordingId: string | null = rec.recordingId) =>
  handler(
    new Request('http://127.0.0.1/recording-access', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(recordingId === null ? {} : { recordingId }),
    }),
  );
const accesses = async (recordingId = rec.recordingId) =>
  run<{ actor_id: string; firm_id: string }>(
    owner,
    `select actor_id, firm_id from audit_log where action = 'recording.accessed' and object_id = $1 order by id`,
    [recordingId],
  );

beforeAll(async () => {
  seed = await seedArmstrong(env);
  rec = await recordedCall(env, seed);
  feeEarnerToken = await tokenOf(
    await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password),
  );
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe('the audited route to a recording', () => {
  it('hands a firm’s fee earner the audio, and writes an audit row for each access', async () => {
    expect(await accesses()).toHaveLength(0);

    const first = await ask(feeEarnerToken);
    expect(first.status).toBe(200);
    const granted = (await first.json()) as { url: string; expiresInSeconds: number };
    expect(granted.expiresInSeconds).toBe(60);
    const audio = new Uint8Array(await (await fetch(granted.url)).arrayBuffer());
    expect(audio).toEqual(new Uint8Array(readFileSync(`${FIXTURES_DIR}audio/stereo-2s.wav`)));
    expect(await accesses()).toEqual([{ actor_id: seed.feeEarner.userId, firm_id: seed.firm.id }]);

    // A second access is a second row: access is counted, not deduplicated.
    expect((await ask(feeEarnerToken)).status).toBe(200);
    expect(await accesses()).toHaveLength(2);
  });

  it('the audit row is there before the link exists: nothing is handed out unrecorded', async () => {
    const before = (await accesses()).length;
    const response = await ask(feeEarnerToken);
    expect(response.status).toBe(200);
    expect((await accesses()).length).toBe(before + 1);
  });

  it('refuses everyone else, in the same words, and writes nothing', async () => {
    const before = (await accesses()).length;
    const otherFirm = await createFirm(admin, {
      name: `Access ${Date.now()}`,
      mailDomain: `acc${Date.now()}.example.org`,
    });
    if (!otherFirm.ok) throw new Error(otherFirm.error.message);
    const email = `outsider-${randomUUID()}@example.org`;
    await createFeeEarner(admin, { firmId: otherFirm.value.id, email, password: PASSWORD });
    const outsider = await tokenOf(await signedInClient(env, email, PASSWORD));

    // A client participant on this very matter.
    const clientEmail = `client-${randomUUID()}@example.org`;
    const created = await admin.auth.admin.createUser({
      email: clientEmail,
      password: PASSWORD,
      email_confirm: true,
    });
    if (created.error !== null) throw new Error(created.error.message);
    await run(
      { role: 'service_role' },
      `insert into participants (firm_id, matter_id, user_id, access, role, display_name)
       values ($1, $2, $3, 'client', 'client', 'Access Client')`,
      [seed.firm.id, rec.matterId, created.data.user.id],
      { commit: true },
    );
    const participant = await tokenOf(await signedInClient(env, clientEmail, PASSWORD));

    for (const token of [outsider, participant]) {
      const response = await ask(token);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not Found');
    }
    expect((await ask(feeEarnerToken, randomUUID())).status).toBe(404); // no such recording: same answer
    expect((await accesses()).length).toBe(before);
  });

  it('refuses callers who are not signed in, including the keys that are not user sessions', async () => {
    const before = (await accesses()).length;
    for (const token of [null, '', 'not-a-jwt', env.anonKey, env.serviceRoleKey]) {
      expect((await ask(token)).status, String(token).slice(0, 12)).toBe(401);
    }
    expect((await ask(feeEarnerToken, null)).status).toBe(400);
    expect((await handler(new Request('http://127.0.0.1/x', { method: 'GET' }))).status).toBe(405);
    expect((await accesses()).length).toBe(before);
  });

  it('is the only way in: not even a firm member can read the bucket, sign a link, or write the audit row themselves', async () => {
    const db = await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password);
    const path =
      (
        await run<{ storage_path: string }>(
          owner,
          `select storage_path from call_recordings where id = $1`,
          [rec.recordingId],
        )
      )[0]?.storage_path ?? '';
    expect((await db.storage.from('recordings').download(path)).error).not.toBeNull();
    expect((await db.storage.from('recordings').createSignedUrl(path, 60)).error).not.toBeNull();
    expect(
      (
        await db.rpc('record_recording_access', {
          p_recording_id: rec.recordingId,
          p_user_id: seed.feeEarner.userId,
        })
      ).error,
    ).not.toBeNull();
    expect(
      (
        await db
          .from('audit_log')
          .insert({ firm_id: seed.firm.id, action: 'recording.accessed', object_kind: 'recording' })
      ).error,
    ).not.toBeNull();
  });

  it('never logs the token or the link', () => {
    const lines = log.join('\n');
    expect(lines).toContain('granted');
    expect(lines).not.toContain(feeEarnerToken);
    expect(lines).not.toMatch(/token=|http:|signed/i);
  });
});
