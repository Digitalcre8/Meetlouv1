import { silentLogger } from '@meetlou/domain';
import type { Logger } from '@meetlou/domain';
import { EVIDENCE_BUCKETS } from './ports.ts';
import type { ObjectStore, RetentionDb, RunSummary } from './ports.ts';

/**
 * One pass of the retention job, and the only code that causes deletion.
 *
 * Per matter: ask the database to authorise (it checks the period, any approved erasure request
 * and legal hold itself), empty the matter's evidence folders and confirm they are empty, then
 * ask the database to delete the rows. Storage goes first so a crash can only leave rows
 * pointing at nothing, which a re-run finishes; it can never leave objects with no row
 * to say they exist. A matter on legal hold is never begun, and one that acquires a hold
 * part-way is refused at the final step by the database.
 *
 * One matter failing never stops the others, and nothing here logs content: identifiers and
 * outcomes only.
 */
export async function runRetention(deps: {
  db: RetentionDb;
  objects: ObjectStore;
  log?: Logger;
}): Promise<RunSummary> {
  const { db, objects } = deps;
  const log = deps.log ?? silentLogger;
  const summary: RunSummary = { examined: 0, erased: 0, held: 0, failed: 0 };

  const due = await db.due();
  for (const matter of due) {
    summary.examined += 1;
    try {
      if (matter.onHold) {
        await db.noteHold(matter.matterId);
        summary.held += 1;
        log.info('retention', { outcome: 'held', matterId: matter.matterId });
        continue;
      }

      const begun = await db.begin(matter.matterId);
      if (begun.status === 'held') {
        await db.noteHold(matter.matterId);
        summary.held += 1;
        log.info('retention', { outcome: 'held', matterId: matter.matterId });
        continue;
      }
      if (begun.status !== 'authorised') {
        log.info('retention', { outcome: begun.status, matterId: matter.matterId });
        continue;
      }

      for (const bucket of EVIDENCE_BUCKETS) {
        const found = await objects.list(bucket, begun.prefix);
        if (found.length > 0) await objects.remove(bucket, found);
        const left = await objects.list(bucket, begun.prefix);
        if (left.length > 0) {
          throw new Error(`${String(left.length)} objects remain in ${bucket}`);
        }
      }

      const done = await db.complete(matter.matterId);
      if (done.status === 'erased') {
        summary.erased += 1;
        log.info('retention', { outcome: 'erased', matterId: matter.matterId });
      } else if (done.status === 'held') {
        summary.held += 1;
        log.info('retention', { outcome: 'held_before_delete', matterId: matter.matterId });
      } else {
        log.info('retention', { outcome: done.status, matterId: matter.matterId });
      }
    } catch (error) {
      summary.failed += 1;
      log.error('retention', {
        outcome: 'failed',
        matterId: matter.matterId,
        failure: (error instanceof Error ? error.message : 'unknown').slice(0, 200),
      });
    }
  }

  await db.recordRun(summary);
  return summary;
}
