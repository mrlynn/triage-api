/**
 * Rate limits: reading them, and reacting to them.
 *
 * TEACHING NOTE — the reason this file exists is that rate limits are the most
 * invisible thing in the API. Every response carries a full accounting of how
 * much headroom you have left, in headers, and almost nobody reads them. The
 * usual first encounter with a rate limit is a 429 in production during a
 * traffic spike, at which point you are debugging a capacity question with no
 * history of your own capacity.
 *
 * `GET /v1/limits` exists to make that visible before it matters.
 *
 * The second half is `AdaptiveGate`. `mapWithConcurrency` takes a fixed
 * ceiling you choose up front, which is the right default: a limit you
 * understand beats an adaptive one you do not. But a fixed ceiling has no
 * answer to "the limit is lower today than it was yesterday," and a sweep that
 * dies two thirds of the way through a paid run is a bad way to find out.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: retry. The SDK already retries 429s
 * (`maxRetries: 3`, honouring `retry-after`). Adding a second retry layer on
 * top would multiply attempts — three SDK retries inside three of ours is nine
 * requests for one call — and the two layers would each be tuned in ignorance
 * of the other. This gate lowers CONCURRENCY so fewer requests are in flight;
 * the SDK handles the individual request. One retry layer, one backpressure
 * layer, no overlap.
 */

export interface RateLimitSnapshot {
  /** When these headers were observed. */
  observed_at: string;
  requests?: { limit: number; remaining: number; reset: string | null };
  input_tokens?: { limit: number; remaining: number; reset: string | null };
  output_tokens?: { limit: number; remaining: number; reset: string | null };
  /** Present only after a 429. Seconds. */
  retry_after?: number;
}

function readGroup(
  headers: Headers,
  prefix: string,
): { limit: number; remaining: number; reset: string | null } | undefined {
  const limit = headers.get(`anthropic-ratelimit-${prefix}-limit`);
  const remaining = headers.get(`anthropic-ratelimit-${prefix}-remaining`);
  if (limit === null || remaining === null) return undefined;
  return {
    limit: Number(limit),
    remaining: Number(remaining),
    reset: headers.get(`anthropic-ratelimit-${prefix}-reset`),
  };
}

export function readRateLimitHeaders(headers: Headers): RateLimitSnapshot {
  const retryAfter = headers.get("retry-after");
  return {
    observed_at: new Date().toISOString(),
    requests: readGroup(headers, "requests"),
    input_tokens: readGroup(headers, "input-tokens"),
    output_tokens: readGroup(headers, "output-tokens"),
    ...(retryAfter ? { retry_after: Number(retryAfter) } : {}),
  };
}

/**
 * The most recent snapshot this process has seen.
 *
 * A module singleton rather than a store, because it is genuinely one value
 * per process and pretending otherwise would add ceremony without adding
 * truth. It is also explicitly NOT a source of truth about your account: it
 * reports what the last response said, which may be stale and says nothing
 * about what other processes on the same key are doing.
 */
let latest: RateLimitSnapshot | null = null;

export function recordRateLimits(headers: Headers): void {
  latest = readRateLimitHeaders(headers);
}

export function latestRateLimits(): RateLimitSnapshot | null {
  return latest;
}

/** Extracts a snapshot from a thrown SDK error, when there is one. */
export function rateLimitsFromError(err: unknown): RateLimitSnapshot | null {
  const headers = (err as { headers?: Headers })?.headers;
  if (headers && typeof headers.get === "function") {
    return readRateLimitHeaders(headers);
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded concurrency that backs off when the API pushes back.
 *
 * Halve on a 429, recover by one, which is TCP's additive-increase
 * multiplicative-decrease in miniature and for the same reason: you want to
 * shed load fast and reclaim it slowly. Recovering as aggressively as you
 * backed off produces a system that oscillates between hammering and hiding.
 */
export class AdaptiveGate {
  private width: number;
  private readonly max: number;
  private inFlight = 0;
  private queue: (() => void)[] = [];
  /** Observability: how many times the gate has had to shed load. */
  public throttleEvents = 0;

  constructor(concurrency: number) {
    this.max = Math.max(1, Math.floor(concurrency) || 1);
    this.width = this.max;
  }

  get currentWidth(): number {
    return this.width;
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.width) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.inFlight++;
  }

  private release(): void {
    this.inFlight--;
    const next = this.queue.shift();
    if (next) next();
  }

  /**
   * Runs `fn` under the gate.
   *
   * A 429 that escapes the SDK's own retries means the limit is genuinely
   * lower than our ceiling, so narrow, wait, and try again. The slot is
   * released BEFORE sleeping — holding one while deliberately idle would
   * starve the other workers we just made room for.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      await this.acquire();

      let result: T;
      try {
        result = await fn();
      } catch (err) {
        this.release();
        if (!isRateLimit(err)) throw err;

        this.throttleEvents++;
        this.width = Math.max(1, Math.floor(this.width / 2));

        // Honour retry-after when the API gave one; otherwise a small fixed
        // pause. Never a tight loop — that is how a 429 becomes a ban.
        const waitMs = (rateLimitsFromError(err)?.retry_after ?? 2) * 1000;
        await sleep(waitMs);
        continue;
      }

      this.release();
      return result;
    }
  }

  /** Widens back toward the original ceiling. Call after a clean batch. */
  recover(): void {
    if (this.width < this.max) this.width++;
  }
}

function isRateLimit(err: unknown): boolean {
  return (err as { status?: number } | undefined)?.status === 429;
}
