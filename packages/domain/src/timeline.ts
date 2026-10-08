import { z } from 'zod';

export const audience = z.enum(['firm', 'client', 'chain']);
export type Audience = z.infer<typeof audience>;

/** One line of a matter's timeline, as the API returns it. */
export const timelineRow = z.object({
  event_id: z.uuid(),
  matter_id: z.uuid(),
  kind: z.string(),
  visibility: audience,
  subject_kind: z.string().nullable(),
  subject_id: z.uuid().nullable(),
  occurred_at: z.string(),
  recorded_at: z.string(),
  actor_kind: z.string(),
  /** Only ever set for the firm: participants never learn which firm user wrote an event. */
  actor_id: z.uuid().nullable(),
  summary: z.string().nullable(),
  /** When the caller opened it, if they have. */
  read_at: z.string().nullable(),
});
export type TimelineRow = z.infer<typeof timelineRow>;

export interface TimelineCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Do the three audiences differ in the right ways? Pure, so the verification page and its tests
 * share it. "Right" means: the audiences nest (firm contains client contains chain); an event
 * never reaches an audience wider than its visibility; documents never reach the chain; and no
 * participant is shown which firm user wrote anything.
 */
export function compareAudiences(
  firm: TimelineRow[],
  client: TimelineRow[],
  chain: TimelineRow[],
): TimelineCheck[] {
  const ids = (rows: TimelineRow[]) => new Set(rows.map((r) => r.event_id));
  const firmIds = ids(firm);
  const clientIds = ids(client);
  const chainIds = ids(chain);
  const missing = (small: Set<string>, big: Set<string>) =>
    [...small].filter((id) => !big.has(id)).length;
  const leaks = (rows: TimelineRow[], banned: string[]) =>
    rows.filter((r) => banned.includes(r.visibility)).length;

  const checks: TimelineCheck[] = [
    {
      name: 'the audiences nest: chain is within client, client is within firm',
      ok: missing(chainIds, clientIds) === 0 && missing(clientIds, firmIds) === 0,
      detail: `${chain.length} chain, ${client.length} client, ${firm.length} firm`,
    },
    {
      name: 'nothing firm-only reaches the client or the chain',
      ok: leaks(client, ['firm']) === 0 && leaks(chain, ['firm']) === 0,
      detail: `${leaks(client, ['firm']) + leaks(chain, ['firm'])} leaked`,
    },
    {
      name: 'nothing client-only reaches the chain',
      ok: leaks(chain, ['client']) === 0,
      detail: `${leaks(chain, ['client'])} leaked`,
    },
    {
      name: 'every chain-visible event reaches all three audiences',
      ok: firm
        .filter((r) => r.visibility === 'chain')
        .every((r) => clientIds.has(r.event_id) && chainIds.has(r.event_id)),
      detail: `${firm.filter((r) => r.visibility === 'chain').length} chain-visible`,
    },
    {
      name: 'every client-visible event reaches the client',
      ok: firm.filter((r) => r.visibility === 'client').every((r) => clientIds.has(r.event_id)),
      detail: `${firm.filter((r) => r.visibility === 'client').length} client-visible`,
    },
    {
      name: 'no document event reaches the chain',
      ok: chain.every((r) => r.subject_kind !== 'attachment'),
      detail: `${chain.filter((r) => r.subject_kind === 'attachment').length} document events in the chain view`,
    },
    {
      name: 'participants are not told which firm user wrote an event',
      ok: [...client, ...chain].every((r) => r.actor_id === null),
      detail: `${[...client, ...chain].filter((r) => r.actor_id !== null).length} actor ids exposed`,
    },
    {
      name: 'the three audiences are not all the same (otherwise this matter proves nothing)',
      ok: firm.length > client.length || client.length > chain.length,
      detail:
        firm.length > client.length || client.length > chain.length ? 'they differ' : 'identical',
    },
  ];
  return checks;
}
