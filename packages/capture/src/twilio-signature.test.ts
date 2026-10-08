import { describe, expect, it } from 'vitest';
import { constantTimeEqual } from './bytes.ts';
import {
  twilioSignature,
  twilioSignedString,
  validateTwilioSignature,
} from './twilio-signature.ts';

// The worked example from Twilio's own "Validating requests" documentation.
const URL_ = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const TOKEN = '12345';
const PARAMS = {
  CallSid: ['CA1234567890ABCDE'],
  Caller: ['+14158675310'],
  Digits: ['1234'],
  From: ['+14158675310'],
  To: ['+18005551212'],
};
const TWILIO_DOCUMENTED_SIGNATURE = 'GvWf1cFY/Q7PnoempGyD5oXAezc=';

describe('X-Twilio-Signature', () => {
  it("matches Twilio's documented worked example", async () => {
    expect(await twilioSignature(TOKEN, URL_, PARAMS)).toBe(TWILIO_DOCUMENTED_SIGNATURE);
  });

  it('signs the URL then every parameter sorted by name, as name+value', () => {
    expect(twilioSignedString('https://x.example/hook', { b: ['2'], a: ['1'] })).toBe(
      'https://x.example/hooka1b2',
    );
  });

  it('accepts the genuine signature', async () => {
    expect(await validateTwilioSignature(TOKEN, URL_, PARAMS, TWILIO_DOCUMENTED_SIGNATURE)).toBe(
      true,
    );
  });

  it('is independent of the order parameters arrived in', async () => {
    const shuffled = {
      To: PARAMS.To,
      CallSid: PARAMS.CallSid,
      Digits: PARAMS.Digits,
      From: PARAMS.From,
      Caller: PARAMS.Caller,
    };
    expect(await validateTwilioSignature(TOKEN, URL_, shuffled, TWILIO_DOCUMENTED_SIGNATURE)).toBe(
      true,
    );
  });

  it('rejects a changed parameter, URL, or token', async () => {
    const sig = TWILIO_DOCUMENTED_SIGNATURE;
    expect(await validateTwilioSignature(TOKEN, URL_, { ...PARAMS, Digits: ['1235'] }, sig)).toBe(
      false,
    );
    expect(
      await validateTwilioSignature(
        TOKEN,
        'https://evil.example/myapp.php?foo=1&bar=2',
        PARAMS,
        sig,
      ),
    ).toBe(false);
    expect(await validateTwilioSignature('54321', URL_, PARAMS, sig)).toBe(false);
  });

  it('rejects an added parameter', async () => {
    expect(
      await validateTwilioSignature(
        TOKEN,
        URL_,
        { ...PARAMS, Extra: ['x'] },
        TWILIO_DOCUMENTED_SIGNATURE,
      ),
    ).toBe(false);
  });

  it('rejects a missing, empty or truncated signature', async () => {
    expect(await validateTwilioSignature(TOKEN, URL_, PARAMS, null)).toBe(false);
    expect(await validateTwilioSignature(TOKEN, URL_, PARAMS, '')).toBe(false);
    expect(
      await validateTwilioSignature(TOKEN, URL_, PARAMS, TWILIO_DOCUMENTED_SIGNATURE.slice(0, -2)),
    ).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('compares equal and unequal values of any length', async () => {
    expect(await constantTimeEqual('abc', 'abc')).toBe(true);
    expect(await constantTimeEqual('abc', 'abd')).toBe(false);
    expect(await constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(await constantTimeEqual('', 'a')).toBe(false);
  });
});
