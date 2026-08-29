/**
 * The starter pack — copy this directory, rename it, and edit it.
 *
 * This is the file you are meant to change. Everything in `src/` is technique;
 * everything here is your company. Work top to bottom:
 *
 *   1. `companyName` — appears in every prompt.
 *   2. `handbook.md` — replace with your real policy. Keep clause numbers.
 *   3. `taxonomy`    — your categories. Fewer is better. See the note below.
 *   4. `authority`   — your real limits. These become CODE, not suggestions.
 *   5. `evals/`      — 10-15 real tickets you have hand-labelled. Do not skip this.
 *   6. `fixtures/`   — or wire a real DataProvider in triage.config.ts.
 *
 * The step people skip is 5, and it is the one that decides whether any of this
 * works. Without an eval set you have a system that produces confident output
 * and no way to know whether it is right — which is strictly worse than no
 * system, because someone will trust it. COURSE REF: Lab 0 and Lab 6.
 */
import type { PackConfig } from "../../src/pack.js";

const pack: PackConfig = {
  id: "starter",
  companyName: "Acme",
  description: "Generic B2C/SaaS support pack. Copy this, do not edit it in place.",

  taxonomy: {
    /**
     * These become a Zod enum, which becomes JSON Schema, which is what actually
     * constrains the model. An enum here is a hard guarantee — the model cannot
     * emit a value that is not on this list.
     *
     * Keep the list short and mutually exclusive. A 30-category taxonomy does
     * not produce a more precise classifier; it produces a confidently wrong one
     * with an eval set too thin to notice. Start with 6-8. Watch what lands in
     * `other`. Split a category only when the data asks you to.
     */
    categories: ["billing", "delivery", "product_issue", "returns", "account", "safety", "other"],
    urgencies: ["low", "normal", "high", "urgent"],
    sentiments: ["angry", "frustrated", "neutral", "positive"],
    remedies: ["refund", "replacement", "information", "cancellation", "escalation", "none"],
    actions: [
      "issue_refund",
      "ship_replacement",
      "provide_information",
      "decline_with_goodwill",
      "escalate_to_supervisor",
    ],
    /** Every guardrail corrects TO this action. It must be in `actions`. */
    escalationAction: "escalate_to_supervisor",
  },

  handbook: "handbook.md",

  /**
   * These numbers are re-derived in code after the model answers. The model is
   * also told about them in the prompt, but that is a hypothesis; this is the
   * control. If the model says $340 is within a $200 authority, the arithmetic
   * wins, the resolution is rewritten to an escalation, and the disagreement is
   * COUNTED as `model_claimed_authority_it_lacked`. See src/lib/authority.ts.
   */
  authority: {
    refundLimitUsd: 200,
    rollingCeilingUsd: 500,
    rollingWindowDays: 30,
    refundActions: ["issue_refund"],
    /** Quoted back to the model and printed in violation messages. */
    clauseRefs: {
      refundLimit: "2.7",
      rollingCeiling: "5.3",
      escalationTriggers: "5.3",
      categoryDefinitions: "8",
    },
  },

  /**
   * How a clause number looks in YOUR handbook. The default matches `2.7`/`5.3`.
   * A handbook numbered `POL-114` needs `"POL-\\d{3}"` here — otherwise
   * `verifyCitations` finds no clauses in the text, and reports every citation
   * the model makes as fabricated.
   */
  citations: { clausePattern: "\\b\\d{1,2}\\.\\d{1,2}\\b" },

  /**
   * APPENDED to the built-in role prefixes — including the non-negotiable trust
   * boundary in src/pack.ts. You cannot delete that by editing this.
   *
   * Keep this text FROZEN. It sits inside the cached prompt prefix; a value
   * that varies per request (a date, a customer name) costs you every cache hit
   * you have. Per-request context goes in `volatileContext()`, after the
   * breakpoint. COURSE REF: Lab 5.
   */
  prompts: {
    triage: `Rules:
- Extract entities verbatim. If the customer wrote an order number without punctuation, report what they wrote.
- Do not infer facts that are not in the message. If no order number appears, the array is empty.
- Safety outranks everything. Any mention of injury, illness, fire, or property damage is category "safety", urgency "urgent", and requires_human true.`,

    resolve: `Method — follow it in order:
1. Look up every order or subscription the customer references. Never restate a fact from the customer's own message without verifying it.
2. Look up the customer's account standing when the decision involves money or escalation.
3. Search the policy handbook for the specific clauses that govern this situation.
4. Only then decide.

Constraints:
- Prefer the smallest correct action. Do not offer goodwill before the actual problem is fixed (clause 6.3).`,

    draft: `Follow the tone rules in section 1 of the handbook strictly: lead with the resolution before the apology, at most one apology, no exclamation marks when discussing money or delays, no internal jargon, and never the words "unfortunately", "as per our policy", or "I'm afraid".

- Whenever you mention a refund, state the clause 2.3 timeline plainly: 5-7 business days to appear on their statement. Never "today" or "immediately".
- The first sentence must state what is happening. Do not open with a pleasantry.
- Never commit to a fix date or a "known issue" that is not on the public status page.
- Never state an order or billing fact you were not given.

Aim for 150 words, hard ceiling 180.`,
  },

  /**
   * Added on top of the built-in card-number and SSN rules. Matches are counted
   * and replaced; the value is never logged, stored, or returned.
   * Example: an internal employee ID that must never reach a model.
   */
  redaction: [
    // { label: "employee_id", pattern: "\\bEMP-\\d{6}\\b" },
  ],

  routing: {
    /** Any hit routes to the flagship tier BEFORE the call. Lab 7. */
    highStakesKeywords: [
      "lawyer", "attorney", "legal", "lawsuit", "sue", "chargeback", "fraud",
      "injury", "injured", "hospital", "burn", "fire", "allergic",
      "discrimination", "press", "journalist", "regulator",
    ],
    shortMessageChars: 240,
    /** Confidence floor. Below this, requires_human is forced true AFTER the call. */
    escalateBelow: 0.7,
  },
};

export default pack;
