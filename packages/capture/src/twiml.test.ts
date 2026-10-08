import { describe, expect, it } from 'vitest';
import { announceTwiml, dialAndRecordTwiml, escapeXml, unroutedTwiml } from './twiml.ts';

describe('TwiML', () => {
  it('escapes everything that could break out of the XML', () => {
    expect(escapeXml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;',
    );
  });

  it('keeps an ampersand in a firm name or a URL well-formed', () => {
    const xml = announceTwiml('Armstrong & Co', 'https://x.example/hook?a=1&b=2');
    expect(xml).toContain('Armstrong &amp; Co');
    expect(xml).toContain('?a=1&amp;b=2');
  });

  it('asks for a dual-channel recording from answer, with a status callback', () => {
    const xml = dialAndRecordTwiml('+447700900123', 'https://x.example/recording-status');
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain('recordingStatusCallback="https://x.example/recording-status"');
    expect(xml).toContain('<Number>+447700900123</Number>');
  });

  it('never instructs a recording in the polite unrouted answer or the announcement', () => {
    expect(unroutedTwiml()).not.toContain('record');
    expect(announceTwiml('Firm', 'https://x.example/announced')).not.toContain('record=');
  });
});
