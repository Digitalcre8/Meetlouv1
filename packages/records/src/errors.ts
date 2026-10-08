import type { PostgrestError } from '@supabase/supabase-js';
import type { ZodError } from 'zod';
import { err } from '@meetlou/domain';

export type RecordErrorCode =
  'invalid_input' | 'not_permitted' | 'conflict' | 'database' | 'ambiguous_firm';

export interface RecordError {
  code: RecordErrorCode;
  /** Field paths or a database message. Never input values. */
  message: string;
}

export function invalidInput(error: ZodError) {
  const fields = error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
  return err<RecordError>({ code: 'invalid_input', message: `invalid: ${fields}` });
}

export function fromPostgrest(error: PostgrestError) {
  const code: RecordErrorCode =
    error.code === '42501' ? 'not_permitted' : error.code === '23505' ? 'conflict' : 'database';
  // error.message is Postgres' own wording; error.details (which can quote values) is dropped.
  return err<RecordError>({ code, message: error.message });
}
