import { readFileSync } from 'node:fs';
import { assertLocalTarget } from './local-env';
import type { LocalEnv } from './local-env';
import { FIXTURES_DIR, interpolate } from './fixtures';
import type { SendgridFixture, Vars } from './fixtures';
import type { ReplayResult } from './replay';

export interface SendgridReplayOptions {
  env: LocalEnv;
  vars: Vars;
  /** Replace the URL path (e.g. to try a wrong secret). Variables are still interpolated. */
  path?: string;
  /** Override form fields; null removes one. */
  fields?: Record<string, string | null>;
  /** Replace the raw message (null: send none, as SendGrid does when not in raw mode). */
  email?: string | null;
  method?: 'POST' | 'GET';
}

/** Inbound Parse sends the message with CRLF line endings; fixtures are stored with LF. */
export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

export async function replaySendgrid(
  fixture: SendgridFixture,
  options: SendgridReplayOptions,
): Promise<ReplayResult> {
  const { env, vars } = options;
  assertLocalTarget(env);

  const path = interpolate(options.path ?? fixture.request.path, vars);
  const form = new FormData();
  const fields: Record<string, string | null> = { ...fixture.request.fields, ...options.fields };
  for (const [name, value] of Object.entries(fields)) {
    if (value !== null) form.append(name, interpolate(value, vars));
  }
  const email =
    options.email !== undefined
      ? options.email
      : fixture.request.emailFile === undefined
        ? null
        : readFileSync(`${FIXTURES_DIR}sendgrid/${fixture.request.emailFile}`, 'utf8');
  if (email !== null) form.append('email', toCrlf(interpolate(email, vars)));

  const method = options.method ?? fixture.request.method;
  const response = await fetch(`${env.sendgridUrl}${path}`, {
    method,
    // The receiver answers 404/200 without reading the body, which closes the connection; do
    // not let the next request reuse a pooled one.
    headers: { connection: 'close' },
    ...(method === 'POST' ? { body: form } : {}),
    redirect: 'manual',
  });
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get('content-type'),
  };
}
