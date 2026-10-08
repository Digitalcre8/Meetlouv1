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
