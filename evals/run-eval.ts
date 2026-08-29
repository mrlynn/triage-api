/**
 * The full run: deterministic scoring plus the LLM judge on drafted replies.
 * `npm run eval`
 *
 * Two halves that answer different questions and are reported separately:
 *
 *   scoreTriage  Did the classifier put it in the right box? Exact match on
 *                four fields. Cheap, deterministic, gates CI.
 *   judgeDrafts  Is the reply any good? Rubric-scored by a pinned judge.
 *                Expensive, noisy, and the only thing that measures prose.
 *
 * They are never averaged. A single "quality score" that blends a deterministic
 * check with a stochastic one inherits the variance of the judge and the
 * false precision of the scorer.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { harness, loadCases } from "./lib/harness.js";
import { scoreTriage, accuracyOf, calibrationOf, fmtMetric } from "./lib/score.js";
import { judgeDrafts, JUDGE_MODEL, judgePromptSha } from "./lib/judge.js";
import { assertCredentials } from "../src/anthropic.js";

assertCredentials();
const { rt } = await harness();
const cases = loadCases(rt);
const skipJudge = process.argv.includes("--no-judge");

console.log(`\nEval — pack ${rt.pack.id} (${rt.pack.companyName}) — ${cases.length} cases\n`);

const triage = await scoreTriage({ cases });
for (const r of triage) {
  console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.id}  conf ${r.confidence.toFixed(2)}`);
  for (const f of r.failures) console.log(`        - ${f}`);
}

const accuracy = accuracyOf(triage);
const cal = calibrationOf(triage);
console.log(`\n  triage accuracy:   ${(accuracy * 100).toFixed(1)}%`);
console.log(`  calibration gap:   ${fmtMetric(cal.gap)}`);

const judged = skipJudge ? [] : await judgeDrafts(cases.slice(0, 4));
if (judged.length > 0) {
  const passed = judged.filter((j) => j.verdict === "pass").length;
  console.log(`  draft judge:       ${passed}/${judged.length} pass (judge: ${JUDGE_MODEL} @ ${judgePromptSha()})`);
  for (const j of judged.filter((x) => x.verdict === "fail")) {
    console.log(`        FAIL ${j.id}: ${j.broken_rules.join(", ") || j.rationale}`);
  }
}

const outDir = join(process.cwd(), "evals", "results");
mkdirSync(outDir, { recursive: true });
const path = join(outDir, `${rt.pack.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(path, JSON.stringify({
  pack: rt.pack.id,
  recorded_at: new Date().toISOString(),
  triage: { accuracy, calibration: cal, results: triage },
  // The judge id AND a hash of its prompt, so two runs graded by different
  // rulers can be detected rather than silently compared.
  judge: skipJudge ? null : { model: JUDGE_MODEL, prompt_hash: judgePromptSha(), results: judged },
}, null, 2) + "\n");

console.log(`\n  written to ${path}\n`);
