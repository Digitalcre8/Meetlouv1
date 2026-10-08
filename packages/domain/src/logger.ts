/**
 * Structured logging that cannot carry content. There is no free-text field: only the
 * identifiers and outcomes below can be logged, so a recording URL, transcript, email body
 * or secret has nowhere to go (non-negotiable 10). Add a field here deliberately, never a
 * `[key: string]: unknown`.
 */
export interface LogFields {
  /** Which handler/route emitted this. */
  route?: string;
  /** What happened, as a short code: 'accepted', 'rejected_signature', 'unrouted', ... */
  outcome?: string;
  status?: number;
  callSid?: string;
  matterId?: string;
  firmId?: string;
  callId?: string;
  recordingSid?: string;
  channels?: number;
  /** Suppression reasons applied, comma-separated. */
  suppressed?: string;
  created?: boolean;
  /**
   * The message of an infrastructure failure (database/network), truncated. Stores must keep
   * row contents out of their error messages; this is the one free-text field and it exists so
   * a 500 is diagnosable rather than silent.
   */
  failure?: string;
}

export type LogSink = (line: string) => void;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function createLogger(sink: LogSink): Logger {
  const write = (level: 'info' | 'error', event: string, fields: LogFields = {}) => {
    sink(JSON.stringify({ level, event, ...fields }));
  };
  return {
    info: (event, fields) => {
      write('info', event, fields);
    },
    error: (event, fields) => {
      write('error', event, fields);
    },
  };
}

export const silentLogger: Logger = { info: () => undefined, error: () => undefined };
