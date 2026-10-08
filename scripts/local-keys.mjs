// Prints the anon and service-role JWTs for the local stack, derived from the well-known
// Supabase local-development secret (it protects nothing real). Usage: node local-keys.mjs anon|service|retention
import { createHmac } from 'node:crypto';

const secret =
  process.env.LOCAL_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';
const role =
  process.argv[2] === 'service'
    ? 'service_role'
    : process.argv[2] === 'retention'
      ? 'retention_runner'
      : 'anon';
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase-demo', role, exp: 1983812996 })}`;
console.log(`${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`);
