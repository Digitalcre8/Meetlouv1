import { describe, expect, it } from 'vitest';
import { runRetention } from './run.ts';
import type {
  BeginOutcome,
  CompleteOutcome,
  DueMatter,
  ObjectStore,
  RetentionDb,
  RunSummary,
} from './ports.ts';

const FIRM = '11111111-1111-4111-8111-111111111111';
const MATTER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

class FakeDb implements RetentionDb {
  readonly calls: string[] = [];
  recorded: RunSummary | undefined;
  failCompleteOnce = false;
  constructor(
    private readonly matters: DueMatter[],
    private readonly begin_: (id: string) => BeginOutcome,
    private readonly complete_: (id: string) => CompleteOutcome = () => ({
      status: 'erased',
      counts: { matters: 1 },
    }),
  ) {}
  due(): Promise<DueMatter[]> {
    this.calls.push('due');
    return Promise.resolve(this.matters);
  }
  begin(id: string): Promise<BeginOutcome> {
    this.calls.push(`begin:${id}`);
    return Promise.resolve(this.begin_(id));
  }
  complete(id: string): Promise<CompleteOutcome> {
    this.calls.push(`complete:${id}`);
    if (this.failCompleteOnce) {
      this.failCompleteOnce = false;
      return Promise.reject(new Error('connection lost'));
    }
    return Promise.resolve(this.complete_(id));
  }
  noteHold(id: string): Promise<void> {
    this.calls.push(`hold:${id}`);
    return Promise.resolve();
  }
  recordRun(summary: RunSummary): Promise<void> {
    this.recorded = summary;
    return Promise.resolve();
  }
}

class FakeObjects implements ObjectStore {
  readonly removed: string[] = [];
  failRemove = false;
  constructor(public objects: Map<string, string[]>) {}
  list(bucket: string, prefix: string): Promise<string[]> {
    return Promise.resolve(
      (this.objects.get(bucket) ?? []).filter((p) => p.startsWith(`${prefix}/`)),
    );
  }
  remove(bucket: string, paths: string[]): Promise<void> {
    if (this.failRemove) return Promise.reject(new Error('storage unavailable'));
    this.removed.push(...paths);
    this.objects.set(
      bucket,
      (this.objects.get(bucket) ?? []).filter((p) => !paths.includes(p)),
    );
    return Promise.resolve();
  }
}

const due = (matterId: string, onHold = false): DueMatter => ({
  matterId,
  firmId: FIRM,
  basis: 'retention_period',
  onHold,
});
const authorised = (id: string): BeginOutcome => ({
  status: 'authorised',
  runId: '44444444-4444-4444-8444-444444444444',
  firmId: FIRM,
  prefix: `${FIRM}/${id}`,
});
const stored = () =>
  new Map([
    ['recordings', [`${FIRM}/${MATTER}/RE1.wav`, `${FIRM}/${OTHER}/RE2.wav`]],
    ['emails', [`${FIRM}/${MATTER}/m1/raw.eml`]],
  ]);

describe('the retention job', () => {
  it('empties the matter’s folders, then asks the database to delete the rows, in that order', async () => {
    const db = new FakeDb([due(MATTER)], authorised);
    const objects = new FakeObjects(stored());
    const summary = await runRetention({ db, objects });
    expect(summary).toEqual({ examined: 1, erased: 1, held: 0, failed: 0 });
    expect(objects.removed.sort()).toEqual([
      `${FIRM}/${MATTER}/RE1.wav`,
      `${FIRM}/${MATTER}/m1/raw.eml`,
    ]);
    expect(db.calls).toEqual(['due', `begin:${MATTER}`, `complete:${MATTER}`]);
    expect(db.recorded).toEqual(summary);
    // Another matter's objects are not touched.
    expect(objects.objects.get('recordings')).toEqual([`${FIRM}/${OTHER}/RE2.wav`]);
  });

  it('never begins, empties or deletes a matter on legal hold, and says so', async () => {
    const db = new FakeDb([due(MATTER, true)], authorised);
    const objects = new FakeObjects(stored());
    const summary = await runRetention({ db, objects });
    expect(summary).toEqual({ examined: 1, erased: 0, held: 1, failed: 0 });
    expect(db.calls).toEqual(['due', `hold:${MATTER}`]);
    expect(objects.removed).toEqual([]);
  });

  it('stops at a hold the database finds that the list did not', async () => {
    const db = new FakeDb([due(MATTER)], () => ({ status: 'held' }));
    const objects = new FakeObjects(stored());
    const summary = await runRetention({ db, objects });
    expect(summary.held).toBe(1);
    expect(objects.removed).toEqual([]);
    expect(db.calls).not.toContain(`complete:${MATTER}`);
  });

  it('does nothing for a matter the database says is not due', async () => {
    const db = new FakeDb([due(MATTER)], () => ({ status: 'not_due' }));
    const objects = new FakeObjects(stored());
    expect(await runRetention({ db, objects })).toEqual({
      examined: 1,
      erased: 0,
      held: 0,
      failed: 0,
    });
    expect(objects.removed).toEqual([]);
  });

  it('does not delete the rows while objects are still there, and finishes on the next run', async () => {
    const db = new FakeDb([due(MATTER)], authorised);
    const objects = new FakeObjects(stored());
    objects.failRemove = true;
    expect((await runRetention({ db, objects })).failed).toBe(1);
    expect(db.calls).not.toContain(`complete:${MATTER}`);

    objects.failRemove = false;
    expect(await runRetention({ db, objects })).toEqual({
      examined: 1,
      erased: 1,
      held: 0,
      failed: 0,
    });
  });

  it('survives a crash between emptying storage and deleting the rows', async () => {
    const db = new FakeDb([due(MATTER)], authorised);
    db.failCompleteOnce = true;
    const objects = new FakeObjects(stored());
    expect((await runRetention({ db, objects })).failed).toBe(1);
    // Storage is already empty; the re-run has nothing to remove and completes.
    expect(await runRetention({ db, objects })).toEqual({
      examined: 1,
      erased: 1,
      held: 0,
      failed: 0,
    });
  });

  it('carries on past a matter that fails', async () => {
    const db = new FakeDb([due(MATTER), due(OTHER)], authorised);
    const objects = new FakeObjects(stored());
    let first = true;
    const remove = objects.remove.bind(objects);
    objects.remove = (bucket, paths) => {
      if (first) {
        first = false;
        return Promise.reject(new Error('storage unavailable'));
      }
      return remove(bucket, paths);
    };
    expect(await runRetention({ db, objects })).toEqual({
      examined: 2,
      erased: 1,
      held: 0,
      failed: 1,
    });
  });

  it('logs identifiers and outcomes only', async () => {
    const lines: string[] = [];
    const { createLogger } = await import('@meetlou/domain');
    const db = new FakeDb([due(MATTER)], authorised);
    await runRetention({
      db,
      objects: new FakeObjects(stored()),
      log: createLogger((line) => lines.push(line)),
    });
    expect(lines.join('\n')).toContain('erased');
    expect(lines.join('\n')).not.toMatch(/\.wav|\.eml|RE1/);
  });
});
