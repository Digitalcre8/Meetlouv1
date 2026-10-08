import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const EVALS_DIR = fileURLToPath(new URL('../../../../evals/', import.meta.url));

const channel = z.union([z.literal(0), z.literal(1)]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * One transcript with what a correct summary of it must, and must not, say. `match` is a list of
 * groups: an action matches if its description contains at least one alternative from EVERY group
 * (lower-cased). It is deliberately explicit, so a human can see why a paraphrase did or did not count.
 */
export const goldenCaseSchema = z.object({
  id: z.string().regex(/^\d{2}-[a-z0-9-]+$/),
  description: z.string().min(1),
  callDate: isoDate,
  channels: z.union([z.literal(1), z.literal(2)]),
  segments: z
    .array(z.object({ startSeconds: z.number().min(0), channel, text: z.string().min(1) }))
    .min(2),
  expected: z.object({
    actions: z.array(
      z.object({
        match: z.array(z.array(z.string().min(1)).min(1)).min(1),
        /** Owners that are right. 'unclear' is always tolerated (cautious, not wrong). */
        owner: z.array(z.enum(['caller', 'fee_earner', 'other', 'unclear'])).min(1),
        /** Dates that are right for this action's due. Absent: no due date was stated. */
        due: z.array(isoDate).optional(),
      }),
    ),
    keyDates: z.array(z.object({ date: isoDate })),
    /** Each group: at least one alternative must appear in the summary, actions or dates. */
    mustMention: z.array(z.array(z.string().min(1)).min(1)),
    /** None of these may appear anywhere in the output: they are wrong, retracted or ruled out. */
    mustNotMention: z.array(z.string().min(1)),
    /** Dates that may appear without being a fabrication (e.g. "today"). */
    alsoAllowDates: z.array(isoDate),
  }),
});
export type GoldenCase = z.infer<typeof goldenCaseSchema>;

export function loadGoldenSet(): GoldenCase[] {
  const dir = `${EVALS_DIR}golden/`;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => goldenCaseSchema.parse(JSON.parse(readFileSync(`${dir}${f}`, 'utf8'))));
}
