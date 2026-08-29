import Anthropic from "@anthropic-ai/sdk";
import { recordRateLimits } from "./lib/limits.js";

/**
 * One client for the whole process.
 *
 * TEACHING NOTE: the zero-arg constructor resolves credentials from the
 * environment (ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then an
 * `ant auth login` profile). Never hardcode a key, and never construct a new
 * client per request — the SDK pools HTTP connections and owns retry state.
 *
 * Defaults worth knowing: `timeout` is 10 minutes (MILLISECONDS in the TS
 * SDK — seconds in Python), `maxRetries` is 2 and covers 408/409/429/5xx plus
 * connection errors. Wall-clock worst case is timeout x (maxRetries + 1).
 */
export const anthropic = new Anthropic({
  /**
   * Every response passes through here, so this is where rate-limit headers
   * get recorded.
   *
   * The obvious alternative is `.withResponse()` at each call site. It does
   * not work for this: `messages.parse()` is an SDK helper that returns a
   * plain Promise rather than an APIPromise, so `.withResponse()` exists on
   * the type and not at runtime — which is a small lesson in its own right
   * about trusting a signature you have not executed.
   *
   * Wrapping fetch is better regardless. It catches EVERY call — parse,
   * stream, the tool runner's internal turns, count_tokens — rather than the
   * ones somebody remembered to instrument, and the routes stay unaware of it.
   */
  fetch: async (input, init) => {
    const response = await globalThis.fetch(input, init);
    recordRateLimits(response.headers);
    return response;
  },
  maxRetries: 3,
  // Two minutes, not the 10-minute default. The default exists so a huge
  // non-streaming generation can finish; nothing here is that. An eval sweep
  // wants a short fuse — with maxRetries: 3, a single wedged request at the
  // default would hold the runner for ~40 minutes before failing.
  timeout: 120_000,
});

export function assertCredentials(): void {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(
      "No Anthropic credentials found. Copy .env.example to .env and set ANTHROPIC_API_KEY, " +
        "or export it in your shell.",
    );
  }
}

export default Anthropic;
