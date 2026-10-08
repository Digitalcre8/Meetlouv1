import { describe, expect, it } from 'vitest';
import { RuleBasedSummariser, labelSegments } from '@meetlou/providers';
import type { Summariser, Summary } from '@meetlou/providers';
import { loadGoldenSet } from './golden';
import {
  CassetteSummariser,
  OracleSummariser,
  cassetteFingerprints,
  compareToBaseline,
  evaluate,
  formatReport,
  goldenLookup,
  promptFingerprint,
  readBaseline,
} from './run';
import { scoreCase } from './score';

const cases = loadGoldenSet();
const byId = (id: string) => {
  const found = cases.find((c) => c.id.startsWith(id));
  if (found === undefined) throw new Error(`no golden case ${id}`);
  return found;
};

/** A summariser that returns one fixed summary whatever it is asked. */
const fixed = (summary: Summary, name = 'fixed'): Summariser => ({
  name,
  promptVersion: 'fixed',
  summarise: () =>
    Promise.resolve({ summary, provider: name, model: name, promptVersion: 'fixed' }),
});
const empty: Summary = { summary: 'The call took place.', actions: [], keyDates: [] };

describe('the golden set', () => {
  it('has at least ten transcripts, each with something to check', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      const e = c.expected;
      expect(
        e.mustMention.length + e.mustNotMention.length + e.actions.length + e.keyDates.length,
        c.id,
      ).toBeGreaterThan(0);
    }
  });

  it('is coherent: ordered segments, real channels, mono calls with one channel, real dates', () => {
    for (const c of cases) {
      let last = -1;
      for (const s of c.segments) {
        expect(s.startSeconds, c.id).toBeGreaterThanOrEqual(last);
        last = s.startSeconds;
        if (c.channels === 1) expect(s.channel, c.id).toBe(0);
      }
      const dates = [
        ...c.expected.keyDates.map((d) => d.date),
        ...c.expected.actions.flatMap((a) => a.due ?? []),
        ...c.expected.alsoAllowDates,
      ];
      for (const d of dates) {
        expect(new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10), `${c.id} ${d}`).toBe(d);
      }
    }
  });

  it('covers the traps: corrections, ruled-out outcomes, no-action calls, mono audio, retracted figures', () => {
    const traps = cases.map((c) => c.id).join(' ');
    for (const word of [
      'corrected',
      'no-exchange',
      'no-actions',
      'mono',
      'retracted',
      'wrong-number',
    ]) {
      expect(traps).toContain(word);
    }
  });
});

describe('the scorer', () => {
  it('gives a perfect score to a perfect summary', async () => {
    const report = await evaluate(new OracleSummariser(cases), cases);
    expect(report.metrics).toMatchObject({
      errorRate: 0,
      criticalErrors: 0,
      omissionRate: 0,
      meanActionRecall: 1,
      meanDateRecall: 1,
    });
  });

  it('fails a summary that invents a date', () => {
    const golden = byId('04');
    const score = scoreCase(golden, {
      ...empty,
      keyDates: [{ date: '2026-10-23', description: 'Exchange' }],
    });
    expect(score.critical.map((c) => c.code)).toEqual(['fabricated_date']);
  });

  it('fails a summary that invents an action on a call that settled nothing', () => {
    const score = scoreCase(byId('08'), {
      ...empty,
      actions: [{ description: 'Send the contract', owner: 'fee_earner', due: null }],
    });
    expect(score.critical.map((c) => c.code)).toEqual(['fabricated_action']);
  });

  it('fails an action given to the wrong person, or with the wrong date', () => {
    const golden = byId('01');
    const swapped = scoreCase(golden, {
      ...empty,
      actions: [
        {
          description: 'Send photo ID and proof of address',
          owner: 'fee_earner',
          due: '2026-10-09',
        },
      ],
    });
    expect(swapped.critical.map((c) => c.code)).toContain('wrong_owner');
    const wrongDate = scoreCase(golden, {
      ...empty,
      actions: [
        { description: 'Send photo ID and proof of address', owner: 'caller', due: '2026-10-12' },
      ],
    });
    expect(wrongDate.critical.map((c) => c.code)).toContain('wrong_date');
  });

  it('tolerates a cautious "unclear" owner, but reports the omission it implies as nothing worse', () => {
    const score = scoreCase(byId('01'), {
      ...empty,
      actions: [
        { description: 'Send photo ID and proof of address', owner: 'unclear', due: '2026-10-09' },
      ],
    });
    expect(score.critical).toEqual([]);
  });

  it('fails a summary that reports the retracted date, the ruled-out outcome, or the retracted figure', () => {
    const retractedDate = scoreCase(byId('03'), {
      ...empty,
      summary: 'Completion will be on the 30th of October.',
    });
    expect(retractedDate.critical.map((c) => c.code)).toContain('contradiction');
    const ruledOut = scoreCase(byId('04'), {
      ...empty,
      summary: 'The matter has exchanged on Friday.',
    });
    expect(ruledOut.critical.map((c) => c.code)).toContain('contradiction');
    const retractedFigure = scoreCase(byId('12'), {
      ...empty,
      summary: 'Stamp duty will be £5,000.',
    });
    expect(retractedFigure.critical.map((c) => c.code)).toContain('contradiction');
  });

  it('matches whole words: "id" is not found inside "provider"', () => {
    const score = scoreCase(byId('01'), {
      ...empty,
      actions: [{ description: 'Chase the search provider', owner: 'fee_earner', due: null }],
    });
    expect(score.omissions.some((o) => o.startsWith('action 1 missing'))).toBe(true);
  });

  it('counts a summariser that throws, or returns nonsense, as invalid output', async () => {
    const throws: Summariser = {
      name: 'throws',
      promptVersion: 'x',
      summarise: () => Promise.reject(new Error('refused')),
    };
    const garbage = fixed({ summary: '', actions: [], keyDates: [] }, 'garbage');
    for (const s of [throws, garbage]) {
      const report = await evaluate(s, cases);
      expect(report.metrics.errorRate).toBe(1);
      expect(report.scores.every((x) => x.critical[0]?.code === 'invalid_output')).toBe(true);
    }
  });

  it('shows the error rate move when the summariser changes', async () => {
    const careless = await evaluate(
      fixed({ ...empty, keyDates: [{ date: '2026-12-25', description: 'made up' }] }, 'careless'),
      cases,
    );
    const silent = await evaluate(fixed(empty, 'silent'), cases);
    const rules = await evaluate(new RuleBasedSummariser(), cases);
    const oracle = await evaluate(new OracleSummariser(cases), cases);
    expect(careless.metrics.errorRate).toBe(1); // invents a date on every call
    expect(silent.metrics.errorRate).toBeLessThan(rules.metrics.errorRate + 1e-9); // says little, wrong never...
    expect(silent.metrics.omissionRate).toBeGreaterThan(rules.metrics.omissionRate); // ...but leaves things out
    expect(rules.metrics.errorRate).toBeLessThan(careless.metrics.errorRate);
    expect(oracle.metrics.errorRate).toBe(0);
  });
});

describe('the committed baseline (this is the CI gate)', () => {
  it('the rule-based summariser has not got worse', async () => {
    const report = await evaluate(new RuleBasedSummariser(), cases);
    const baseline = readBaseline();
    // The report is printed on every run, so the numbers are in the CI log, not just pass/fail.
    console.log(`\n${formatReport(report, baseline)}\n`);
    const { regressions } = compareToBaseline(report, baseline);
    expect(regressions, `the golden-set score got worse:\n${regressions.join('\n')}`).toEqual([]);
  });

  it('the baseline does not claim a better score than the summariser earns', async () => {
    const report = await evaluate(new RuleBasedSummariser(), cases);
    const { improvements } = compareToBaseline(report, readBaseline());
    // Not a failure to improve; a failure to record it. Run `pnpm eval rule-based --update-baseline`.
    expect(
      improvements,
      'scores improved: record them with `pnpm eval rule-based --update-baseline`',
    ).toEqual([]);
  });

  it('a prompt change is visible in the fingerprint that names the recorded model runs', () => {
    expect(promptFingerprint()).toMatch(/^call-summary-.*-[0-9a-f]{12}$/);
  });

  it('model runs, if any have been recorded, were recorded under the current prompt, and still pass', async () => {
    const recorded = cassetteFingerprints('anthropic');
    if (recorded.length === 0) {
      console.log(
        '\nanthropic: NOT SCORED. No model run has been recorded (needs credentials: `pnpm eval anthropic --record`).\n',
      );
      return;
    }
    expect(
      recorded,
      `the prompt changed since the model was last scored (recorded ${recorded.join(', ')}, current ${promptFingerprint()}). Re-run: pnpm eval anthropic --record`,
    ).toContain(promptFingerprint());
    const report = await evaluate(new CassetteSummariser('anthropic', goldenLookup(cases)), cases);
    console.log(`\n${formatReport(report, readBaseline())}\n`);
    expect(compareToBaseline(report, readBaseline()).regressions).toEqual([]);
  });

  it('labels a golden call the way the pipeline does', () => {
    const mono = byId('07');
    expect(labelSegments(mono.segments, mono.channels).every((s) => s.speaker === null)).toBe(true);
  });
});
