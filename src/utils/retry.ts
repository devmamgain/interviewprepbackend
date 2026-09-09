export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return true if this error should trigger a retry, false to fail fast. */
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter. Used everywhere we call something
 * external and flaky: the LLM API and the web crawler. A pipeline that dies
 * the first time a provider says "slow down" is exactly the failure mode the
 * brief calls out, so every external call in this codebase goes through
 * this helper (or the RateLimiter below) rather than a bare fetch/call.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 20000, isRetryable = () => true, onRetry } = opts;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetryable(err)) throw err;
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.random() * exp * 0.3;
      const delay = exp + jitter;
      onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Simple client-side token-bucket-ish limiter to stay under a requests-per-
 * minute budget proactively, rather than only reacting to 429s after the
 * fact. Shared across all Gemini calls in a process.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  constructor(private readonly maxPerWindow: number, private readonly windowMs = 60_000) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxPerWindow) {
      const oldest = this.timestamps[0];
      const waitMs = this.windowMs - (now - oldest) + 50;
      await sleep(Math.max(waitMs, 0));
      return this.acquire();
    }
    this.timestamps.push(Date.now());
  }
}
