/** What the job needs from the database and from storage, behind interfaces so its rules are testable offline. */

export interface DueMatter {
  matterId: string;
  firmId: string;
  basis: 'retention_period' | 'erasure_request';
  /** A legal hold is in place. The job never touches a held matter. */
  onHold: boolean;
}

export type BeginOutcome =
  | { status: 'authorised'; runId: string; firmId: string; prefix: string }
  | { status: 'held' | 'not_due' | 'gone' };

export type CompleteOutcome =
  { status: 'erased'; counts: Record<string, number> } | { status: 'held' | 'not_authorised' };

export interface RunSummary {
  examined: number;
  erased: number;
  held: number;
  failed: number;
}

/** The database side. The only credential behind it is the retention role's. */
export interface RetentionDb {
  due(): Promise<DueMatter[]>;
  /** Writes the authorisation (an open erasure run) if, and only if, the database agrees the matter is erasable. */
  begin(matterId: string): Promise<BeginOutcome>;
  /** Deletes the matter's rows. The database refuses unless the matter is authorised and not held. */
  complete(matterId: string): Promise<CompleteOutcome>;
  noteHold(matterId: string): Promise<void>;
  recordRun(summary: RunSummary): Promise<void>;
}

/** The storage side. Idempotent: removing what is already gone is not an error. */
export interface ObjectStore {
  /** Every object path under `prefix` in `bucket`, folders followed. */
  list(bucket: string, prefix: string): Promise<string[]>;
  remove(bucket: string, paths: string[]): Promise<void>;
}

/** Where a matter's evidence objects live, each named `<firm_id>/<matter_id>/...`. */
export const EVIDENCE_BUCKETS = ['recordings', 'emails', 'attachments', 'transcripts'] as const;
