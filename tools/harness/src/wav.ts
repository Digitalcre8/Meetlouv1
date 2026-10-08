/**
 * Builds small, header-accurate PCM WAV files for fixtures: a canonical 44-byte header
 * (RIFF/WAVE/fmt/data), 16-bit little-endian samples. Stereo carries a different tone on each
 * channel (as a real two-party recording does); mono is the mixdown of the two.
 */
export function buildWav(options: {
  channels: 1 | 2;
  seconds?: number;
  sampleRate?: number;
}): Uint8Array<ArrayBuffer> {
  const { channels, seconds = 2, sampleRate = 8000 } = options;
  const bitsPerSample = 16;
  const frames = Math.round(seconds * sampleRate);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataBytes = frames * blockAlign;

  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true); // number of channels: bytes 22-23
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  const tone = (hz: number, frame: number) =>
    Math.round(Math.sin((2 * Math.PI * hz * frame) / sampleRate) * 6000);
  for (let frame = 0; frame < frames; frame++) {
    const left = tone(440, frame);
    const right = tone(660, frame);
    if (channels === 2) {
      view.setInt16(44 + frame * 4, left, true);
      view.setInt16(44 + frame * 4 + 2, right, true);
    } else {
      view.setInt16(44 + frame * 2, Math.round((left + right) / 2), true);
    }
  }
  return bytes;
}
