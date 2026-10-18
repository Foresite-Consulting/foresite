/**
 * Seeded pseudo-random numbers for the synthetic data generator.
 *
 * ## Algorithm
 *
 * - **Seeding:** the seed and a list of stream keys (e.g. `['sales', '2025-01-04',
 *   'bar']`) are joined with `|` and hashed with **cyrb128** (a public-domain
 *   128-bit string hash by bryc) into four 32-bit words.
 * - **Generator:** **sfc32** (Chris Doty-Humphrey's Small Fast Counter,
 *   from PractRand), seeded with those four words and warmed up with 15
 *   discarded outputs.
 * - **Distributions:** uniform `(0, 1)` from one 32-bit output; normal by
 *   Box–Muller; Poisson by Knuth's multiplication method below a mean of
 *   30 and a rounded normal approximation at or above it.
 *
 * Every (day, section) gets its own stream, so a 14-day run produces exactly
 * the first 14 days of a 730-day run with the same seed and start date.
 *
 * Not for anything security-related.
 */

/** cyrb128: four 32-bit words from a string. */
export function cyrb128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i += 1) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** A seeded random stream. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number, ...keys: (string | number)[]) {
    [this.a, this.b, this.c, this.d] = cyrb128([seed, ...keys].join('|'));
    for (let i = 0; i < 15; i += 1) this.nextUint32();
  }

  /** sfc32 step: a 32-bit unsigned integer. */
  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform on the open interval (0, 1). */
  uniform(): number {
    return (this.nextUint32() + 0.5) / 4294967296;
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.uniform() < p;
  }

  /** Integer uniform on `[min, max]`. */
  int(min: number, max: number): number {
    return min + Math.floor(this.uniform() * (max - min + 1));
  }

  /** Normal with the given mean and standard deviation (Box–Muller). */
  normal(mean = 0, sd = 1): number {
    const u1 = this.uniform();
    const u2 = this.uniform();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Poisson count with mean `lambda` (0 for a mean of 0 or less). */
  poisson(lambda: number): number {
    if (!(lambda > 0)) return 0;
    if (lambda >= 30) return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = this.uniform();
    while (p > limit) {
      k += 1;
      p *= this.uniform();
    }
    return k;
  }
}
