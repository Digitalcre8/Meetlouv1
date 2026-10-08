import { datesIn } from './dates.ts';
import type { ActionOwner } from './summary.ts';
import type { LabelledSegment, SummariseInput, SummariseResult, Summariser } from './types.ts';

export const RULE_BASED_VERSION = 'rule-based-v1';

const COMMIT_SELF =
  /\b(i'll|i will|we'll|we will|i'm going to|i am going to|i'll be|let me|i can|we can)\b/i;
const ASK_OTHER =
  /\b(can you|could you|would you|will you|please (?:send|chase|confirm|sign|return|let|get)|i need you to|you'll need to|you will need to)\b/i;
const TOPIC =
  /\b(search|mortgage|deposit|exchange|completion|enquir|survey|indemnity|sewer|build[- ]over|offer|contract|ta6|ta10|con29|llc1|chain|stamp duty|insurance)/i;

function sentences(segments: LabelledSegment[]) {
  return segments.flatMap((s) =>
    s.text
      .split(/(?<=[.!?])\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map((text) => ({ speaker: s.speaker, text })),
  );
}

const other = (speaker: LabelledSegment['speaker']): ActionOwner =>
  speaker === 'caller' ? 'fee_earner' : speaker === 'fee_earner' ? 'caller' : 'unclear';
const self = (speaker: LabelledSegment['speaker']): ActionOwner => speaker ?? 'unclear';

/**
 * A summariser with no model in it: pattern matching on commitments and dates. It exists to be
 * the floor the real model has to beat, to give the evaluation something deterministic to score
 * in CI, and to let the pipeline run end to end offline. It is not meant to be good.
 */
export class RuleBasedSummariser implements Summariser {
  readonly name = 'rule-based';
  readonly promptVersion = RULE_BASED_VERSION;

  summarise(input: SummariseInput): Promise<SummariseResult> {
    const all = sentences(input.segments);

    const actions = all.flatMap(({ speaker, text }) => {
      const owner = ASK_OTHER.test(text)
        ? other(speaker)
        : COMMIT_SELF.test(text)
          ? self(speaker)
          : null;
      if (owner === null) return [];
      const due = datesIn(text, input.callDate)[0] ?? null;
      return [{ description: text.slice(0, 300), owner, due }];
    });

    const seen = new Set<string>();
    const keyDates = all.flatMap(({ text }) =>
      datesIn(text, input.callDate).flatMap((date) => {
        if (seen.has(date)) return [];
        seen.add(date);
        return [{ date, description: text.slice(0, 300) }];
      }),
    );

    const topical = all.filter((s) => TOPIC.test(s.text)).slice(0, 3);
    const lead = (topical.length > 0 ? topical : all.slice(0, 2)).map((s) => s.text).join(' ');
    return Promise.resolve({
      summary: {
        summary: lead.length > 0 ? lead.slice(0, 2000) : 'No content was recorded on this call.',
        actions,
        keyDates,
      },
      provider: this.name,
      model: RULE_BASED_VERSION,
      promptVersion: this.promptVersion,
    });
  }
}
