import { mkdirSync, writeFileSync } from 'node:fs';
import { FIXTURES_DIR } from './fixtures';
import { buildWav } from './wav';

/** Regenerates the committed WAV fixtures. They are deterministic, so a diff means a change. */
export function writeAudioFixtures(): string[] {
  mkdirSync(`${FIXTURES_DIR}audio`, { recursive: true });
  const files = {
    'stereo-2s.wav': buildWav({ channels: 2, seconds: 2 }),
    'mono-2s.wav': buildWav({ channels: 1, seconds: 2 }),
  };
  return Object.entries(files).map(([name, bytes]) => {
    writeFileSync(`${FIXTURES_DIR}audio/${name}`, bytes);
    return name;
  });
}
