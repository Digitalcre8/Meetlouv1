import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LocalEnv } from './local-env';

const IMAGE = process.env['DENO_IMAGE'] ?? 'denoland/deno:alpine-2.5.6';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface FunctionSpec {
  /** supabase/functions/<name> */
  name: 'twilio-voice' | 'sendgrid-inbound';
  container: string;
  url: (env: LocalEnv) => string;
  env: (env: LocalEnv) => string[];
}

const SUPABASE_ENV = (env: LocalEnv) => [
  'SUPABASE_URL=' + env.apiUrl,
  'SUPABASE_SERVICE_ROLE_KEY=' + env.serviceRoleKey,
];

const FUNCTIONS: FunctionSpec[] = [
  {
    name: 'twilio-voice',
    container: 'meetlou-functions',
    url: (env) => env.functionsUrl,
    env: (env) => [
      ...SUPABASE_ENV(env),
      'TWILIO_AUTH_TOKEN=' + env.twilio.authToken,
      'TWILIO_ACCOUNT_SID=' + env.twilio.accountSid,
      'TWILIO_API_BASE_URL=' + env.twilio.apiBaseUrl,
      'TWILIO_VOICE_BASE_URL=' + env.twilio.voiceBaseUrl,
    ],
  },
  {
    name: 'sendgrid-inbound',
    container: 'meetlou-functions-sendgrid',
    url: (env) => env.sendgridUrl,
    // Nothing else: Inbound Parse has no shared secret in configuration. The credential is in the URL.
    env: (env) => SUPABASE_ENV(env),
  },
];

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

async function serveOne(spec: FunctionSpec, env: LocalEnv): Promise<void> {
  docker(['rm', '-f', spec.container]);
  const url = spec.url(env);
  const proxy = process.env['HTTPS_PROXY'];
  const args = [
    'run',
    '-d',
    '--name',
    spec.container,
    '--network',
    'host',
    '-v',
    `${REPO_ROOT}:/app:ro`,
  ];
  for (const entry of [
    `PORT=${new URL(url).port}`,
    'DENO_DIR=/tmp/deno',
    'NO_PROXY=127.0.0.1,localhost',
    ...spec.env(env),
  ]) {
    args.push('-e', entry);
  }
  args.push('-v', 'meetlou-deno-cache:/tmp/deno');
  // Sandboxes that route egress through a proxy need it for Deno's npm downloads.
  if (proxy !== undefined) args.push('-e', `HTTPS_PROXY=${proxy}`, '-e', `HTTP_PROXY=${proxy}`);
  if (existsSync('/root/.ccr/ca-bundle.crt')) {
    args.push('-v', '/root/.ccr/ca-bundle.crt:/ca.crt:ro', '-e', 'DENO_CERT=/ca.crt');
  }
  args.push(
    IMAGE,
    'run',
    '--allow-net',
    '--allow-env',
    '--allow-read',
    '--allow-write=/tmp/deno',
    '--no-lock',
    `--config=/app/supabase/functions/${spec.name}/deno.json`,
    `/app/supabase/functions/${spec.name}/index.ts`,
  );
  const started = docker(args);
  if (started.status !== 0) throw new Error(`docker run failed: ${started.stderr}`);

  // Ready when THIS container reports it is listening and the port answers (a GET gets 404 or 405).
  // Checking the container's own log stops a stale server on the same port counting as ready.
  for (let attempt = 0; attempt < 240; attempt++) {
    const logs = docker(['logs', spec.container]);
    if ((logs.stdout + logs.stderr).includes('Listening on')) {
      try {
        const res = await fetch(url, { method: 'GET' });
        if (res.status === 405 || res.status === 404) return;
      } catch {
        // not accepting connections yet
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const logs = docker(['logs', '--tail', '30', spec.container]);
  throw new Error(`${spec.name} did not become ready:\n${logs.stdout}${logs.stderr}`);
}

/**
 * Serve every edge function locally under Deno, each with the same entrypoint, import map and
 * environment variable names it has when hosted. Needs `pnpm db:up` first.
 */
export async function serveFunctions(env: LocalEnv): Promise<void> {
  for (const spec of FUNCTIONS) await serveOne(spec, env);
}

export function stopFunctions(): void {
  for (const spec of FUNCTIONS) docker(['rm', '-f', spec.container]);
}

/** The container logs of one function, for tests that check what it did and did not print. */
export function functionLogs(name: FunctionSpec['name']): string {
  const spec = FUNCTIONS.find((f) => f.name === name);
  if (spec === undefined) throw new Error(`unknown function ${name}`);
  const logs = docker(['logs', spec.container]);
  return logs.stdout + logs.stderr;
}
