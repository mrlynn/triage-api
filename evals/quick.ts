/**
 * The scoreboard. `npm run eval:quick [-- --gate]`
 *
 * Deterministic scoring only, no judge. This is the number you put on the board
 * before you change anything, and the number you re-check after.
 *
 * `--gate` compares against the pack's `evals/baseline.json` and exits 1 on a
 * regression. It compares PASSING CASE IDS, not just the count: 10/12 after a
 * change is not the same 10/12 as before if two cases swapped places, and a
 * count-only gate calls that no change at all.
 */
import { harness, loadCases, baselinePath } from "./lib/harness.js";
import { scoreTriage, accuracyOf, calibrationOf, fmtMetric } from "./lib/score.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { assertCredentials } from "../src/anthropic.js";

interface Baseline { recorded_at: string; model: string; accuracy: number; passed: number; total: number; passing_ids: string[]; }

const args = process.argv.slice(2);
const gate = args.includes("--gate");
const record = args.includes("--record");

assertCredentials();
const { rt } = await harness();
const cases = loadCases(rt);

console.log(`\nPack: ${rt.pack.id} (${rt.pack.companyName}) — ${cases.length} cases\n`);

const results = await scoreTriage({ cases });
for (const r of results) {
  console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.id}  conf ${r.confidence.toFixed(2)}  $${r.cost_usd.toFixed(5)}`);
  for (const f of r.failures) console.log(`        - ${f}`);
  if (!r.passed) console.log(`        note: ${r.notes}`);
}

const accuracy = accuracyOf(results);
const cal = calibrationOf(results);
const passed = results.filter((r) => r.passed).length;
const passingIds = results.filter((r) => r.passed).map((r) => r.id).sort();

console.log(`\n  accuracy:            ${(accuracy * 100).toFixed(1)}%  (${passed}/${results.length})`);
console.log(`  confidence on pass:  ${fmtMetric(cal.onPass)}`);
console.log(`  confidence on fail:  ${fmtMetric(cal.onFail)}`);
console.log(`  calibration gap:     ${fmtMetric(cal.gap)}`);
console.log(`  cost:                $${results.reduce((a, r) => a + r.cost_usd, 0).toFixed(4)}\n`);

const path = baselinePath(rt);

if (record) {
  const baseline: Baseline = {
    recorded_at: new Date().toISOString(),
    model: results[0]?.model ?? "unknown",
    accuracy, passed, total: results.length, passing_ids: passingIds,
  };
  writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`Recorded baseline to ${path}\n`);
}

if (gate) {
  if (!existsSync(path)) {
    console.error(`No baseline at ${path}. Record one first: npm run eval:quick -- --record`);
    process.exit(1);
  }
  const base = JSON.parse(readFileSync(path, "utf8")) as Baseline;
  const lost = base.passing_ids.filter((id) => !passingIds.includes(id));
  const gained = passingIds.filter((id) => !base.passing_ids.includes(id));

  if (gained.length) console.log(`  newly passing: ${gained.join(", ")}`);
  if (lost.length) {
    // Regressions are named, not counted. "10/12, same as before" hides two
    // cases swapping places, which is a real change in behaviour.
    console.error(`\nGATE FAILED — these cases passed at baseline and do not now:\n  ${lost.join("\n  ")}\n`);
    process.exit(1);
  }
  console.log(`  gate: OK (no baseline case regressed)\n`);
}
