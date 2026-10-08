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
  twilio: {
    /** A made-up token. The real one never touches this repo. */
    authToken: string;
    /** A made-up account SID: AC + 32 hex. */
    accountSid: string;
    /** Where the function downloads recordings from: the harness's fake Twilio, not api.twilio.com. */
    apiBaseUrl: string;
    /** The URL Twilio would be configured with. The function signs against THIS, not its Host. */
    voiceBaseUrl: string;
  };
  /** Where `harness serve` listens, and where replay sends requests. */
  functionsUrl: string;
  /** The sendgrid-inbound function (the Inbound Parse receiver). */
  sendgridUrl: string;
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  databaseUrl: string;
}

export function localEnv(): LocalEnv {
  const secret = process.env['LOCAL_JWT_SECRET'] ?? LOCAL_JWT_SECRET;
  const claims = (role: string) => ({ iss: 'supabase-demo', role, exp: 1_983_812_996 });
  return {
    twilio: {
      authToken: process.env['TWILIO_AUTH_TOKEN'] ?? 'local-test-twilio-auth-token-0123456789',
      accountSid: process.env['TWILIO_ACCOUNT_SID'] ?? 'AC00000000000000000000000000000000',
      apiBaseUrl: process.env['TWILIO_API_BASE_URL'] ?? 'http://127.0.0.1:54327',
      voiceBaseUrl:
        process.env['TWILIO_VOICE_BASE_URL'] ??
        'https://meetlou-local.example.org/functions/v1/twilio-voice',
    },
    functionsUrl: process.env['FUNCTIONS_URL'] ?? 'http://127.0.0.1:54326/twilio-voice',
    sendgridUrl: process.env['SENDGRID_FUNCTION_URL'] ?? 'http://127.0.0.1:54329/sendgrid-inbound',
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

/** Replay signs requests with a test token, so it only ever talks to localhost. */
export function assertLocalTarget(env: LocalEnv): void {
  for (const url of [env.functionsUrl, env.sendgridUrl]) {
    const host = new URL(url).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') {
      throw new Error(`refusing to replay at a non-local target (${host})`);
    }
  }
}
