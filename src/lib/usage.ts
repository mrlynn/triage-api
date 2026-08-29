/**
 * Token and cost accounting.
 *
 * TEACHING NOTE: `usage` is the single most under-used field in the API.
 * Four numbers come back on every response and they mean different things:
 *
 *   input_tokens                 uncached input, billed at full rate
 *   cache_creation_input_tokens  written to cache, billed at ~1.25x
 *   cache_read_input_tokens      served from cache, billed at ~0.1x
 *   output_tokens                generated, billed at the output rate
 *
 * The number people expect to be "total input" is the SUM of the first three.
 * If you log only `input_tokens` on a cached workload, your dashboard will
 * show costs collapsing to near zero and you will not notice a broken cache.
 *
 * The single diagnostic that matters: if `cache_read_input_tokens` is 0 across
 * repeated requests that should share a prefix, something is invalidating it.
 */
import { pricingFor } from "../config.js";

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface UsageReport {
  /** Which model produced this usage. Cost is meaningless without it. */
  model: string;
  /** True when billed through the Batches API at half rate. */
  batch: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_input_tokens: number;
  /** true once the cache is warm — the assertion your cache lab checks. */
  cache_hit: boolean;
  estimated_cost_usd: number;
  /** What this call would have cost with no caching at all. */
  uncached_cost_usd: number;
  savings_usd: number;
}

export function summarizeUsage(
  usage: UsageLike,
  model: string,
  opts: { batch?: boolean } = {},
): UsageReport {
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const fresh = usage.input_tokens;
  const totalInput = fresh + cacheWrite + cacheRead;

  const pricing = pricingFor(model);
  const batch = opts.batch ?? false;
  const discount = batch ? pricing.batchMultiplier : 1;

  const inRate = (pricing.inputPerMTok / 1_000_000) * discount;
  const outRate = (pricing.outputPerMTok / 1_000_000) * discount;

  const cost =
    fresh * inRate +
    cacheWrite * inRate * pricing.cacheWriteMultiplier +
    cacheRead * inRate * pricing.cacheReadMultiplier +
    usage.output_tokens * outRate;

  const uncached = totalInput * inRate + usage.output_tokens * outRate;

  return {
    model,
    batch,
    input_tokens: fresh,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    total_input_tokens: totalInput,
    cache_hit: cacheRead > 0,
    estimated_cost_usd: round6(cost),
    uncached_cost_usd: round6(uncached),
    savings_usd: round6(uncached - cost),
  };
}

/** Adds usage reports across the many turns of an agentic loop. */
export function sumUsage(reports: UsageReport[]): UsageReport {
  // Turns of one loop should share a model; "mixed" makes it obvious when a
  // caller has summed across a tier boundary and the total is not comparable
  // to any single-model figure.
  const models = new Set(reports.map((r) => r.model));
  const model = models.size === 1 ? [...models][0]! : models.size === 0 ? "none" : "mixed";

  const zero: UsageReport = {
    model,
    batch: reports.some((r) => r.batch),
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: 0,
    cache_hit: false,
    estimated_cost_usd: 0,
    uncached_cost_usd: 0,
    savings_usd: 0,
  };
  const total = reports.reduce((acc, r) => ({
    model: acc.model,
    batch: acc.batch,
    input_tokens: acc.input_tokens + r.input_tokens,
    output_tokens: acc.output_tokens + r.output_tokens,
    cache_creation_input_tokens:
      acc.cache_creation_input_tokens + r.cache_creation_input_tokens,
    cache_read_input_tokens: acc.cache_read_input_tokens + r.cache_read_input_tokens,
    total_input_tokens: acc.total_input_tokens + r.total_input_tokens,
    cache_hit: acc.cache_hit || r.cache_hit,
    estimated_cost_usd: acc.estimated_cost_usd + r.estimated_cost_usd,
    uncached_cost_usd: acc.uncached_cost_usd + r.uncached_cost_usd,
    savings_usd: acc.savings_usd + r.savings_usd,
  }), zero);

  total.estimated_cost_usd = round6(total.estimated_cost_usd);
  total.uncached_cost_usd = round6(total.uncached_cost_usd);
  total.savings_usd = round6(total.savings_usd);
  return total;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
