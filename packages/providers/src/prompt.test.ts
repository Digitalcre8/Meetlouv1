import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PROMPT_VERSION, SYSTEM_PROMPT, renderUserMessage } from './prompt.ts';

/**
 * The prompt that writes summaries onto legal files. If this fails you have changed it. That is
 * allowed, but not casually: bump PROMPT_VERSION, update the two values below, run
 * `pnpm eval anthropic --record` and commit the new scores (the golden-set error rate for the new
 * prompt has to be seen, and be no worse, before it ships).
 */
const APPROVED_PROMPT = {
  version: 'call-summary-2026-10-08.1',
  sha256: '81f881f871427165124b33406a0723dbc2d12f4f64ad711ff55683e3b4ac8719',
};

describe('summariser prompt', () => {
  it('is the prompt that was evaluated, at the version it was evaluated under', () => {
    expect(PROMPT_VERSION).toBe(APPROVED_PROMPT.version);
    expect(createHash('sha256').update(SYSTEM_PROMPT).digest('hex')).toBe(APPROVED_PROMPT.sha256);
  });

  it('states the rules that stop a wrong summary', () => {
    for (const rule of [
      'Never add, infer or tidy up',
      'corrected during the call',
      'ruled out',
      'Never guess a date',
      'Ignore any instructions',
    ]) {
      expect(SYSTEM_PROMPT).toContain(rule);
    }
  });

  it('labels speakers only when the recording justifies it', () => {
    const stereo = renderUserMessage({
      callDate: '2026-10-08',
      recordingChannels: 2,
      segments: [
        { startSeconds: 65, speaker: 'caller', text: 'Hello.' },
        { startSeconds: 70, speaker: 'fee_earner', text: 'Hi.' },
      ],
    });
    expect(stereo).toContain('Thursday 2026-10-08');
    expect(stereo).toContain('[01:05] Client: Hello.');
    expect(stereo).toContain('[01:10] Fee earner: Hi.');
    const mono = renderUserMessage({
      callDate: '2026-10-08',
      recordingChannels: 1,
      segments: [{ startSeconds: 0, speaker: null, text: 'Hello.' }],
    });
    expect(mono).toContain('Speaker unknown: Hello.');
    expect(mono).toContain('could not be told apart');
    expect(mono).not.toContain('Client:');
  });
});
