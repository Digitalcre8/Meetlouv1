import { describe, expect, it } from 'vitest';
import { sha256Hex } from './bytes.ts';
import {
  CONSENT_ANNOUNCEMENT_TEMPLATE,
  CONSENT_ANNOUNCEMENT_VERSION,
  consentAnnouncement,
} from './consent.ts';

/**
 * The wording the COLP has approved. If this test fails you have changed the consent
 * announcement. That is deliberate-only: bump CONSENT_ANNOUNCEMENT_VERSION, get the new
 * wording approved, then update the two values below.
 */
const APPROVED_CONSENT_WORDING = {
  version: '2026-10-08.1',
  sha256: '8f0a068ad9e8dde500be4212de2ac736940924a03c41dd2e4de266860e423b03',
};

describe('consent announcement', () => {
  it('is the wording that was approved, at the version that was approved', async () => {
    expect(CONSENT_ANNOUNCEMENT_VERSION).toBe(APPROVED_CONSENT_WORDING.version);
    expect(await sha256Hex(CONSENT_ANNOUNCEMENT_TEMPLATE)).toBe(APPROVED_CONSENT_WORDING.sha256);
  });

  it('tells the caller the call is recorded, why, and how to decline', () => {
    const text = consentAnnouncement('Armstrong & Co', '14 Meadow Road, Sale M33 2QX');
    expect(text).toContain('Armstrong & Co');
    expect(text).toContain('14 Meadow Road, Sale M33 2QX');
    expect(text).toContain('will be recorded');
    expect(text).toContain('please hang up now');
    expect(text).toContain('By staying on the line, you agree');
  });

  it('inserts firm and property literally, even if they contain template-like text', () => {
    const text = consentAnnouncement('A $& Co', '{property} $1 Road');
    expect(text).toContain('A $& Co');
    expect(text).toContain('{property} $1 Road');
  });
});
