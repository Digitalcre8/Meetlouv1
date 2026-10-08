import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AccessStore } from './recording-access.ts';

/**
 * `admin` is the service-role client (it writes the audit row and signs the link); the caller's
 * own token is used, with the anon key, to ask whether THEY can see the recording under RLS.
 */
export class SupabaseAccessStore implements AccessStore {
  constructor(
    private readonly admin: SupabaseClient,
    private readonly project: { url: string; anonKey: string },
    private readonly bucket = 'recordings',
  ) {}

  async authenticate(jwt: string): Promise<string | null> {
    const user = await this.admin.auth.getUser(jwt);
    return user.error === null ? user.data.user.id : null;
  }

  async canSeeRecording(jwt: string, recordingId: string): Promise<boolean> {
    const asUser = createClient(this.project.url, this.project.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const found = await asUser
      .from('call_recordings')
      .select('id')
      .eq('id', recordingId)
      .maybeSingle();
    if (found.error !== null) throw new Error(`canSeeRecording: ${found.error.message}`);
    return found.data !== null;
  }

  async recordAccess(recordingId: string, userId: string): Promise<string> {
    const result = await this.admin.rpc('record_recording_access', {
      p_recording_id: recordingId,
      p_user_id: userId,
    });
    if (result.error !== null) throw new Error(`recordAccess: ${result.error.message}`);
    return z.string().parse(result.data);
  }

  async sign(storagePath: string, seconds: number): Promise<string | null> {
    const signed = await this.admin.storage.from(this.bucket).createSignedUrl(storagePath, seconds);
    return signed.error === null ? signed.data.signedUrl : null;
  }
}
