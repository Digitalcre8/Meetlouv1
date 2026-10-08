import { afterAll, describe, expect, it } from 'vitest';
import { pool, run } from './db';

const owner = { role: 'owner' } as const;

afterAll(async () => {
  await pool.end();
});

describe('schema guards', () => {
  it('every public table has row level security enabled and forced, and at least one policy', async () => {
    const tables = await run<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: string;
    }>(
      owner,
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (select count(*) from pg_policies p
                where p.schemaname = 'public' and p.tablename = c.relname)::text as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')`,
    );
    expect(tables.length).toBeGreaterThanOrEqual(10);
    for (const t of tables) {
      expect(t.relrowsecurity, `${t.relname} RLS enabled`).toBe(true);
      expect(t.relforcerowsecurity, `${t.relname} RLS forced`).toBe(true);
      expect(Number(t.policies), `${t.relname} has a policy`).toBeGreaterThan(0);
    }
  });

  it('no policy is unconditionally true', async () => {
    const rows = await run<{ tablename: string; policyname: string }>(
      owner,
      `select tablename, policyname from pg_policies
        where schemaname = 'public' and (qual = 'true' or with_check = 'true')`,
    );
    expect(rows).toEqual([]);
  });

  it('anon holds no privilege on any public table', async () => {
    const rows = await run<{ table_name: string }>(
      owner,
      `select table_name from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'anon'`,
    );
    expect(rows).toEqual([]);
  });

  it('no browser-facing role may update or delete evidence', async () => {
    const rows = await run<{ table_name: string; privilege_type: string; grantee: string }>(
      owner,
      `select table_name, privilege_type, grantee from information_schema.role_table_grants
        where table_schema = 'public'
          and grantee in ('anon', 'authenticated', 'service_role')
          and table_name in ('calls', 'emails', 'attachments', 'events', 'receipts', 'audit_log')
          and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')`,
    );
    expect(rows).toEqual([]);
  });

  it('helper functions are not executable by anon or public', async () => {
    const rows = await run<{ proname: string }>(
      owner,
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app'
          and (has_function_privilege('anon', p.oid, 'execute')
               or has_function_privilege('public', p.oid, 'execute'))`,
    );
    expect(rows).toEqual([]);
  });
});
