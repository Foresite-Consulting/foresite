import { describe, expect, it } from 'vitest';
import {
  GENERATED_SECRET_LENGTH,
  generateDeviceSecret,
  getDummyHash,
  hashDeviceSecret,
  parseSecretHash,
  verifyDeviceSecret,
} from './secrets';

describe('generateDeviceSecret', () => {
  it('makes long secrets from letters and digits only', () => {
    const secret = generateDeviceSecret();
    expect(secret).toHaveLength(GENERATED_SECRET_LENGTH);
    expect(secret).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('never repeats and uses the whole alphabet', () => {
    const many = Array.from({ length: 200 }, () => generateDeviceSecret());
    expect(new Set(many).size).toBe(200);
    const chars = new Set(many.join(''));
    expect(chars.size).toBe(62);
  });

  it('refuses lengths that are too short', () => {
    expect(() => generateDeviceSecret(8)).toThrow(RangeError);
    expect(() => generateDeviceSecret(129)).toThrow(RangeError);
  });
});

describe('hashDeviceSecret / verifyDeviceSecret', () => {
  it('stores a salted scrypt hash, never the secret', async () => {
    const secret = generateDeviceSecret();
    const a = await hashDeviceSecret(secret);
    const b = await hashDeviceSecret(secret);
    expect(a).toMatch(/^scrypt\$v=1\$n=16384,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(a).not.toContain(secret);
    expect(a).not.toBe(b);
  });

  it('accepts the right secret and nothing else', async () => {
    const secret = generateDeviceSecret();
    const hash = await hashDeviceSecret(secret);
    expect(await verifyDeviceSecret(secret, hash)).toBe(true);
    expect(await verifyDeviceSecret(`${secret}x`, hash)).toBe(false);
    expect(await verifyDeviceSecret(secret.slice(0, -1), hash)).toBe(false);
    expect(await verifyDeviceSecret(secret.toLowerCase(), hash)).toBe(
      secret === secret.toLowerCase(),
    );
    expect(await verifyDeviceSecret('', hash)).toBe(false);
    expect(await verifyDeviceSecret('x'.repeat(10_000), hash)).toBe(false);
  });

  it('never matches the dummy hash or a malformed hash', async () => {
    const dummy = await getDummyHash();
    expect(await verifyDeviceSecret('anything-at-all-123', dummy)).toBe(false);
    for (const bad of [
      '',
      'plain-text-secret',
      'scrypt$v=1$n=16384,r=8,p=1$short$short',
      'scrypt$v=2$n=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ]) {
      expect(await verifyDeviceSecret('anything-at-all-123', bad)).toBe(false);
    }
  });

  it('refuses stored parameters that would exhaust memory or are not powers of two', () => {
    const salt = 'AAAAAAAAAAAAAAAAAAAAAA';
    const key = 'A'.repeat(43);
    expect(parseSecretHash(`scrypt$v=1$n=16384,r=8,p=1$${salt}$${key}`)).not.toBeNull();
    expect(parseSecretHash(`scrypt$v=1$n=1048576,r=8,p=1$${salt}$${key}`)).toBeNull();
    expect(parseSecretHash(`scrypt$v=1$n=10000,r=8,p=1$${salt}$${key}`)).toBeNull();
    expect(parseSecretHash(`scrypt$v=1$n=16384,r=99,p=1$${salt}$${key}`)).toBeNull();
    expect(parseSecretHash(`scrypt$v=1$n=16384,r=8,p=9$${salt}$${key}`)).toBeNull();
  });

  it('refuses to hash secrets outside the accepted length', async () => {
    await expect(hashDeviceSecret('short')).rejects.toThrow(RangeError);
  });
});
