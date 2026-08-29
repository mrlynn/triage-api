/**
 * `npm run smoke` — the one check that actually spends money.
 *
 * Drives every route in-process against the live API. Run it after any change
 * to prompts, schemas, or the pack; it costs a few cents and catches the class
 * of breakage no offline test can: a schema the model cannot satisfy, a cache
 * prefix that stopped matching, a tool the model refuses to call.
 */
import { harness } from "../evals/lib/harness.js";
import { assertCredentials } from "../src/anthropic.js";

assertCredentials();
const { app, rt } = await harness();

const ok = (label: string, pass: boolean, detail = "") =>
  console.log(`  ${pass ? "OK  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);

console.log(`\nSmoke — pack ${rt.pack.id}\n`);
let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  ok(label, pass, detail);
  if (!pass) failures++;
};

// --- triage, twice, to prove the cache prefix matches -----------------------
const body = JSON.stringify({ message: "Order NW-48211 arrived with a broken zipper. I want a replacement." });
const post = (path: string, b = body) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: b });

const t1 = await post("/v1/triage");
const j1 = await t1.json() as { triage?: { category: string }; meta?: { usage: { cache_read_input_tokens: number; estimated_cost_usd: number } } };
check("POST /v1/triage", t1.ok && Boolean(j1.triage), j1.triage?.category);

const t2 = await post("/v1/triage");
const j2 = await t2.json() as { meta?: { usage: { cache_read_input_tokens: number } } };
const cacheRead = j2.meta?.usage.cache_read_input_tokens ?? 0;
check("prompt cache is warm on the second call", cacheRead > 0,
  cacheRead > 0 ? `${cacheRead} tokens read from cache`
    : "0 cache reads — something before the breakpoint is varying per request, or the prefix is under ~1024 tokens");

// --- unknown model is the caller's 400, not our 500 ------------------------
const bad = await post("/v1/triage?model=claude-not-a-model");
check("unknown ?model= returns 400", bad.status === 400);

// --- resolve, with the guardrails reported --------------------------------
const r = await post("/v1/resolve");
const rj = await r.json() as { resolution?: { recommended_action: string };
  meta?: { iterations: number; guardrails: { authority_violations: string[]; unsupported_citations: string[] } } };
check("POST /v1/resolve", r.ok && Boolean(rj.resolution), rj.resolution?.recommended_action);
check("the tool loop ran", (rj.meta?.iterations ?? 0) > 1, `${rj.meta?.iterations} turns`);
check("no fabricated citations", (rj.meta?.guardrails.unsupported_citations.length ?? 1) === 0);

// --- draft streams and terminates with usage -------------------------------
const d = await post("/v1/draft");
const text = await d.text();
check("POST /v1/draft streams", d.ok && text.includes("event: text"));
check("the stream ends with a usage report", text.includes("event: done"));

// --- estimate needs no inference -------------------------------------------
const e = await post("/v1/estimate", JSON.stringify({ message: "hello", role: "resolve" }));
const ej = await e.json() as { tokens?: { prefix_meets_cache_minimum: boolean; cacheable_prefix: number } };
check("POST /v1/estimate", e.ok && Boolean(ej.tokens));
check("the cacheable prefix clears the ~1024-token minimum",
  ej.tokens?.prefix_meets_cache_minimum === true, `${ej.tokens?.cacheable_prefix} tokens`);

console.log(`\n  ${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
