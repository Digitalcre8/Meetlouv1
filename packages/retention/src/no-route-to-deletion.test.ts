import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Deletion is reachable only from the scheduled job (non-negotiable 3). This is the static half of
 * that guarantee: no code that serves a request can name the job's database functions, import the
 * job, or remove a stored object. (The database half, that no API role can delete a row or call
 * those functions, is in supabase/tests/retention.test.ts.)
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Everything that runs because a request arrived, or that a request's code imports. */
const REQUEST_SIDE = [
  'apps/web/src',
  'supabase/functions',
  'packages/capture/src',
  'packages/access/src',
  'packages/records/src',
  'packages/pipeline/src',
  'packages/providers/src',
  'packages/domain/src',
];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) found.push(path);
  }
  return found;
}

const FORBIDDEN: [string, RegExp][] = [
  [
    'the job’s database functions',
    /begin_erasure|complete_erasure|retention_due|note_retention_hold|record_retention_run/,
  ],
  ['the retention role', /retention_runner|RETENTION_JWT/],
  ['the retention package', /@meetlou\/retention/],
  // Storage removal is the other way content disappears; only the job does it.
  ['storage object removal', /\.remove\(\s*\[|\.storage\s*\.from\([^)]*\)\s*\.remove\(/],
];

describe('no route can trigger deletion', () => {
  const files = REQUEST_SIDE.flatMap((dir) => sourceFiles(join(ROOT, dir)));

  it('looks at the code that serves requests', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.includes('supabase/functions/twilio-voice'))).toBe(true);
    expect(files.some((f) => f.includes('apps/web/src'))).toBe(true);
  });

  it.each(FORBIDDEN)('nothing that serves a request refers to %s', (_what, pattern) => {
    const offenders = files
      .filter((file) => !/\.test\.ts$/.test(file))
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('no migration lets an API role delete: the only DELETE grant is to the retention role', () => {
    const dir = join(ROOT, 'supabase/migrations');
    const grants = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .flatMap((f) =>
        readFileSync(join(dir, f), 'utf8')
          .split('\n')
          .map((line) => ({ f, line })),
      )
      .filter(({ line }) => /^\s*grant\b.*\b(delete|truncate|all)\b/i.test(line))
      .filter(({ line }) => /\b(anon|authenticated|service_role)\b/.test(line))
      .map(({ f, line }) => `${f}: ${line.trim()}`);
    expect(grants).toEqual([]);
  });
});
