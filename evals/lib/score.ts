/**
 * Deterministic triage scoring — the half of the eval that gates CI.
 *
 * TEACHING NOTE: this scores four fields with `!==` and nothing else.
 * `sentiment` and `summary` come back on every response and are scored by
 * NOTHING — that is deliberate, not an oversight. A free-text summary has no
 * single right answer, so any automated check on it would measure string
 * similarity rather than correctness.
 *
 * COURSE REF: Labs 0 and 6
 */
import { harness, loadCases, type EvalCase } from "./harness.js";

export interface CaseResult {
  id: string;
  model: string;
  passed: boolean;
  failures: string[];
  confidence: number;
  cost_usd: number;
  latency_ms: number;
  notes: string;
}

export interface ScoreOpts {
  /** Overrides the configured model. The tier matrix sweeps this. */
  model?: string;
  cases?: EvalCase[];
}

export async function scoreTriage(opts: ScoreOpts = {}): Promise<CaseResult[]> {
  const { app, rt } = await harness();
  const cases = opts.cases ?? loadCases(rt);
  const results: CaseResult[] = [];

  for (const testCase of cases) {
    const started = Date.now();
    const url = opts.model ? `/v1/triage?model=${encodeURIComponent(opts.model)}` : "/v1/triage";
    const res = await app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: testCase.message }),
    });

    if (!res.ok) {
      // A transport failure is a FAILING case, not a skipped one. Dropping it
      // would quietly shrink the denominator and inflate the accuracy.
      results.push({
        id: testCase.id, model: opts.model ?? "unknown", passed: false,
        failures: [`HTTP ${res.status}: ${await res.text()}`],
        confidence: 0, cost_usd: 0, latency_ms: Date.now() - started, notes: testCase.notes,
      });
      continue;
    }

    const body = await res.json() as {
      triage: { category: string; urgency: string; requires_human: boolean;
        entities: { requested_remedy: string }; confidence: number };
      meta: { model: string; usage: { estimated_cost_usd: number } };
    };
    const got = body.triage;
    const want = testCase.expected;
    const failures: string[] = [];

    if (got.category !== want.category) failures.push(`category: expected ${want.category}, got ${got.category}`);
    if (got.urgency !== want.urgency) failures.push(`urgency: expected ${want.urgency}, got ${got.urgency}`);
    if (got.requires_human !== want.requires_human) {
      failures.push(`requires_human: expected ${want.requires_human}, got ${got.requires_human}`);
    }
    if (got.entities.requested_remedy !== want.requested_remedy) {
      failures.push(`requested_remedy: expected ${want.requested_remedy}, got ${got.entities.requested_remedy}`);
    }

    results.push({
      id: testCase.id, model: body.meta.model, passed: failures.length === 0, failures,
      confidence: got.confidence, cost_usd: body.meta.usage.estimated_cost_usd,
      latency_ms: Date.now() - started, notes: testCase.notes,
    });
  }

  return results;
}

/** Accuracy as a 0-1 fraction. Empty input scores 0, never NaN. */
export function accuracyOf(results: CaseResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.passed).length / results.length;
}

/**
 * Mean confidence on passes vs. failures.
 *
 * The GAP is the signal, not either number. A model that reports 0.9 on
 * everything cannot support threshold routing; one that is unsure exactly
 * where it is wrong can.
 *
 * `onFail` and `gap` are NULL when nothing failed, and that is not pedantry.
 * An earlier version averaged the empty set to 0, so a model that scored 12/12
 * reported a gap of 0.88 — its mean pass confidence, dressed up as separation
 * it had never demonstrated. A metric with no data should say so.
 */
export function calibrationOf(results: CaseResult[]): {
  onPass: number | null; onFail: number | null; gap: number | null;
} {
  const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  const onPass = mean(results.filter((r) => r.passed).map((r) => r.confidence));
  const onFail = mean(results.filter((r) => !r.passed).map((r) => r.confidence));
  return { onPass, onFail, gap: onPass !== null && onFail !== null ? onPass - onFail : null };
}

/** Renders a possibly-absent metric. "n/a" beats a fabricated 0.00. */
export function fmtMetric(v: number | null, digits = 2): string {
  return v === null ? "n/a" : v.toFixed(digits);
}
