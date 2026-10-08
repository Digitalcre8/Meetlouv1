import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { PROMPT_VERSION, SYSTEM_PROMPT, labelSegments, summarySchema } from '@meetlou/providers';
import type { Summariser, SummariseInput, SummariseResult, Summary } from '@meetlou/providers';
import { z } from 'zod';
import { EVALS_DIR } from './golden';
import type { GoldenCase } from './golden';
import { aggregate, invalidScore, scoreCase } from './score';
import type { CaseScore, EvalMetrics } from './score';

export function inputFor(golden: GoldenCase): SummariseInput {
  return {
    callDate: golden.callDate,
    recordingChannels: golden.channels,
    segments: labelSegments(golden.segments, golden.channels),
  };
}

export interface EvalReport {
  provider: string;
  promptVersion: string;
  metrics: EvalMetrics;
  scores: CaseScore[];
}

/** Run a summariser over the golden set and score it. A summariser that throws scores as invalid output. */
export async function evaluate(summariser: Summariser, cases: GoldenCase[]): Promise<EvalReport> {
  const scores: CaseScore[] = [];
  for (const golden of cases) {
    try {
      const result = await summariser.summarise(inputFor(golden));
      const checked = summarySchema.safeParse(result.summary);
      scores.push(
        checked.success
          ? scoreCase(golden, checked.data)
          : invalidScore(
              golden.id,
              `failed validation: ${checked.error.issues.map((i) => i.path.join('.')).join(', ')}`,
            ),
      );
    } catch (error) {
      scores.push(
        invalidScore(golden.id, error instanceof Error ? error.message.slice(0, 200) : 'threw'),
      );
    }
  }
  return {
    provider: summariser.name,
    promptVersion: summariser.promptVersion,
    metrics: aggregate(scores),
    scores,
  };
}

/** The "perfect" summariser: returns what the golden case expects. Proves the scorer can score 0 errors. */
export class OracleSummariser implements Summariser {
  readonly name = 'oracle';
  readonly promptVersion = 'oracle';
  constructor(private readonly cases: GoldenCase[]) {}
  summarise(input: SummariseInput): Promise<SummariseResult> {
    const golden = this.cases.find(
      (c) => c.callDate === input.callDate && c.segments[0]?.text === input.segments[0]?.text,
    );
    if (golden === undefined) throw new Error('oracle: unknown case');
    const summary: Summary = {
      summary: golden.expected.mustMention.map((g) => g[0]).join('; ') || 'Nothing was agreed.',
      actions: golden.expected.actions.map((a) => ({
        description: a.match.map((g) => g[0]).join(' '),
        owner: a.owner[0] ?? 'unclear',
        due: a.due?.[0] ?? null,
      })),
      keyDates: golden.expected.keyDates.map((d) => ({
        date: d.date,
        description: 'date agreed on the call',
      })),
    };
    return Promise.resolve({
      summary,
      provider: this.name,
      model: 'oracle',
      promptVersion: this.promptVersion,
    });
  }
}

// --- recorded model output ("cassettes") -------------------------------------------------------
// CI has no API key. A model run is recorded once, with credentials, and replayed offline; the
// recording is keyed by a fingerprint of the prompt, so changing the prompt makes the old
// recordings stale and the suite says so instead of quietly scoring the old prompt.

export const promptFingerprint = (): string =>
  `${PROMPT_VERSION}-${createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 12)}`;

const cassetteDir = (provider: string, fingerprint = promptFingerprint()) =>
  `${EVALS_DIR}cassettes/${provider}/${fingerprint}/`;

const cassetteSchema = z.object({
  caseId: z.string(),
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  recordedAt: z.string(),
  summary: summarySchema,
});

export function cassetteFingerprints(provider: string): string[] {
  const root = `${EVALS_DIR}cassettes/${provider}/`;
  return existsSync(root) ? readdirSync(root).sort() : [];
}

export class RecordingSummariser implements Summariser {
  readonly name: string;
  readonly promptVersion: string;
  constructor(
    private readonly inner: Summariser,
    private readonly goldenFor: (input: SummariseInput) => GoldenCase,
  ) {
    this.name = inner.name;
    this.promptVersion = inner.promptVersion;
  }
  async summarise(input: SummariseInput): Promise<SummariseResult> {
    const result = await this.inner.summarise(input);
    const dir = cassetteDir(this.name);
    mkdirSync(dir, { recursive: true });
    const golden = this.goldenFor(input);
    writeFileSync(
      `${dir}${golden.id}.json`,
      `${JSON.stringify(
        {
          caseId: golden.id,
          provider: result.provider,
          model: result.model,
          promptVersion: result.promptVersion,
          recordedAt: new Date().toISOString(),
          summary: result.summary,
        },
        null,
        2,
      )}\n`,
    );
    return result;
  }
}

export class CassetteSummariser implements Summariser {
  readonly promptVersion = PROMPT_VERSION;
  constructor(
    readonly name: string,
    private readonly goldenFor: (input: SummariseInput) => GoldenCase,
    private readonly fingerprint = promptFingerprint(),
  ) {}
  summarise(input: SummariseInput): Promise<SummariseResult> {
    const golden = this.goldenFor(input);
    const file = `${cassetteDir(this.name, this.fingerprint)}${golden.id}.json`;
    if (!existsSync(file))
      throw new Error(`no recorded output for ${golden.id} under prompt ${this.fingerprint}`);
    const cassette = cassetteSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    return Promise.resolve({
      summary: cassette.summary,
      provider: cassette.provider,
      model: cassette.model,
      promptVersion: cassette.promptVersion,
    });
  }
}

export function goldenLookup(cases: GoldenCase[]) {
  return (input: SummariseInput): GoldenCase => {
    const found = cases.find(
      (c) => c.callDate === input.callDate && c.segments[0]?.text === input.segments[0]?.text,
    );
    if (found === undefined) throw new Error('unknown golden case');
    return found;
  };
}

// --- baseline ---------------------------------------------------------------------------------
const baselineSchema = z.record(
  z.string(),
  z.object({
    promptVersion: z.string(),
    metrics: z.object({
      cases: z.number(),
      errorRate: z.number(),
      criticalErrors: z.number(),
      omissionRate: z.number(),
      meanActionRecall: z.number(),
      meanActionPrecision: z.number(),
      meanDateRecall: z.number(),
      meanDatePrecision: z.number(),
      meanMentionCoverage: z.number(),
    }),
  }),
);
export type Baseline = z.infer<typeof baselineSchema>;
const BASELINE_FILE = `${EVALS_DIR}baseline.json`;

export function readBaseline(): Baseline {
  return existsSync(BASELINE_FILE)
    ? baselineSchema.parse(JSON.parse(readFileSync(BASELINE_FILE, 'utf8')))
    : {};
}

export function writeBaseline(report: EvalReport): void {
  const current = readBaseline();
  current[report.provider] = { promptVersion: report.promptVersion, metrics: report.metrics };
  writeFileSync(BASELINE_FILE, `${JSON.stringify(current, null, 2)}\n`);
}

/** Compare a report to the committed baseline: what got worse is a regression, what got better is reported. */
export function compareToBaseline(report: EvalReport, baseline: Baseline) {
  const base = baseline[report.provider];
  if (base === undefined)
    return {
      regressions: ['no baseline recorded for this provider'],
      improvements: [] as string[],
    };
  const m = report.metrics;
  const b = base.metrics;
  const regressions: string[] = [];
  const improvements: string[] = [];
  const check = (name: string, now: number, then: number, lowerIsBetter: boolean) => {
    const worse = lowerIsBetter ? now > then + 1e-9 : now < then - 1e-9;
    const better = lowerIsBetter ? now < then - 1e-9 : now > then + 1e-9;
    if (worse) regressions.push(`${name}: ${then} -> ${now}`);
    if (better) improvements.push(`${name}: ${then} -> ${now}`);
  };
  check('errorRate', m.errorRate, b.errorRate, true);
  check('criticalErrors', m.criticalErrors, b.criticalErrors, true);
  check('omissionRate', m.omissionRate, b.omissionRate, true);
  check('meanActionRecall', m.meanActionRecall, b.meanActionRecall, false);
  check('meanActionPrecision', m.meanActionPrecision, b.meanActionPrecision, false);
  check('meanDateRecall', m.meanDateRecall, b.meanDateRecall, false);
  check('meanDatePrecision', m.meanDatePrecision, b.meanDatePrecision, false);
  return { regressions, improvements };
}

export function formatReport(report: EvalReport, baseline: Baseline): string {
  const lines = [`provider ${report.provider} / prompt ${report.promptVersion}`];
  const m = report.metrics;
  lines.push(
    `cases ${m.cases}  error rate ${(m.errorRate * 100).toFixed(1)}%  critical errors ${m.criticalErrors}  omission rate ${(m.omissionRate * 100).toFixed(1)}%`,
    `action recall ${m.meanActionRecall}  precision ${m.meanActionPrecision}  date recall ${m.meanDateRecall}  precision ${m.meanDatePrecision}  facts ${m.meanMentionCoverage}`,
    '',
  );
  for (const s of report.scores) {
    lines.push(
      `${s.critical.length > 0 ? 'FAIL' : s.omissions.length > 0 ? 'omit' : 'ok  '} ${s.id}`,
    );
    for (const c of s.critical) lines.push(`       ! ${c.code}: ${c.detail}`);
    for (const o of s.omissions) lines.push(`       - ${o}`);
  }
  const { regressions, improvements } = compareToBaseline(report, baseline);
  lines.push(
    '',
    regressions.length === 0
      ? 'vs baseline: no regression'
      : `vs baseline: REGRESSION\n  ${regressions.join('\n  ')}`,
  );
  if (improvements.length > 0)
    lines.push(`improved (run with --update-baseline to record):\n  ${improvements.join('\n  ')}`);
  return lines.join('\n');
}
