/**
 * Loads and validates the active pack.
 *
 * TEACHING NOTE — fail at boot, not at the first customer.
 * Every check here could have been a runtime `if`. Doing them at load time
 * means a pack with a typo'd `escalationAction` crashes `npm start` with a
 * sentence explaining the fix, rather than producing correct-looking triage for
 * three weeks and then failing to escalate the one ticket that mattered.
 *
 * `npm run pack:validate` runs exactly this, which is why CI can check a pack
 * without an API key.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { PackSchema, type Pack } from "./pack.js";

/** Cheapest possible check that the handbook can ever be a cache prefix. */
const CACHE_MINIMUM_CHARS = 3_000; // ~1024 tokens at ~3 chars/token, conservatively

function fail(packDir: string, message: string): never {
  throw new Error(`Invalid policy pack at ${packDir}:\n  ${message}`);
}

export async function loadPack(dirOrId: string): Promise<Pack> {
  const dir = isAbsolute(dirOrId)
    ? dirOrId
    : resolve(process.cwd(), dirOrId.includes("/") ? dirOrId : join("packs", dirOrId));

  const manifest = join(dir, "pack.ts");
  if (!existsSync(manifest)) {
    fail(dir, `no pack.ts found. A pack is a directory containing pack.ts and a handbook.`);
  }

  const mod = (await import(manifest)) as { default?: unknown; pack?: unknown };
  const raw = mod.default ?? mod.pack;
  if (!raw) fail(dir, `pack.ts must default-export (or export as \`pack\`) a pack object.`);

  const parsed = PackSchema.safeParse(raw);
  if (!parsed.success) {
    fail(dir, parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n  "));
  }
  const cfg = parsed.data;

  const handbookPath = join(dir, cfg.handbook);
  if (!existsSync(handbookPath)) fail(dir, `handbook "${cfg.handbook}" not found.`);
  const handbookText = readFileSync(handbookPath, "utf8");

  // --- Cross-field checks the Zod schema cannot express -------------------

  if (!cfg.taxonomy.actions.includes(cfg.taxonomy.escalationAction)) {
    fail(dir, `taxonomy.escalationAction "${cfg.taxonomy.escalationAction}" is not in taxonomy.actions. ` +
      `Every guardrail corrects TO this action; if it is not a legal value the correction produces an invalid resolution.`);
  }

  const unknownRefund = cfg.authority.refundActions.filter((a) => !cfg.taxonomy.actions.includes(a));
  if (unknownRefund.length > 0) {
    fail(dir, `authority.refundActions contains ${unknownRefund.join(", ")}, which are not in taxonomy.actions. ` +
      `A money-moving action the model can never emit means the ceiling check never fires.`);
  }

  try {
    new RegExp(cfg.citations.clausePattern, "g");
  } catch (e) {
    fail(dir, `citations.clausePattern is not a valid regular expression: ${(e as Error).message}`);
  }

  for (const r of cfg.redaction) {
    try { new RegExp(r.pattern, "g"); }
    catch (e) { fail(dir, `redaction pattern "${r.label}" is invalid: ${(e as Error).message}`); }
  }

  if (cfg.authority.rollingCeilingUsd < cfg.authority.refundLimitUsd) {
    fail(dir, `authority.rollingCeilingUsd (${cfg.authority.rollingCeilingUsd}) is below refundLimitUsd ` +
      `(${cfg.authority.refundLimitUsd}). A single permitted refund would always breach the rolling ceiling.`);
  }

  // Not fatal — a small handbook is a legitimate choice — but it silently
  // disables prompt caching, which is the single most expensive surprise in
  // this codebase. The API does not error on a sub-minimum prefix; it just
  // never caches. So we say it out loud. COURSE REF: Lab 5.
  if (handbookText.length < CACHE_MINIMUM_CHARS) {
    console.warn(
      `[pack:${cfg.id}] handbook is ${handbookText.length} chars (~${Math.round(handbookText.length / 3)} tokens). ` +
      `The cacheable prefix minimum is ~1024 tokens; below it the API silently declines to cache and you pay ` +
      `full price on every request. Verify with usage.cache_read_input_tokens, not by assumption.`,
    );
  }

  return { ...cfg, dir, handbookText };
}
