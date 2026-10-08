import { describe, expect, it } from 'vitest';
import { datesIn, addDays, weekdayOf } from './dates.ts';
import { RuleBasedSummariser } from './rule-based.ts';
import { summarySchema } from './summary.ts';

const valid = {
  summary: 'The client asked about searches.',
  actions: [{ description: 'Send ID', owner: 'caller', due: '2026-10-09' }],
  keyDates: [{ date: '2026-10-16', description: 'Searches due' }],
};

describe('summary schema', () => {
  it('accepts a well-formed summary', () => {
    expect(summarySchema.safeParse(valid).success).toBe(true);
    expect(summarySchema.safeParse({ ...valid, actions: [], keyDates: [] }).success).toBe(true);
  });
  it('rejects anything that is not exactly the typed object', () => {
    expect(summarySchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(summarySchema.safeParse({ ...valid, summary: '' }).success).toBe(false);
    expect(
      summarySchema.safeParse({
        ...valid,
        actions: [{ description: 'x', owner: 'lawyer', due: null }],
      }).success,
    ).toBe(false);
    expect(
      summarySchema.safeParse({
        ...valid,
        keyDates: [{ date: '2026-02-30', description: 'impossible' }],
      }).success,
    ).toBe(false);
    expect(
      summarySchema.safeParse({
        ...valid,
        keyDates: [{ date: '16/10/2026', description: 'wrong format' }],
      }).success,
    ).toBe(false);
    expect(summarySchema.safeParse({ summary: 'x' }).success).toBe(false);
  });
});

describe('date resolution', () => {
  const thursday = '2026-10-08';
  it('knows the weekday and adds days across a month', () => {
    expect(weekdayOf(thursday)).toBe('thursday');
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
  });
  it('resolves the forms conveyancers use', () => {
    expect(datesIn('back by Friday the 16th of October', thursday)).toEqual(['2026-10-16']);
    expect(datesIn('exchange on the 23rd of October', thursday)).toEqual(['2026-10-23']);
    expect(datesIn('valid until the 18th of December', thursday)).toEqual(['2026-12-18']);
    expect(datesIn('send it tomorrow', thursday)).toEqual(['2026-10-09']);
    expect(datesIn('by Monday', thursday)).toEqual(['2026-10-12']);
    expect(datesIn('before the end of the month', thursday)).toEqual(['2026-10-31']);
    expect(datesIn('on 3 January 2027', thursday)).toEqual(['2027-01-03']);
  });
  it('rolls a date already past into the next year, and ignores what it cannot pin down', () => {
    expect(datesIn('the 2nd of January', '2026-12-20')).toEqual(['2027-01-02']);
    expect(datesIn('sometime soon, maybe', thursday)).toEqual([]);
    expect(datesIn('the 31st of February', thursday)).toEqual([]);
  });
});

describe('rule-based summariser', () => {
  it('returns a summary that satisfies the schema', async () => {
    const out = await new RuleBasedSummariser().summarise({
      callDate: '2026-10-08',
      recordingChannels: 2,
      segments: [
        { startSeconds: 0, speaker: 'fee_earner', text: 'Could you send your ID by tomorrow?' },
        { startSeconds: 4, speaker: 'caller', text: "I'll email it tomorrow morning." },
      ],
    });
    expect(summarySchema.safeParse(out.summary).success).toBe(true);
    expect(out.summary.actions[0]).toMatchObject({ owner: 'caller', due: '2026-10-09' });
    expect(out.summary.actions[1]).toMatchObject({ owner: 'caller' });
  });
  it('does not attribute commitments in a mono recording', async () => {
    const out = await new RuleBasedSummariser().summarise({
      callDate: '2026-10-08',
      recordingChannels: 1,
      segments: [{ startSeconds: 0, speaker: null, text: "I'll send it on Friday." }],
    });
    expect(out.summary.actions[0]?.owner).toBe('unclear');
  });
});
