/**
 * Booking queue with exponential backoff retries.
 *
 * The real-world failure modes a partner integration must handle:
 *   - Transient: network blips, 429s, 5xx → retry with backoff.
 *   - Persistent: invalid party size, no inventory → don't retry, escalate.
 *   - Hold expiry: we held inventory but didn't confirm in time → re-quote.
 *
 * runWithRetry classifies errors via `isTransient()` and only retries the
 * transient class. Non-retriable failures fall through to the fallback
 * agent which can substitute the item.
 */

const TRANSIENT_PATTERNS = [
  /\bECONN/i,
  /\bETIMEDOUT/i,
  /\bENOTFOUND/i,
  /\bsocket hang up\b/i,
  /\b5\d\d\b/, // 5xx
  /\b429\b/,
  /\brate.?limit/i,
  /\bnetwork/i,
];

export function isTransient(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

export async function runWithRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onAttempt?: (attempt: number, err: unknown) => void;
  } = {},
): Promise<T> {
  const max = opts.maxAttempts ?? 4;
  const base = opts.baseDelayMs ?? 600;
  const cap = opts.maxDelayMs ?? 8_000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      opts.onAttempt?.(attempt, err);
      if (attempt === max || !isTransient(err)) throw err;
      const jitter = Math.random() * 250;
      const delay = Math.min(cap, base * 2 ** (attempt - 1)) + jitter;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
