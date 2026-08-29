/**
 * The tier matrix. `npm run eval:models [-- --models a,b,c]`
 *
 * Runs the same cases against several models and prints accuracy, cost,
 * latency, and — the column people leave out — the CALIBRATION GAP.
 *
 * WHY THE GAP MATTERS MORE THAN THE ACCURACY: two models can both score 10/12
 * and be worth completely different amounts to you. One reports 0.9 on
 * everything, including the two it got wrong; the other reports 0.9 when right
 * and 0.5 when wrong. Only the second can support "escalate below 0.7", and
 * that routing is usually worth more than the two points of raw accuracy you
 * were comparing.
 *
 * The judge is deliberately NOT run here. It is pinned to one model, and mixing
 * a fixed ruler into a sweep whose whole purpose is varying the model invites
 * exactly the confound `evals/lib/judge.ts` warns about.
 *
 * COURSE REF: Lab 7
 */
import { harness, loadCases } from "./lib/harness.js";
import { scoreTriage, accuracyOf, calibrationOf, fmtMetric } from "./lib/score.js";
import { assertCredentials } from "../src/anthropic.js";
import { MODEL_TIERS, MODEL_CATALOG, specFor } from "../src/config.js";

const flagIdx = process.argv.indexOf("--models");
const models = flagIdx !== -1 && process.argv[flagIdx + 1]
  ? process.argv[flagIdx + 1]!.split(",").map((m) => m.trim())
  : Object.values(MODEL_TIERS);

for (const m of models) {
  try { specFor(m); }
  catch {
    console.error(`Unknown model "${m}". Known: ${Object.keys(MODEL_CATALOG).join(", ")}`);
    process.exit(1);
  }
}

assertCredentials();
const { rt } = await harness();
const cases = loadCases(rt);

console.log(`\nModel matrix — pack ${rt.pack.id} — ${cases.length} cases x ${models.length} models\n`);

const rows: { model: string; accuracy: number; gap: number | null; cost: number; ms: number; disagreements: string[] }[] = [];
const perModel = new Map<string, Map<string, boolean>>();

for (const model of models) {
  process.stdout.write(`  ${model} … `);
  const results = await scoreTriage({ model, cases });
  perModel.set(model, new Map(results.map((r) => [r.id, r.passed])));
  rows.push({
    model,
    accuracy: accuracyOf(results),
    gap: calibrationOf(results).gap,
    cost: results.reduce((a, r) => a + r.cost_usd, 0),
    ms: Math.round(results.reduce((a, r) => a + r.latency_ms, 0) / results.length),
    disagreements: [],
  });
  console.log(`${(accuracyOf(results) * 100).toFixed(1)}%`);
}

console.log(`\n  ${"model".padEnd(22)}${"acc".padEnd(9)}${"cal gap".padEnd(10)}${"cost".padEnd(11)}latency`);
console.log(`  ${"-".repeat(58)}`);
for (const r of rows) {
  console.log(
    `  ${r.model.padEnd(22)}${(r.accuracy * 100).toFixed(1).padStart(5)}%   ` +
      `${fmtMetric(r.gap).padEnd(10)}$${r.cost.toFixed(4).padEnd(10)}${r.ms}ms`,
  );
}

// The disagreement grid. Cases where models split are the ones worth reading —
// they are usually where your LABEL is ambiguous, not where a model is bad.
const split = cases.filter((c) => {
  const verdicts = models.map((m) => perModel.get(m)?.get(c.id));
  return new Set(verdicts).size > 1;
});

if (split.length > 0) {
  console.log(`\n  Cases where the models disagree — read these first:\n`);
  for (const c of split) {
    const marks = models.map((m) => `${m.split("-")[1] ?? m}:${perModel.get(m)?.get(c.id) ? "✓" : "✗"}`).join("  ");
    console.log(`    ${c.id}  ${marks}`);
    console.log(`      ${c.notes}`);
  }
} else {
  console.log(`\n  Every model agreed on every case. Either your cases are too easy,`);
  console.log(`  or your taxonomy is not discriminating. Both are worth fixing.`);
}
console.log();
