import type {
  AudioInput,
  Segment,
  SummariseInput,
  SummariseResult,
  Summariser,
  TranscribeResult,
  Transcriber,
} from './types.ts';
import type { Summary } from './summary.ts';

/** A transcriber that returns a script, for tests and the offline harness. No audio is decoded. */
export class FakeTranscriber implements Transcriber {
  readonly name = 'fake';
  calls: AudioInput[] = [];
  private runs = 0;

  constructor(
    private readonly script: Segment[] | ((audio: AudioInput) => Segment[]),
    private readonly options: { providerSpeakerCount?: number; model?: string } = {},
  ) {}

  transcribe(audio: AudioInput): Promise<TranscribeResult> {
    this.calls.push(audio);
    this.runs++;
    const segments = typeof this.script === 'function' ? this.script(audio) : this.script;
    return Promise.resolve({
      segments,
      language: 'en-GB',
      provider: this.name,
      model: this.options.model ?? 'fake-1',
      providerJobId: `fake-job-${this.runs}-${crypto.randomUUID()}`,
      providerSpeakerCount: this.options.providerSpeakerCount,
    });
  }
}

/** A summariser that returns a fixed summary and remembers what it was asked. */
export class FakeSummariser implements Summariser {
  readonly name: string;
  readonly promptVersion: string;
  inputs: SummariseInput[] = [];

  constructor(
    private readonly result: Summary | ((input: SummariseInput) => Summary | Promise<Summary>),
    options: { name?: string; promptVersion?: string } = {},
  ) {
    this.name = options.name ?? 'fake';
    this.promptVersion = options.promptVersion ?? 'fake-v1';
  }

  async summarise(input: SummariseInput): Promise<SummariseResult> {
    this.inputs.push(input);
    const summary = typeof this.result === 'function' ? await this.result(input) : this.result;
    return {
      summary,
      provider: this.name,
      model: `${this.name}-model`,
      promptVersion: this.promptVersion,
    };
  }
}
