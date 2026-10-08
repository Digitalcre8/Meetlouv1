import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type {
  BeginOutcome,
  CompleteOutcome,
  DueMatter,
  ObjectStore,
  RetentionDb,
  RunSummary,
} from './ports.ts';

const dueRows = z.array(
  z.object({
    matter_id: z.uuid(),
    firm_id: z.uuid(),
    basis: z.enum(['retention_period', 'erasure_request']),
    on_hold: z.boolean(),
  }),
);

const beginResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('authorised'),
    run_id: z.uuid(),
    firm_id: z.uuid(),
    prefix: z.string(),
  }),
  z.object({ status: z.enum(['held', 'not_due', 'gone']) }),
]);

const completeResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('erased'), counts: z.record(z.string(), z.number()) }),
  z.object({ status: z.enum(['held', 'not_authorised']) }),
]);

/** `client` carries the retention role's token. Nothing else can call these functions. */
export class SupabaseRetentionDb implements RetentionDb {
  constructor(private readonly client: SupabaseClient) {}

  async due(): Promise<DueMatter[]> {
    const result = await this.client.rpc('retention_due');
    if (result.error !== null) throw new Error(`retention_due: ${result.error.message}`);
    return dueRows.parse(result.data).map((row) => ({
      matterId: row.matter_id,
      firmId: row.firm_id,
      basis: row.basis,
      onHold: row.on_hold,
    }));
  }

  async begin(matterId: string): Promise<BeginOutcome> {
    const result = await this.client.rpc('begin_erasure', { p_matter_id: matterId });
    if (result.error !== null) throw new Error(`begin_erasure: ${result.error.message}`);
    const parsed = beginResult.parse(result.data);
    return parsed.status === 'authorised'
      ? {
          status: 'authorised',
          runId: parsed.run_id,
          firmId: parsed.firm_id,
          prefix: parsed.prefix,
        }
      : { status: parsed.status };
  }

  async complete(matterId: string): Promise<CompleteOutcome> {
    const result = await this.client.rpc('complete_erasure', { p_matter_id: matterId });
    if (result.error !== null) throw new Error(`complete_erasure: ${result.error.message}`);
    return completeResult.parse(result.data);
  }

  async noteHold(matterId: string): Promise<void> {
    const result = await this.client.rpc('note_retention_hold', { p_matter_id: matterId });
    if (result.error !== null) throw new Error(`note_retention_hold: ${result.error.message}`);
  }

  async recordRun(summary: RunSummary): Promise<void> {
    const result = await this.client.rpc('record_retention_run', {
      p_examined: summary.examined,
      p_erased: summary.erased,
      p_held: summary.held,
      p_failed: summary.failed,
    });
    if (result.error !== null) throw new Error(`record_retention_run: ${result.error.message}`);
  }
}

const PAGE = 1000;

/** `client` is the service-role client: the platform owns the grants on storage.objects. */
export class SupabaseObjectStore implements ObjectStore {
  constructor(private readonly client: SupabaseClient) {}

  async list(bucket: string, prefix: string): Promise<string[]> {
    const found: string[] = [];
    const folders = [prefix];
    for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
      for (let offset = 0; ; offset += PAGE) {
        const page = await this.client.storage
          .from(bucket)
          .list(folder, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
        if (page.error !== null) throw new Error(`list ${bucket}: ${page.error.message}`);
        for (const entry of page.data) {
          // A folder has no id; an object does.
          if (entry.id === null) folders.push(`${folder}/${entry.name}`);
          else found.push(`${folder}/${entry.name}`);
        }
        if (page.data.length < PAGE) break;
      }
    }
    return found;
  }

  async remove(bucket: string, paths: string[]): Promise<void> {
    for (let i = 0; i < paths.length; i += PAGE) {
      const removed = await this.client.storage.from(bucket).remove(paths.slice(i, i + PAGE));
      if (removed.error !== null) throw new Error(`remove ${bucket}: ${removed.error.message}`);
    }
  }
}
