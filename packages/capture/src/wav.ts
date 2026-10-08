export type WavHeader = {
  /** From bytes 22 and 23 (little-endian uint16): 1 = mono, 2 = stereo. */
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
};

export type WavError =
  'too_short' | 'not_riff' | 'not_wave' | 'no_fmt_chunk' | 'unsupported_channels';

/**
 * Read the channel count of a downloaded recording straight from its bytes. A canonical WAV
 * header is: 'RIFF' (0-3), size (4-7), 'WAVE' (8-11), 'fmt ' (12-15), fmt size (16-19),
 * format tag (20-21), NUMBER OF CHANNELS (22-23), sample rate (24-27), ... bits per sample (34-35).
 *
 * Twilio's claim about channels is not evidence; the audio we hold is.
 */
export function parseWavHeader(
  bytes: Uint8Array,
): { ok: true; header: WavHeader } | { ok: false; error: WavError } {
  if (bytes.length < 36) return { ok: false, error: 'too_short' };
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) !== 'RIFF') return { ok: false, error: 'not_riff' };
  if (ascii(8, 12) !== 'WAVE') return { ok: false, error: 'not_wave' };
  if (ascii(12, 16) !== 'fmt ') return { ok: false, error: 'no_fmt_chunk' };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(22, true);
  if (channels !== 1 && channels !== 2) return { ok: false, error: 'unsupported_channels' };
  return {
    ok: true,
    header: {
      channels,
      sampleRate: view.getUint32(24, true),
      bitsPerSample: view.getUint16(34, true),
    },
  };
}
