import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { PROMPT_VERSION, SYSTEM_PROMPT, renderUserMessage } from './prompt.ts';
import { summarySchema, summaryWireSchema } from './summary.ts';
import { ProviderError } from './types.ts';
import type { SummariseInput, SummariseResult, Summariser } from './types.ts';

/** The parts of the SDK's parsed response that this adapter reads. */
interface ParsedResponse {
  parsed_output: unknown;
  stop_reason: string | null;
  model: string;
}

export interface AnthropicSummariserOptions {
  /** Defaults to claude-opus-5-5. */
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * Summarise with Claude. The response is constrained to the wire schema by structured outputs and
 * then checked again against the strict schema: if either fails, or the model refuses or runs out
 * of room, this throws and no summary exists. A missing summary is better than a wrong one.
 *
 * Thinking is always on for this model and is left at its default; `effort` is the control, and is
 * set explicitly because the default for this model is `medium`.
 */
export class AnthropicSummariser implements Summariser {
  readonly name = 'anthropic';
  readonly promptVersion = PROMPT_VERSION;
  private readonly model: string;
  private readonly effort: NonNullable<AnthropicSummariserOptions['effort']>;

  constructor(
    private readonly client: Anthropic,
    options: AnthropicSummariserOptions = {},
  ) {
    this.model = options.model ?? 'claude-opus-5-5';
    this.effort = options.effort ?? 'medium';
  }

  async summarise(input: SummariseInput): Promise<SummariseResult> {
    let response: ParsedResponse;
    try {
      response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: renderUserMessage(input) }],
        output_config: { effort: this.effort, format: zodOutputFormat(summaryWireSchema) },
      });
    } catch (error) {
      // Status only: the SDK's message can quote the request.
      const status = error instanceof Anthropic.APIError ? String(error.status) : 'network';
      throw new ProviderError('unavailable', `anthropic request failed (${status})`);
    }

    if (response.stop_reason === 'refusal')
      throw new ProviderError('refused', 'the model declined to summarise');
    if (response.stop_reason === 'max_tokens')
      throw new ProviderError('truncated', 'the summary was cut short');

    const checked = summarySchema.safeParse(response.parsed_output);
    if (!checked.success) {
      throw new ProviderError(
        'invalid_output',
        `summary failed validation: ${checked.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      );
    }
    return {
      summary: checked.data,
      provider: this.name,
      model: response.model,
      promptVersion: this.promptVersion,
    };
  }
}
