import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseInboundSlug } from '@meetlou/domain';
import { createMatter } from '@meetlou/records';
import { localEnv, seedArmstrong, signedInClient } from '@meetlou/harness';
import type { SeedResult } from '@meetlou/harness';
import { pool, run } from './db';

let seed: SeedResult;
const env = localEnv();

beforeAll(async () => {
  seed = await seedArmstrong(env);
});

afterAll(async () => {
  await pool.end();
});

describe('inbound_slug', () => {
  it('two matters at the same address get different slugs', async () => {
    const client = await signedInClient(env, seed.feeEarner.email, seed.feeEarner.password);
    const make = async (reference: string) => {
      const result = await createMatter(client, {
        firmId: seed.firm.id,
        reference,
        kind: 'purchase',
        propertyAddress: '14 Meadow Road, Sale M33 2QX',
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };

    const first = await make(`SLUG-A-${Date.now()}`);
    const second = await make(`SLUG-B-${Date.now()}`);

    expect(first.matter.inbound_slug).not.toBe(second.matter.inbound_slug);
    expect(first.inboundAddress).not.toBe(second.inboundAddress);
    // Same human-readable prefix, different unguessable suffix.
    const a = parseInboundSlug(first.matter.inbound_slug);
    const b = parseInboundSlug(second.matter.inbound_slug);
    expect(a?.prefix).toBe('14meadowroad');
    expect(b?.prefix).toBe('14meadowroad');
    expect(a?.suffix).not.toBe(b?.suffix);
    // ...and neither collides with the seeded MTR-1001 at that same address.
    expect(seed.matter.inbound_slug).not.toBe(first.matter.inbound_slug);
    expect(seed.matter.inbound_slug).not.toBe(second.matter.inbound_slug);
  });

  it('is unique across many matters at one address', async () => {
    const rows = await run<{ inbound_slug: string }>(
      { role: 'service_role' },
      `insert into matters (firm_id, reference, kind, property_address)
       select $1, 'BULK-' || n || '-' || $2, 'sale', '14 Meadow Road, Sale M33 2QX'
         from generate_series(1, 300) n
       returning inbound_slug`,
      [seed.firm.id, String(Date.now())],
      { commit: true },
    );
    expect(rows).toHaveLength(300);
    expect(new Set(rows.map((r) => r.inbound_slug)).size).toBe(300);
    for (const { inbound_slug } of rows) {
      expect(inbound_slug).toMatch(/^14meadowroad-[0-9a-f]{24}$/);
    }
  });

  it('carries 96 random bits: each of the 24 hex positions varies across matters', async () => {
    const rows = await run<{ inbound_slug: string }>(
      { role: 'owner' },
      `select inbound_slug from matters where inbound_slug like '14meadowroad-%' limit 300`,
    );
    const suffixes = rows.map((r) => parseInboundSlug(r.inbound_slug)?.suffix ?? '');
    expect(suffixes.length).toBeGreaterThan(100);
    for (let position = 0; position < 24; position++) {
      const seen = new Set(suffixes.map((s) => s[position]));
      // 100+ draws of a uniform hex digit would miss fewer than 10 of 16 values with
      // probability ~1e-9; a weak or position-constant generator fails this immediately.
      expect(seen.size, `position ${position}`).toBeGreaterThanOrEqual(10);
    }
  });

  it('builds a safe prefix from awkward addresses', async () => {
    const prefixOf = async (address: string) => {
      const rows = await run<{ slug: string }>(
        { role: 'owner' },
        `select app.make_inbound_slug($1) as slug`,
        [address],
      );
      return rows[0]?.slug.replace(/-[0-9a-f]{24}$/, '');
    };
    expect(await prefixOf('14 Meadow Road, Sale M33 2QX')).toBe('14meadowroad');
    expect(await prefixOf("Flat 2, 10 O'Neil Street")).toBe('flat2');
    expect(await prefixOf('Zürich Weg 1, Testville')).toBe('zrichweg1');
    expect(await prefixOf(', nothing before the comma')).toBe('matter');
    expect(await prefixOf('x@y.com; drop table matters, z')).toBe('xycomdroptablematters');
    expect((await prefixOf('9'.repeat(80)))?.length).toBe(30);
  });
});
