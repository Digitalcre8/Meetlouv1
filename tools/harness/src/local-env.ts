import { createHmac } from 'node:crypto';

/**
 * Connection details for the throwaway local stack started by `pnpm db:up`.
 *
 * The default JWT secret is the well-known one every Supabase local stack uses; it protects
 * nothing real. The anon and service-role keys are derived from it, not stored anywhere.
 */
const LOCAL_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';

function signJwt(secret: string, claims: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export interface LocalEnv {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  databaseUrl: string;
}

export function localEnv(): LocalEnv {
  const secret = process.env['LOCAL_JWT_SECRET'] ?? LOCAL_JWT_SECRET;
  const claims = (role: string) => ({ iss: 'supabase-demo', role, exp: 1_983_812_996 });
  return {
    apiUrl: process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321',
    anonKey: process.env['SUPABASE_ANON_KEY'] ?? signJwt(secret, claims('anon')),
    serviceRoleKey:
      process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? signJwt(secret, claims('service_role')),
    databaseUrl:
      process.env['MEETLOU_TEST_DATABASE_URL'] ??
      'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  };
}

/** The seed creates logins with a known password, so it only ever runs against localhost. */
export function assertLocal(env: LocalEnv): void {
  const host = new URL(env.apiUrl).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`refusing to seed a non-local API (${host})`);
  }
}
