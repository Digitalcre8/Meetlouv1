import type { Summary } from '@meetlou/providers';
import type { GoldenCase } from './golden';

export type CriticalCode =
  | 'invalid_output'
  | 'fabricated_action'
  | 'fabricated_date'
  | 'wrong_owner'
  | 'wrong_date'
  | 'contradiction';

export interface CaseScore {
  id: string;
  /** Things that make the summary wrong. Any one fails the case. */
  critical: { code: CriticalCode; detail: string }[];
  /** Things it left out. Less serious than a wrong statement, but tracked. */
  omissions: string[];
  actionRecall: number;
  actionPrecision: number;
  dateRecall: number;
  datePrecision: number;
  mentionCoverage: number;
}

/** A term appears in the text starting at a word boundary, so "id" is not found inside "provider". */
function has(text: string, term: string): boolean {
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}`).test(text);
}

const ratio = (num: number, den: number) => (den === 0 ? 1 : num / den);

function haystackOf(summary: Summary): string {
  return [
    summary.summary,
    ...summary.actions.map((a) => a.description),
    ...summary.keyDates.map((d) => d.description),
  ]
    .join(' \n ')
    .toLowerCase();
}

export function invalidScore(id: string, detail: string): CaseScore {
  return {
    id,
    critical: [{ code: 'invalid_output', detail }],
    omissions: [],
    actionRecall: 0,
    actionPrecision: 0,
    dateRecall: 0,
    datePrecision: 0,
    mentionCoverage: 0,
  };
}

/**
 * Score one summary against its golden case. Deterministic, no model involved, so the same
 * summary always scores the same and a change in score is a change in the summary.
 */
export function scoreCase(golden: GoldenCase, summary: Summary): CaseScore {
  const { expected } = golden;
  const critical: CaseScore['critical'] = [];
  const omissions: string[] = [];

  const allowedDates = new Set<string>([
    ...expected.keyDates.map((d) => d.date),
    ...expected.actions.flatMap((a) => a.due ?? []),
    ...expected.alsoAllowDates,
  ]);

  // --- actions: greedy one-to-one matching of output actions to expected actions ---
  const used = new Set<number>();
  let matchedExpected = 0;
  for (const [i, want] of expected.actions.entries()) {
    const index = summary.actions.findIndex(
      (a, j) =>
        !used.has(j) &&
        want.match.every((group) => group.some((alt) => has(a.description.toLowerCase(), alt))),
    );
    const got = summary.actions[index];
    if (got === undefined) {
      omissions.push(`action ${i + 1} missing: ${want.match.map((g) => g[0]).join(' + ')}`);
      continue;
    }
    used.add(index);
    matchedExpected++;
    if (got.owner !== 'unclear' && !want.owner.includes(got.owner)) {
      critical.push({
        code: 'wrong_owner',
        detail: `"${got.description}" owner ${got.owner}, expected ${want.owner.join('|')}`,
      });
    }
    if (got.due !== null) {
      const right = want.due ?? [];
      if (right.length > 0 ? !right.includes(got.due) : !allowedDates.has(got.due)) {
        critical.push({
          code: 'wrong_date',
          detail: `"${got.description}" due ${got.due}, expected ${right.join('|') || 'none stated'}`,
        });
      }
    } else if ((want.due ?? []).length > 0) {
      omissions.push(`action ${i + 1} has no due date (expected ${want.due?.join('|')})`);
    }
  }
  for (const [j, a] of summary.actions.entries()) {
    if (used.has(j)) continue;
    // With nothing expected, any action is invented. With some expected, an extra one is an
    // imprecision, visible in actionPrecision but not by itself wrong.
    if (expected.actions.length === 0) {
      critical.push({ code: 'fabricated_action', detail: `"${a.description}"` });
    }
    if (a.due !== null && !allowedDates.has(a.due)) {
      critical.push({
        code: 'wrong_date',
        detail: `unmatched action "${a.description}" due ${a.due}`,
      });
    }
  }

  // --- key dates ---
  const outputDates = [...new Set(summary.keyDates.map((d) => d.date))];
  let matchedDates = 0;
  for (const want of expected.keyDates) {
    if (outputDates.includes(want.date)) matchedDates++;
    else omissions.push(`key date missing: ${want.date}`);
  }
  for (const date of outputDates) {
    if (!allowedDates.has(date)) critical.push({ code: 'fabricated_date', detail: date });
  }

  // --- facts ---
  const haystack = haystackOf(summary);
  let mentioned = 0;
  for (const group of expected.mustMention) {
    if (group.some((alt) => has(haystack, alt))) mentioned++;
    else omissions.push(`does not mention: ${group[0]}`);
  }
  for (const banned of expected.mustNotMention) {
    if (has(haystack, banned)) critical.push({ code: 'contradiction', detail: `says "${banned}"` });
  }

  const matchedOutputActions = used.size;
  return {
    id: golden.id,
    critical,
    omissions,
    actionRecall: ratio(matchedExpected, expected.actions.length),
    actionPrecision: ratio(matchedOutputActions, summary.actions.length),
    dateRecall: ratio(matchedDates, expected.keyDates.length),
    datePrecision: ratio(outputDates.filter((d) => allowedDates.has(d)).length, outputDates.length),
    mentionCoverage: ratio(mentioned, expected.mustMention.length),
  };
}

export interface EvalMetrics {
  cases: number;
  /** Share of cases with at least one critical error: the number that must not go up. */
  errorRate: number;
  criticalErrors: number;
  /** Share of cases that left something out. */
  omissionRate: number;
  meanActionRecall: number;
  meanActionPrecision: number;
  meanDateRecall: number;
  meanDatePrecision: number;
  meanMentionCoverage: number;
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const round = (x: number) => Math.round(x * 1000) / 1000;

export function aggregate(scores: CaseScore[]): EvalMetrics {
  const n = scores.length;
  return {
    cases: n,
    errorRate: round(ratio(scores.filter((s) => s.critical.length > 0).length, n)),
    criticalErrors: scores.reduce((sum, s) => sum + s.critical.length, 0),
    omissionRate: round(ratio(scores.filter((s) => s.omissions.length > 0).length, n)),
    meanActionRecall: round(mean(scores.map((s) => s.actionRecall))),
    meanActionPrecision: round(mean(scores.map((s) => s.actionPrecision))),
    meanDateRecall: round(mean(scores.map((s) => s.dateRecall))),
    meanDatePrecision: round(mean(scores.map((s) => s.datePrecision))),
    meanMentionCoverage: round(mean(scores.map((s) => s.mentionCoverage))),
  };
}
