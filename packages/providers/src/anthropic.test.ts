import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicSummariser } from './anthropic.ts';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompt.ts';
import { ProviderError } from './types.ts';

const input = {
  callDate: '2026-10-08',
  recordingChannels: 2 as const,
  segments: [{ startSeconds: 0, speaker: 'caller' as const, text: 'Hello.' }],
};
const good = { summary: 'A short call.', actions: [], keyDates: [] };

function clientReturning(
  response: Partial<{ parsed_output: unknown; stop_reason: string; model: string }>,
) {
  const parse = vi.fn().mockResolvedValue({
    parsed_output: good,
    stop_reason: 'end_turn',
    model: 'claude-opus-5-5',
    ...response,
  });
  return { client: { messages: { parse } } as unknown as Anthropic, parse };
}

describe('Anthropic summariser', () => {
  it('returns the validated summary with the model that answered', async () => {
    const { client } = clientReturning({ model: 'claude-opus-5-5' });
    const out = await new AnthropicSummariser(client).summarise(input);
    expect(out).toEqual({
      summary: good,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      promptVersion: PROMPT_VERSION,
    });
  });

  it('asks for structured output with the approved prompt, and uses none of the removed request features', async () => {
    const { client, parse } = clientReturning({});
    await new AnthropicSummariser(client, { effort: 'high' }).summarise(input);
    const request = parse.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request['model']).toBe('claude-opus-5-5');
    expect(request['system']).toBe(SYSTEM_PROMPT);
    const outputConfig = request['output_config'] as { effort: string; format: unknown };
    expect(outputConfig.effort).toBe('high');
    expect(outputConfig.format).toBeDefined();
    // Removed on this model (a 400): sampling parameters, thinking budgets, forced tool use, prefill.
    for (const removed of [
      'temperature',
      'top_p',
      'top_k',
      'thinking',
      'tool_choice',
      'budget_tokens',
    ]) {
      expect(request).not.toHaveProperty(removed);
    }
    const messages = request['messages'] as { role: string }[];
    expect(messages.at(-1)?.role).toBe('user');
  });

  it.each([
    [{ stop_reason: 'refusal' }, 'refused'],
    [{ stop_reason: 'max_tokens' }, 'truncated'],
    [{ parsed_output: null }, 'invalid_output'],
    [
      { parsed_output: { ...good, keyDates: [{ date: '2026-02-30', description: 'impossible' }] } },
      'invalid_output',
    ],
    [
      { parsed_output: { ...good, actions: [{ description: 'x', owner: 'lawyer', due: null }] } },
      'invalid_output',
    ],
  ])('produces no summary rather than a wrong one: %j', async (response, code) => {
    const { client } = clientReturning(response);
    await expect(new AnthropicSummariser(client).summarise(input)).rejects.toMatchObject({ code });
  });

  it('reports a failed request by status only, never the request', async () => {
    const parse = vi.fn().mockRejectedValue(new Error('boom: includes the transcript text Hello.'));
    const error = await new AnthropicSummariser({ messages: { parse } } as unknown as Anthropic)
      .summarise(input)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('unavailable');
    expect((error as ProviderError).message).not.toContain('Hello');
  });
});
