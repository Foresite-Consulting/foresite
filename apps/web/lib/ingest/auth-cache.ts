import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Remembers credentials that recently passed scrypt, so a device posting
 * every few minutes (or replaying a backlog) does not pay two scrypt runs per
 * request. Measured on a 2-vCPU machine: about 6–7 authenticated requests per
 * second without the cache.
 *
 * What is kept: an HMAC-SHA256 tag of (device id, presented secret, the
 * device's current stored hashes) under a random key that lives only in this
 * process. Never the secret. A tag only matches if the same secret is
 * presented while the stored hashes are unchanged, so rotating or revoking a
 * hash invalidates it. The device's `active` flag is still read from storage
 * on every request.
 *
 * Timing: only a request with the correct secret takes the fast path, so the
 * shortcut reveals nothing to someone who does not already hold the secret.
 * Wrong secrets and unknown devices always take the full two-scrypt path.
 */
export class VerifiedCredentialCache {
  private readonly key = randomBytes(32);
  private readonly entries = new Map<string, { tag: Buffer; slot: number; expiresAt: number }>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  private tag(deviceId: string, secret: string, hashes: readonly string[]): Buffer {
    return createHmac('sha256', this.key)
      .update(JSON.stringify([deviceId, secret, hashes]))
      .digest();
  }

  /** The matching slot (1 or 2) if this exact credential passed recently, else null. */
  lookup(deviceId: string, secret: string, hashes: readonly string[]): number | null {
    const entry = this.entries.get(deviceId);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(deviceId);
      return null;
    }
    return timingSafeEqual(entry.tag, this.tag(deviceId, secret, hashes)) ? entry.slot : null;
  }

  remember(deviceId: string, secret: string, hashes: readonly string[], slot: number): void {
    this.entries.delete(deviceId);
    this.entries.set(deviceId, {
      tag: this.tag(deviceId, secret, hashes),
      slot,
      expiresAt: this.now() + this.ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
