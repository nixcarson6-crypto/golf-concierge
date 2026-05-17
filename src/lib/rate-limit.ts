/**
 * In-process token-bucket rate limiter. Lightweight per-process state;
 * sufficient for single-instance deployments. Swap to a Redis-backed
 * implementation when scaling horizontally.
 *
 * Usage:
 *   const ok = await checkRate(`chat:${userId}`, { tokens: 1, capacity: 30, refillPerSec: 0.5 });
 *   if (!ok) return new Response("Too many requests", { status: 429 });
 */

type Bucket = { tokens: number; updatedAt: number };
const buckets = new Map<string, Bucket>();

export type RateOptions = {
  /** Tokens to consume on this call (default 1). */
  tokens?: number;
  /** Maximum burst capacity. */
  capacity: number;
  /** Refill rate in tokens-per-second. */
  refillPerSec: number;
};

export function checkRate(key: string, opts: RateOptions): boolean {
  const cost = opts.tokens ?? 1;
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: opts.capacity, updatedAt: now };
  const elapsedSec = (now - bucket.updatedAt) / 1000;
  const refilled = Math.min(
    opts.capacity,
    bucket.tokens + elapsedSec * opts.refillPerSec,
  );
  if (refilled < cost) {
    bucket.tokens = refilled;
    bucket.updatedAt = now;
    buckets.set(key, bucket);
    return false;
  }
  bucket.tokens = refilled - cost;
  bucket.updatedAt = now;
  buckets.set(key, bucket);
  return true;
}

/**
 * Convenience for the common "burst of 30 then 1/2s sustained" pattern used
 * by the chat endpoints. Per-user.
 */
export function checkChatRate(userId: string): boolean {
  return checkRate(`chat:${userId}`, {
    capacity: 30,
    refillPerSec: 0.5,
  });
}
