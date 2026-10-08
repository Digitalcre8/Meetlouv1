import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

/**
 * A captured provider request: the route it was sent to and its form parameters. Signatures
 * are NOT stored. A signature is bound to the provider's real secret and URL, so replay
 * computes a fresh one with the local test token. Values may use {{vars}} for the few things
 * that must differ per run (a CallSid, a timestamp): see `newVars`.
 */
export const fixtureSchema = z.object({
  description: z.string().min(1),
  request: z.object({
    method: z.literal('POST'),
    /** Appended to the function's base URL, query string included (it is part of what Twilio signs). */
    path: z.string(),
    params: z.record(z.string(), z.string()),
  }),
});
export type Fixture = z.infer<typeof fixtureSchema>;

export const scenarioSchema = z.object({
  description: z.string().min(1),
  steps: z
    .array(
      z.object({
        fixture: z.string(),
        /** Sign correctly, then alter the body, as an attacker who has seen a request would. */
        tamper: z.boolean().default(false),
        expect: z.object({
          status: z.number().int(),
          bodyIncludes: z.array(z.string()).default([]),
          bodyExcludes: z.array(z.string()).default([]),
        }),
      }),
    )
    .min(1),
});
export type Scenario = z.infer<typeof scenarioSchema>;

export type Vars = Record<string, string>;

export function newVars(overrides: Vars = {}): Vars {
  return {
    callSid: `CA${randomBytes(16).toString('hex')}`,
    startedSeconds: String(Math.floor(Date.now() / 1000)),
    recordingSid: `RE${randomBytes(16).toString('hex')}`,
    duration: '125',
    ...overrides,
  };
}

export function interpolate(template: string, vars: Vars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`fixture uses unknown variable {{${name}}}`);
    return value;
  });
}

function load<T>(kind: 'twilio' | 'scenarios', name: string, schema: z.ZodType<T>): T {
  const file = `${FIXTURES_DIR}${kind}/${name}.json`;
  return schema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export const loadFixture = (name: string): Fixture => load('twilio', name, fixtureSchema);
export const loadScenario = (name: string): Scenario => load('scenarios', name, scenarioSchema);

export function listFixtures(): { fixtures: string[]; scenarios: string[] } {
  const names = (kind: string) =>
    readdirSync(`${FIXTURES_DIR}${kind}`)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  return { fixtures: names('twilio'), scenarios: names('scenarios') };
}
