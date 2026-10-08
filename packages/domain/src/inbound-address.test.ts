import { describe, expect, it } from 'vitest';
import { inboundAddress, parseInboundSlug } from './inbound-address';
import { createMatterInput, createParticipantInput, mailDomain } from './schemas';

describe('inbound address', () => {
  it('is the matter slug at the firm mail domain', () => {
    expect(
      inboundAddress('14meadowroad-0123456789abcdef01234567', 'matters.armstrongco.co.uk'),
    ).toBe('14meadowroad-0123456789abcdef01234567@matters.armstrongco.co.uk');
  });

  it('splits a slug into a readable prefix and 96 bits of suffix', () => {
    expect(parseInboundSlug('14meadowroad-0123456789abcdef01234567')).toEqual({
      prefix: '14meadowroad',
      suffix: '0123456789abcdef01234567',
    });
    expect(parseInboundSlug('14meadowroad-k7x9')).toBeNull();
  });
});

describe('boundary schemas', () => {
  it('normalises mail domains and rejects anything else', () => {
    expect(mailDomain.parse('Matters.ArmstrongCo.co.uk')).toBe('matters.armstrongco.co.uk');
    expect(mailDomain.safeParse('not a domain').success).toBe(false);
    expect(mailDomain.safeParse('user@example.org').success).toBe(false);
  });

  it('rejects a matter kind that is not one of ours', () => {
    const base = {
      firmId: crypto.randomUUID(),
      reference: 'MTR-1',
      propertyAddress: '1 Road',
    };
    expect(createMatterInput.safeParse({ ...base, kind: 'case' }).success).toBe(false);
    expect(createMatterInput.safeParse({ ...base, kind: 'purchase' }).success).toBe(true);
  });

  it('rejects a participant who is neither client nor chain', () => {
    const result = createParticipantInput.safeParse({
      firmId: crypto.randomUUID(),
      matterId: crypto.randomUUID(),
      displayName: 'X',
      access: 'firm',
      role: 'client',
    });
    expect(result.success).toBe(false);
  });
});
