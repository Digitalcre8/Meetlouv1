import { z } from 'zod';

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export const isoDate = z
  .string()
  .refine(isCalendarDate, { message: 'must be a real calendar date, YYYY-MM-DD' });

export const actionOwner = z.enum(['caller', 'fee_earner', 'other', 'unclear']);
export type ActionOwner = z.infer<typeof actionOwner>;

/**
 * What a model must return. Validated here, after the model, whatever the provider promised:
 * a summary that does not parse is a failure, not a draft.
 */
export const summarySchema = z
  .object({
    /** Plain English, for a client to read. */
    summary: z.string().trim().min(1).max(3000),
    /** Things the call settled that someone is to do. */
    actions: z
      .array(
        z
          .object({
            description: z.string().trim().min(1).max(500),
            owner: actionOwner,
            due: isoDate.nullable(),
          })
          .strict(),
      )
      .max(30),
    /** Dates that were stated or agreed on the call. */
    keyDates: z
      .array(z.object({ date: isoDate, description: z.string().trim().min(1).max(500) }).strict())
      .max(30),
  })
  .strict();
export type Summary = z.infer<typeof summarySchema>;

/**
 * The same shape without refinements, which is what a provider's structured-output feature can
 * express. The real check is summarySchema, applied to whatever comes back.
 */
export const summaryWireSchema = z.object({
  summary: z.string().describe('Plain-English summary of the call, a few sentences.'),
  actions: z.array(
    z.object({
      description: z.string(),
      owner: actionOwner,
      due: z.string().nullable().describe('YYYY-MM-DD, or null if no date was stated.'),
    }),
  ),
  keyDates: z.array(
    z.object({
      date: z.string().describe('YYYY-MM-DD'),
      description: z.string(),
    }),
  ),
});
