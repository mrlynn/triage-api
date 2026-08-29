/**
 * A bounded-concurrency map. Forty lines, zero dependencies.
 *
 * TEACHING NOTE: until this file existed, every loop in this repo was
 * `for (const x of xs) await f(x)` — strictly serial. That is a defensible
 * default: it never hits a rate limit, and it makes cost accounting obvious.
 * It is also why `npm run eval` takes minutes to do a minute of work.
 *
 * The wrong fix is `Promise.all(xs.map(f))`. It works on twelve cases and
 * takes down your rate limit on twelve hundred, because it has no ceiling —
 * you have replaced "too slow" with "unbounded", and unbounded concurrency
 * against a metered API is the same shape of bug as an uncapped agent loop.
 *
 * So: a fixed number of workers pulling from a shared cursor. Order is
 * preserved in the output regardless of completion order, because a results
 * array indexed by input position is much easier to reason about than one
 * built by push().
 *
 * What this deliberately does NOT do is react to a 429. It has a fixed
 * ceiling you choose up front. Lab 9 wraps it in an AdaptiveGate that reads
 * `anthropic-ratelimit-*` headers and backs off — but a fixed limit you
 * understand beats an adaptive one you do not, and most workloads never need
 * the second thing.
 */

/**
 * Runs `fn` over `items`, at most `limit` at a time.
 *
 * @param limit Max in-flight calls. Values below 1 are clamped to 1, so
 *              `mapWithConcurrency(xs, 0, f)` degrades to serial rather than
 *              silently doing nothing.
 * @returns Results in INPUT order, not completion order.
 * @throws The first rejection, after in-flight work settles. There is no
 *         partial-results mode on purpose: a half-finished eval that reports
 *         a score is worse than one that fails loudly.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
