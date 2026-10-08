export interface Clock {
  now(): Date;
}

export interface RoutedLine {
  matterId: string;
  firmId: string;
  firmName: string;
  propertyAddress: string;
  /** The responsible fee earner's number, or null if there is none to ring. */
  feeEarnerPhoneE164: string | null;
}

export interface NewCall {
  firmId: string;
  matterId: string;
  callSid: string;
  /** Null when the caller withholds their number. */
  fromE164: string | null;
  toE164: string;
  startedAt: Date;
  consentAnnouncementVersion: string;
  consentGivenAt: Date;
}

/** What the voice webhook needs from the database. Throws on infrastructure failure. */
export interface VoiceStore {
  /** The matter whose line_e164 is the number dialled, or null. */
  findLine(toE164: string): Promise<RoutedLine | null>;
  /** Insert on call_sid, doing nothing if it exists. `created` is false for a redelivery. */
  recordCall(call: NewCall): Promise<{ callId: string; created: boolean }>;
  /** An audit row for a call that could not be routed or connected. Idempotent per call. */
  recordUnroutedCall(input: {
    callSid: string;
    toE164: string;
    reason: UnroutedReason;
  }): Promise<void>;
}

export type UnroutedReason = 'no_matter_for_line' | 'no_fee_earner_number';

// --- recording status callback ---------------------------------------------------------------

export interface CallForRecording {
  callId: string;
  firmId: string;
  matterId: string;
  /** True only if the call row says consent was given. A recording is never fetched otherwise. */
  consentGiven: boolean;
}

export interface IngestRecordingInput {
  callId: string;
  recordingSid: string;
  storagePath: string;
  sha256: string;
  byteLength: number;
  durationSeconds: number;
  /** Read from the WAV header of the downloaded bytes. */
  channels: 1 | 2;
}

export interface IngestRecordingResult {
  recordingId: string;
  /** False for a redelivery: nothing was written. */
  created: boolean;
  /** Suppression reasons applied (misdial, near_duplicate). Empty for a normal call. */
  suppressed: string[];
}

export type RecordingIssue =
  | 'recording.quarantined'
  | 'recording.rejected'
  | 'recording.not_completed'
  | 'recording.download_failed';

export interface RecordingStore {
  findCall(callSid: string): Promise<CallForRecording | null>;
  findRecording(recordingSid: string): Promise<{ recordingId: string } | null>;
  /** One transaction: the recording row, its events, and the guards. Idempotent on recordingSid. */
  ingest(input: IngestRecordingInput): Promise<IngestRecordingResult>;
  /** An audit row naming a recording that was not stored, so it is never lost silently. */
  recordIssue(input: {
    action: RecordingIssue;
    recordingSid: string;
    callSid: string;
    firmId: string | null;
    reason: string;
  }): Promise<void>;
}

export type DownloadResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: 'not_found' | 'unauthorised' | 'too_large' | 'unavailable' };

export interface RecordingDownloader {
  /** Fetch the recording asking for two channels. Where from is the downloader's business. */
  download(recordingSid: string): Promise<DownloadResult>;
}

export interface ObjectStorage {
  /** Store an object at a path in the private recordings bucket. 'exists' if already there. */
  put(
    path: string,
    bytes: Uint8Array<ArrayBuffer>,
    contentType: string,
  ): Promise<'created' | 'exists'>;
}

// --- SendGrid Inbound Parse --------------------------------------------------------------------

export interface InboundKey {
  firmId: string;
  /** SHA-256 (hex) of the secret in the URL. The secret itself is never stored. */
  secretSha256: string;
  revoked: boolean;
}

export interface IngestEmailInput {
  matterId: string;
  messageId: string;
  messageIdSynthesised: boolean;
  inReplyTo: string | null;
  references: string[];
  fromAddress: string;
  to: string[];
  cc: string[];
  subject: string | null;
  sentAt: Date | null;
  rawStoragePath: string;
  rawSha256: string;
  bodyTextStoragePath: string | null;
  bodyHtmlStoragePath: string | null;
  /** The provider's verdicts, verbatim: evidence, not log lines. */
  spfResult: string | null;
  dkimResult: string | null;
  attachments: {
    ordinal: number;
    filename: string;
    contentType: string;
    sniffedContentType: string;
    byteLength: number;
    sha256: string;
    storagePath: string;
  }[];
}

export type EmailIssue = 'email.unrouted' | 'email.rejected' | 'email.duplicate_mismatch';

export interface InboundEmailStore {
  findKey(keyId: string): Promise<InboundKey | null>;
  findMailDomain(firmId: string): Promise<string | null>;
  /** The matter with this slug IF it belongs to this firm; null otherwise (no oracle across firms). */
  findMatterBySlug(firmId: string, slug: string): Promise<{ matterId: string } | null>;
  findEmail(
    matterId: string,
    messageId: string,
  ): Promise<{ emailId: string; rawSha256: string } | null>;
  /** One transaction: email, attachments, events. Idempotent on (matter, Message-ID). */
  ingest(input: IngestEmailInput): Promise<{ emailId: string; created: boolean }>;
  recordIssue(input: {
    action: EmailIssue;
    firmId: string;
    emailSha256: string | null;
    recipientDomain: string | null;
    reason: string;
  }): Promise<void>;
}
