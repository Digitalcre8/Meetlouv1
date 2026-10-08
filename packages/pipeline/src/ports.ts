export interface RecordingJob {
  recordingId: string;
  recordingSid: string;
  firmId: string;
  matterId: string;
  callId: string;
  callSid: string;
  storagePath: string;
  channels: 1 | 2;
  durationSeconds: number;
  callStartedAt: Date;
}

export interface TranscriptRef {
  transcriptId: string;
  version: number;
  bodyStoragePath: string;
  recordingId: string;
}

export interface StoreTranscriptInput {
  recordingId: string;
  provider: string;
  providerJobId: string;
  model: string;
  diarised: boolean;
  speakerCount: number | null;
  language: string | null;
  bodyStoragePath: string;
  sha256: string;
}

export interface StoreOutputInput {
  callId: string;
  transcriptId: string;
  provider: string;
  model: string;
  promptVersion: string;
  runId: string;
  content: unknown;
  contentSha256: string;
}

export type PipelineIssue = 'recording.transcription_failed' | 'recording.summary_failed';

/** What the pipeline needs from the database. Throws on infrastructure failure. */
export interface PipelineStore {
  listAwaitingTranscription(limit: number): Promise<RecordingJob[]>;
  listAwaitingSummary(limit: number): Promise<TranscriptRef[]>;
  getRecording(recordingId: string): Promise<RecordingJob | null>;
  getTranscript(transcriptId: string): Promise<TranscriptRef | null>;
  /** The latest, unsuperseded transcript of a recording. */
  getCurrentTranscript(recordingId: string): Promise<TranscriptRef | null>;
  /** The recording of a call (the latest one, if there is more than one). */
  getRecordingForCall(callId: string): Promise<RecordingJob | null>;
  storeTranscript(
    input: StoreTranscriptInput,
  ): Promise<{ transcriptId: string; version: number; created: boolean }>;
  storeOutput(
    input: StoreOutputInput,
  ): Promise<{ outputId: string; version: number; created: boolean }>;
  recordIssue(input: { action: PipelineIssue; job: RecordingJob; reason: string }): Promise<void>;
}

/** Private object storage, by bucket. */
export interface BlobStore {
  get(bucket: string, path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  put(
    bucket: string,
    path: string,
    bytes: Uint8Array<ArrayBuffer>,
    contentType: string,
  ): Promise<'created' | 'exists'>;
}
