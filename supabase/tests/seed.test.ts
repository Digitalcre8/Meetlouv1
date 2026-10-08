import { beforeAll, describe, expect, it } from 'vitest';
import { createMatter, getSessionFirm } from '@meetlou/records';
import { createFeeEarner, createFirm } from '@meetlou/records/admin';
import {
  anonClient,
  localEnv,
  seedArmstrong,
  serviceClient,
  signedInClient,
} from '@meetlou/harness';
import type { SeedResult } from '@meetlou/harness';

const env = localEnv();
let seed: SeedResult;

beforeAll(async () => {
  seed = await seedArmstrong(env);
});

describe('seed: Armstrong & Co / MTR-1001', () => {
  it('creates the firm, matter and participants that every later test relies on', () => {
    expect(seed.firm.name).toBe('Armstrong & Co');
    expect(seed.firm.mail_domain).toBe('matters.armstrongco.co.uk');
    expect(seed.matter.reference).toBe('MTR-1001');
    expect(seed.matter.property_address).toBe('14 Meadow Road, Sale M33 2QX');
    expect(seed.matter.kind).toBe('purchase');
    expect(seed.matter.firm_id).toBe(seed.firm.id);

    expect(seed.sarahWhitfield).toMatchObject({
      display_name: 'Sarah Whitfield',
      access: 'client',
      role: 'client',
    });
    expect(seed.priyaNandra).toMatchObject({
      display_name: 'Priya Nandra',
      access: 'chain',
      role: 'estate_agent',
    });
  });

  it('routes mail through a slug of the address plus 96 random bits', () => {
    expect(seed.matter.inbound_slug).toMatch(/^14meadowroad-[0-9a-f]{24}$/);
    expect(seed.inboundAddress).toBe(`${seed.matter.inbound_slug}@matters.armstrongco.co.uk`);
  });

  it('is idempotent: a second run returns the same records, not new ones', async () => {
    const again = await seedArmstrong(env);
    expect(again.firm.id).toBe(seed.firm.id);
    expect(again.matter.id).toBe(seed.matter.id);
    expect(again.matter.inbound_slug).toBe(seed.matter.inbound_slug);
    expect(again.sarahWhitfield.id).toBe(seed.sarahWhitfield.id);
    expect(again.priyaNandra.id).toBe(seed.priyaNandra.id);
  });

  it('has exactly one matter MTR-1001 and exactly two participants on it', async () => {
    const admin = serviceClient(env);
    const matters = await admin.from('matters').select('id').eq('reference', 'MTR-1001');
    expect(matters.data).toHaveLength(1);
    const participants = await admin
      .from('participants')
      .select('id')
      .eq('matter_id', seed.matter.id);
    expect(participants.data).toHaveLength(2);
  });
});

describe('sign-in', () => {
  it('the fee earner signs in and reads their own firm and matter under RLS', async () => {
    const client = await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password);

    const session = await getSessionFirm(client);
    expect(session.ok && session.value?.firm.id).toBe(seed.firm.id);
    expect(session.ok && session.value?.role).toBe('fee_earner');

    const matters = await client.from('matters').select('id, inbound_slug');
    expect(matters.data?.map((m: { id: string }) => m.id)).toContain(seed.matter.id);
    const participants = await client
      .from('participants')
      .select('display_name')
      .eq('matter_id', seed.matter.id);
    expect(participants.data).toHaveLength(2);
  });

  it('a wrong password is rejected', async () => {
    await expect(signedInClient(env, seed.feeEarner.email, 'not-the-password')).rejects.toThrow(
      /sign-in failed/,
    );
  });

  it('the anon key alone reads nothing', async () => {
    const anon = anonClient(env);
    const matters = await anon.from('matters').select('id');
    expect(matters.data ?? []).toEqual([]);
  });

  it('public sign-up is disabled: only the operator can create a login', async () => {
    const { error } = await anonClient(env).auth.signUp({
      email: `intruder-${Date.now()}@example.org`,
      password: 'a-long-enough-password',
    });
    expect(error).not.toBeNull();
  });

  it('a login with no firm resolves to no firm', async () => {
    const admin = serviceClient(env);
    const email = `no-firm-${Date.now()}@example.org`;
    const password = 'a-long-enough-password';
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const client = await signedInClient(env, email, password);
    const session = await getSessionFirm(client);
    expect(session).toEqual({ ok: true, value: null });
  });
});

describe('server-side helpers', () => {
  it("a fee earner of another firm can neither see nor create records in Armstrong & Co's matters", async () => {
    const admin = serviceClient(env);
    const firm = await createFirm(admin, {
      name: `Other ${Date.now()}`,
      mailDomain: `other${Date.now()}.example.org`,
    });
    if (!firm.ok) throw new Error(firm.error.message);
    const email = `other-${Date.now()}@example.org`;
    const earner = await createFeeEarner(admin, {
      firmId: firm.value.id,
      email,
      password: 'a-long-enough-password',
    });
    expect(earner.ok).toBe(true);
    const other = await signedInClient(env, email, 'a-long-enough-password');

    const visible = await other.from('matters').select('id').eq('id', seed.matter.id);
    expect(visible.data).toEqual([]);

    const attempt = await createMatter(other, {
      firmId: seed.firm.id,
      reference: 'MTR-HIJACK',
      kind: 'sale',
      propertyAddress: '1 Elsewhere Road',
    });
    expect(attempt.ok).toBe(false);
    expect(!attempt.ok && attempt.error.code).toBe('not_permitted');
  });

  it('rejects input that is not one of our matter kinds, naming the field and not the value', async () => {
    const client = await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password);
    const result = await createMatter(client, {
      firmId: seed.firm.id,
      reference: 'MTR-BAD',
      kind: 'case',
      propertyAddress: '1 Road',
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_input', message: 'invalid: kind' },
    });
  });

  it('refuses a duplicate matter reference within a firm as a conflict', async () => {
    const client = await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password);
    const result = await createMatter(client, {
      firmId: seed.firm.id,
      reference: 'MTR-1001',
      kind: 'purchase',
      propertyAddress: '14 Meadow Road, Sale M33 2QX',
    });
    expect(!result.ok && result.error.code).toBe('conflict');
  });

  it('createFeeEarner leaves no orphan login behind when the firm does not exist', async () => {
    const admin = serviceClient(env);
    const email = `orphan-${Date.now()}@example.org`;
    const result = await createFeeEarner(admin, {
      firmId: crypto.randomUUID(),
      email,
      password: 'a-long-enough-password',
    });
    expect(result.ok).toBe(false);
    const list = await admin.auth.admin.listUsers({ perPage: 1000 });
    expect(list.data.users.some((u) => u.email === email)).toBe(false);
  });
});
