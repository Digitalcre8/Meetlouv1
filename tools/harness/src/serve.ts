import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LocalEnv } from './local-env';

const NAME = 'meetlou-functions';
const IMAGE = process.env['DENO_IMAGE'] ?? 'denoland/deno:alpine-2.5.6';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

/**
 * Serve supabase/functions/twilio-voice locally under Deno, with the same entrypoint, import
 * map and environment variable names the hosted function uses. Needs `pnpm db:up` first.
 */
export async function serveFunctions(env: LocalEnv): Promise<void> {
  docker(['rm', '-f', NAME]);
  const port = new URL(env.functionsUrl).port;
  const proxy = process.env['HTTPS_PROXY'];
  const args = [
    'run',
    '-d',
    '--name',
    NAME,
    '--network',
    'host',
    '-v',
    `${REPO_ROOT}:/app:ro`,
    '-e',
    'PORT=' + port,
    '-e',
    'SUPABASE_URL=' + env.apiUrl,
    '-e',
    'SUPABASE_SERVICE_ROLE_KEY=' + env.serviceRoleKey,
    '-e',
    'TWILIO_AUTH_TOKEN=' + env.twilio.authToken,
    '-e',
    'TWILIO_VOICE_BASE_URL=' + env.twilio.voiceBaseUrl,
    '-e',
    'DENO_DIR=/tmp/deno',
    '-v',
    'meetlou-deno-cache:/tmp/deno',
    '-e',
    'NO_PROXY=127.0.0.1,localhost',
  ];
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
    '--config=/app/supabase/functions/twilio-voice/deno.json',
    '/app/supabase/functions/twilio-voice/index.ts',
  );
  const started = docker(args);
  if (started.status !== 0) throw new Error(`docker run failed: ${started.stderr}`);

  // Ready when THIS container reports it is listening and the port answers (a GET gets 405).
  // Checking the container's own log stops a stale server on the same port counting as ready.
  for (let attempt = 0; attempt < 90; attempt++) {
    const logs = docker(['logs', NAME]);
    if ((logs.stdout + logs.stderr).includes('Listening on')) {
      try {
        const res = await fetch(env.functionsUrl, { method: 'GET' });
        if (res.status === 405) return;
      } catch {
        // not accepting connections yet
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const logs = docker(['logs', '--tail', '30', NAME]);
  throw new Error(`function did not become ready:\n${logs.stdout}${logs.stderr}`);
}

export function stopFunctions(): void {
  docker(['rm', '-f', NAME]);
}
