/**
 * Citation verification — checking that quoted clauses were actually read.
 *
 * TEACHING NOTE: the `search_policy` tool description already says
 *
 *     "Cite only clause numbers that appear in text this tool returned to you."
 *
 * and the resolution schema repeats it. Both are instructions. Neither is a
 * check. Until this file, a resolution could cite clause 9.9 — which does not
 * exist in the handbook — and the service would return it with the same
 * confidence as a real one.
 *
 * That matters more here than in most domains. A policy citation is the thing
 * a human agent uses to decide whether to trust the recommendation, and an
 * invented one is *more* persuasive than no citation at all. A hallucinated
 * source does not read as uncertainty; it reads as diligence.
 *
 * A CORRECTION WORTH READING, because the first version of this file got it
 * wrong in an instructive way.
 *
 * The obvious check is "did this clause appear in a `search_policy` result?",
 * and the tool description invites exactly that reading. It produces false
 * positives on every run, because **the entire handbook is already in the
 * cached system prompt** (see `prompts.ts`). The model does not need the tool
 * to know what clause 2.7 says — it can read it directly — so a resolution
 * citing 2.7 without a matching tool call is completely legitimate.
 *
 * The first version of this checker flagged four real clauses as fabricated.
 * The verifier was wrong about the architecture, and it took a red-team run to
 * notice.
 *
 * So the real check is EXISTENCE: does the cited clause exist in the handbook
 * at all? That catches the forged "clause 9.9" and permits every genuine
 * citation regardless of how the model came to know it. Whether the agent
 * searched before citing is still worth reporting — it is a diligence signal —
 * but it is not a violation, and conflating the two produces a checker that
 * cries wolf until someone turns it off.
 *
 * WHAT CHANGED FROM THE COURSE: the clause pattern comes from the pack. If your
 * handbook numbers clauses `POL-114`, set `citations.clausePattern` — otherwise
 * this finds zero real clauses and reports every citation as fabricated, which
 * is a very loud way to discover you skipped a config field.
 *
 * COURSE REF: Lab 8
 */
import type { ToolCallRecord } from "../tools/index.js";
import type { Pack } from "../pack.js";

export interface CitationReport {
  /** Clause numbers the resolution claims to rely on. */
  cited: string[];
  /** Cited clauses that do not exist in the handbook. Fabricated sources. */
  unsupported: string[];
  /**
   * Real clauses cited without a matching `search_policy` result. NOT a
   * violation — the handbook is in the system prompt — but a diligence signal
   * worth surfacing when an agent is confidently citing things it never
   * looked up.
   */
  cited_without_search: string[];
  /** Whether the agent ran any policy search at all. */
  searched: boolean;
}

/** Per-pack verifier, built once at boot so the handbook is scanned once. */
export interface CitationVerifier {
  (citations: string[], trace: ToolCallRecord[]): CitationReport;
}

export function buildCitationVerifier(pack: Pack): CitationVerifier {
  const source = pack.citations.clausePattern;
  const realClauses: ReadonlySet<string> = new Set(
    [...pack.handbookText.matchAll(new RegExp(source, "g"))].map((m) => m[0]),
  );

  if (realClauses.size === 0) {
    console.warn(
      `[pack:${pack.id}] citations.clausePattern /${source}/ matched nothing in the handbook. ` +
        `Every citation the model makes will be reported as fabricated. Fix the pattern or ` +
        `number your handbook's clauses.`,
    );
  }

  return function verifyCitations(citations, trace) {
    const clause = () => new RegExp(source, "g");

    const seen = new Set<string>();
    for (const call of trace) {
      if (call.tool !== "search_policy") continue;
      const text = typeof call.output === "string" ? call.output : JSON.stringify(call.output);
      for (const match of text.matchAll(clause())) seen.add(match[0]);
    }
    const searched = trace.some((c) => c.tool === "search_policy");

    // Normalize: the model may cite "clause 2.7" or "§2.7" rather than a bare id.
    const cited = citations
      .flatMap((c) => [...String(c).matchAll(clause())].map((m) => m[0]))
      .filter((c, i, arr) => arr.indexOf(c) === i);

    return {
      cited,
      unsupported: cited.filter((c) => !realClauses.has(c)),
      cited_without_search: cited.filter((c) => realClauses.has(c) && !seen.has(c)),
      searched,
    };
  };
}
