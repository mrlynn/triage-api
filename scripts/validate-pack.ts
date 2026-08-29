/**
 * `npm run pack:validate [-- <pack-id>]`
 *
 * Loads a pack, runs every cross-field check, and reports what the resulting
 * deployment would and would not be able to enforce. Costs nothing and needs no
 * credential, so it belongs in CI and in your pre-commit hook.
 *
 * Run it after every edit to a pack. The checks it performs are all things that
 * otherwise surface as plausible-looking output with a broken guarantee.
 */
import "../src/lib/env.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPack } from "../src/pack-loader.js";
import { buildToolDefs } from "../src/tools/definitions.js";
import { fixturesProvider } from "../src/adapters/data/fixtures.js";
import { buildSystem } from "../src/prompts.js";

const id = process.argv[2] ?? "northwind";

let pack;
try {
  pack = await loadPack(id);
} catch (e) {
  console.error(`\n${(e as Error).message}\n`);
  process.exit(1);
}

const clausePattern = new RegExp(pack.citations.clausePattern, "g");
const clauses = new Set([...pack.handbookText.matchAll(clausePattern)].map((m) => m[0]));
const tools = buildToolDefs(pack, fixturesProvider(pack)).map((d) => d.name);
const prefix = buildSystem("triage", pack)[0]!.text;
const approxTokens = Math.round(prefix.length / 3.5);

const evalPath = join(pack.dir, "evals", "dataset.jsonl");
const injPath = join(pack.dir, "evals", "injections.jsonl");
const jsonl = (p: string) => existsSync(p)
  ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>)
  : [];
const cases = jsonl(evalPath);
const injections = jsonl(injPath);

console.log(`\n  pack ${pack.id} — ${pack.companyName}`);
console.log(`  ${pack.dir}\n`);
console.log(`  categories        ${pack.taxonomy.categories.join(", ")}`);
console.log(`  urgencies         ${pack.taxonomy.urgencies.join(", ")}`);
console.log(`  escalates to      ${pack.taxonomy.escalationAction}`);
console.log(`  refund ceiling    $${pack.authority.refundLimitUsd} single / $${pack.authority.rollingCeilingUsd} per ${pack.authority.rollingWindowDays}d`);
console.log(`  confidence floor  ${pack.routing.escalateBelow}`);
console.log(`  clauses found     ${clauses.size}`);
console.log(`  cached prefix     ~${approxTokens} tokens`);
console.log(`  tools (fixtures)  ${tools.join(", ")}`);
console.log(`  eval cases        ${cases.length}`);
console.log(`  injection cases   ${injections.length} (${injections.filter((i) => i.benign).length} benign controls)\n`);

const warnings: string[] = [];

if (approxTokens < 1024) {
  warnings.push(
    `The cached prefix is ~${approxTokens} tokens, below the ~1024 minimum. The API will silently\n` +
    `    decline to cache it — no error, just full price on every request forever. Lengthen the\n` +
    `    handbook or accept the cost knowingly.`,
  );
}
if (clauses.size === 0) {
  warnings.push(
    `citations.clausePattern matched nothing in the handbook. Citation verification will report\n` +
    `    every citation the model makes as fabricated. Number your clauses, or fix the pattern.`,
  );
}
if (cases.length === 0) {
  warnings.push(
    `No eval cases. This is the step people skip and the one that decides whether the rest works.\n` +
    `    Hand-label 10-15 real tickets into evals/dataset.jsonl.`,
  );
} else if (cases.length < 8) {
  warnings.push(
    `Only ${cases.length} eval cases. Below about 10, one case is worth more than 10 percentage points\n` +
    `    and the accuracy number moves on noise.`,
  );
}
if (injections.length === 0) {
  warnings.push(`No injection corpus. There is no containment evidence for this pack.`);
} else if (injections.filter((i) => i.benign).length === 0) {
  warnings.push(
    `No benign controls in the injection corpus. A gate that only counts blocked attacks gives a\n` +
    `    perfect score to a service that refuses every message.`,
  );
}
if (!existsSync(join(pack.dir, "fixtures", "customers.json"))) {
  warnings.push(
    `No fixtures/customers.json. With the fixtures DataProvider the rolling refund ceiling cannot\n` +
    `    run, and refunds will escalate as unverifiable. Fine if you are wiring a real provider.`,
  );
}

if (warnings.length === 0) {
  console.log("  No warnings. This pack can enforce every control.\n");
  process.exit(0);
}
for (const w of warnings) console.log(`  WARN  ${w}\n`);
// Warnings, not failures: every one of these is a legitimate deliberate choice
// for someone. They must be visible, not fatal.
process.exit(0);
