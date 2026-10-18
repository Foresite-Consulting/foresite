import { describe, expect, it } from 'vitest';
import { MemoryTokenBucket } from './rate-limit';

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('MemoryTokenBucket', () => {
  it('allows a burst up to capacity, then refuses with Retry-After', async () => {
    const c = clock();
    const bucket = new MemoryTokenBucket({ capacity: 3, refillPerSecond: 0.5, now: c.now });
    for (let i = 0; i < 3; i += 1) expect((await bucket.take('d')).allowed).toBe(true);
    const refused = await bucket.take('d');
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 2, remaining: 0 });
  });

  it('refills over time but never above capacity', async () => {
    const c = clock();
    const bucket = new MemoryTokenBucket({ capacity: 2, refillPerSecond: 1, now: c.now });
    await bucket.take('d');
    await bucket.take('d');
    expect((await bucket.take('d')).allowed).toBe(false);
    c.advance(1_000);
    expect((await bucket.take('d')).allowed).toBe(true);
    c.advance(60_000);
    expect((await bucket.take('d')).remaining).toBe(1);
  });

  it('keeps devices independent', async () => {
    const c = clock();
    const bucket = new MemoryTokenBucket({ capacity: 1, refillPerSecond: 0.01, now: c.now });
    expect((await bucket.take('a')).allowed).toBe(true);
    expect((await bucket.take('a')).allowed).toBe(false);
    expect((await bucket.take('b')).allowed).toBe(true);
  });

  it('check does not spend a token', async () => {
    const c = clock();
    const bucket = new MemoryTokenBucket({ capacity: 1, refillPerSecond: 0.1, now: c.now });
    expect((await bucket.check('a')).allowed).toBe(true);
    expect((await bucket.check('a')).allowed).toBe(true);
    await bucket.take('a');
    const after = await bucket.check('a');
    expect(after.allowed).toBe(false);
    expect(after.retryAfterSeconds).toBe(10);
  });

  it('does not refund tokens when the clock goes backwards', async () => {
    const c = clock(10_000);
    const bucket = new MemoryTokenBucket({ capacity: 1, refillPerSecond: 1, now: c.now });
    await bucket.take('a');
    c.advance(-5_000);
    expect((await bucket.take('a')).allowed).toBe(false);
  });

  it('bounds memory by forgetting the least recently used keys', async () => {
    const c = clock();
    const bucket = new MemoryTokenBucket({
      capacity: 1,
      refillPerSecond: 0.001,
      maxKeys: 2,
      now: c.now,
    });
    await bucket.take('a');
    await bucket.take('b');
    await bucket.take('c'); // evicts a
    expect((await bucket.take('a')).allowed).toBe(true);
    expect((await bucket.take('c')).allowed).toBe(false);
  });

  it('rejects nonsense settings', () => {
    expect(() => new MemoryTokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => new MemoryTokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow(RangeError);
  });
});
