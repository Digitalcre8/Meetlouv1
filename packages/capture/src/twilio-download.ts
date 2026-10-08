import { toBase64, utf8 } from './bytes.ts';
import type { VoiceConfig } from './config.ts';
import type { DownloadResult, RecordingDownloader } from './ports.ts';

/** About an hour of stereo 8 kHz audio. Anything larger is refused and audited, not buffered. */
export const MAX_RECORDING_BYTES = 150 * 1024 * 1024;

/**
 * Downloads a Dial recording from Twilio's REST API.
 *
 * Two things here are easy to get wrong:
 *  - A Dial recording is dual-channel, but the media URL returns a MONO MIXDOWN unless
 *    RequestedChannels=2 is appended. We always append it.
 *  - The RecordingUrl in the webhook is not used. We build the URL ourselves from configuration
 *    and the recording SID, so a webhook can never make this function fetch an arbitrary URL.
 */
export class TwilioRecordingDownloader implements RecordingDownloader {
  constructor(
    private readonly config: Pick<VoiceConfig, 'accountSid' | 'authToken' | 'apiBaseUrl'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  mediaUrl(recordingSid: string): string {
    const { apiBaseUrl, accountSid } = this.config;
    return `${apiBaseUrl}/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.wav?RequestedChannels=2`;
  }

  async download(recordingSid: string): Promise<DownloadResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.mediaUrl(recordingSid), {
        headers: {
          authorization: `Basic ${toBase64(utf8(`${this.config.accountSid}:${this.config.authToken}`))}`,
          accept: 'audio/wav',
        },
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (response.status === 404) return { ok: false, reason: 'not_found' };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'unauthorised' };
    }
    if (!response.ok) return { ok: false, reason: 'unavailable' };

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_RECORDING_BYTES) return { ok: false, reason: 'too_large' };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RECORDING_BYTES) return { ok: false, reason: 'too_large' };
    return { ok: true, bytes };
  }
}
