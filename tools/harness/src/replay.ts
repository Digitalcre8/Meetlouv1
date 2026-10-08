import { assertLocalTarget } from './local-env';
import type { LocalEnv } from './local-env';
import { interpolate, loadFixture, loadScenario, newVars } from './fixtures';
import type { Fixture, Vars } from './fixtures';
import { signTwilioRequest } from './twilio-sign';

export interface ReplayOptions {
  env: LocalEnv;
  vars: Vars;
  /** Alter the body after signing. */
  tamper?: boolean;
  /** Omit the X-Twilio-Signature header entirely. */
  unsigned?: boolean;
  /**
   * 'public' (default): sign for the configured public URL, as Twilio does.
   * 'target': sign for the URL actually requested. Used to prove the function ignores its Host.
   */
  signAgainst?: 'public' | 'target';
}

export interface ReplayResult {
  status: number;
  body: string;
  contentType: string | null;
}

export async function replayFixture(
  fixture: Fixture,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const { env, vars } = options;
  assertLocalTarget(env);

  const path = interpolate(fixture.request.path, vars);
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(fixture.request.params)) {
    params[name] = interpolate(value, vars);
  }

  const base = options.signAgainst === 'target' ? env.functionsUrl : env.twilio.voiceBaseUrl;
  const signature = signTwilioRequest(env.twilio.authToken, `${base}${path}`, params);

  const sent = { ...params };
  if (options.tamper === true) {
    const first = Object.keys(sent)[0];
    if (first !== undefined) sent[first] = `${sent[first] ?? ''}0`;
  }

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (options.unsigned !== true) headers['x-twilio-signature'] = signature;

  const response = await fetch(`${env.functionsUrl}${path}`, {
    method: fixture.request.method,
    headers,
    body: new URLSearchParams(sent).toString(),
    redirect: 'manual',
  });
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get('content-type'),
  };
}

export interface StepOutcome {
  fixture: string;
  tamper: boolean;
  result: ReplayResult;
  failures: string[];
}

/** Run a scenario's steps in order with one shared set of variables (so one CallSid throughout). */
export async function runScenario(
  name: string,
  env: LocalEnv,
  vars: Vars = newVars(),
): Promise<{ ok: boolean; vars: Vars; steps: StepOutcome[] }> {
  const scenario = loadScenario(name);
  const steps: StepOutcome[] = [];
  for (const step of scenario.steps) {
    // A step may happen "later": refresh the clock-based variable per step.
    const stepVars = { ...vars, startedSeconds: vars['startedSeconds'] ?? '' };
    const result = await replayFixture(loadFixture(step.fixture), {
      env,
      vars: stepVars,
      tamper: step.tamper,
    });
    const failures: string[] = [];
    if (result.status !== step.expect.status) {
      failures.push(`status ${result.status}, expected ${step.expect.status}`);
    }
    for (const text of step.expect.bodyIncludes) {
      if (!result.body.includes(text)) failures.push(`body lacks "${text}"`);
    }
    for (const text of step.expect.bodyExcludes) {
      if (result.body.includes(text)) failures.push(`body unexpectedly contains "${text}"`);
    }
    steps.push({ fixture: step.fixture, tamper: step.tamper, result, failures });
  }
  return { ok: steps.every((s) => s.failures.length === 0), vars, steps };
}
