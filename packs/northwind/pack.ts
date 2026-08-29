/**
 * The Northwind Outfitters pack — the course's fictional retailer, extracted.
 *
 * This exists so a fresh clone runs the exact demo from https://triage.mlynn.dev
 * with no configuration: same taxonomy, same handbook, same $200/$500 authority
 * limits, same eval set, same 14 red-team cases. If you change something here
 * and the eval score moves, you learned something real.
 *
 * To adapt this to your own company, copy `packs/starter` instead — this pack
 * is a fixture and should stay byte-comparable to the course.
 */
import type { PackConfig } from "../../src/pack.js";

const pack: PackConfig = {
  id: "northwind",
  companyName: "Northwind Outfitters",
  description: "The course's fictional outdoor-gear retailer. Reference fixture; do not edit.",

  taxonomy: {
    categories: ["billing", "shipping", "product_defect", "returns", "account", "safety", "other"],
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
    escalationAction: "escalate_to_supervisor",
  },

  handbook: "handbook.md",

  authority: {
    refundLimitUsd: 200,
    rollingCeilingUsd: 500,
    rollingWindowDays: 30,
    refundActions: ["issue_refund"],
    clauseRefs: {
      refundLimit: "2.7",
      rollingCeiling: "5.3",
      escalationTriggers: "5.3",
      categoryDefinitions: "8",
    },
  },

  citations: { clausePattern: "\\b\\d{1,2}\\.\\d{1,2}\\b" },

  prompts: {
    triage: `Rules:
- Extract entities verbatim. If the customer wrote "NW48211" with no dash, report what they wrote.
- Do not infer facts that are not in the message. If no order number appears, the array is empty.
- Safety outranks everything. Any mention of injury, illness, fire, or property damage is category "safety", urgency "urgent", and requires_human true.`,

    resolve: `Method — follow it in order:
1. Look up every order the customer references. Never restate an order fact from the customer's own message without verifying it.
2. Look up the customer's account standing when the decision involves money or escalation.
3. Search the policy handbook for the specific clauses that govern this situation.
4. Only then decide.

Constraints:
- Prefer the smallest correct action. Do not offer goodwill discounts before the actual problem is fixed (clause 6.3).`,

    draft: `Follow the tone rules in section 1 of the handbook strictly. In particular: lead with the resolution before the apology, at most one apology, no exclamation marks when discussing money or delays, no internal jargon, and never use the words "unfortunately", "as per our policy", or "I'm afraid".

Hard constraints — these are the ones replies most often break, so they are restated here rather than left for you to find in the handbook:
- Never promise a refund "today", "immediately", "right away", or "now" — and do not say you will "process it today" either, which reads to a customer as money arriving today. Whenever you mention a refund, state the clause 2.3 timeline plainly: it takes 5-7 business days to appear on their statement.
- The first sentence must state what is happening. Do not open with a pleasantry — no "Thank you for telling us about this", no "Thanks for reaching out". Gratitude, if any, goes later.
- Never commit to a fix date, a future feature, or a "known issue" that is not on the public status page.
- Do not offer a goodwill discount before the underlying problem is resolved (clause 6.3).
- Never state an order fact you were not given. If you do not know a delivery date, do not invent one.

Aim for 150 words. The hard ceiling is 180 and a reply that exceeds it is rejected, so leave yourself margin.`,
  },

  redaction: [],

  routing: {
    highStakesKeywords: [
      "lawyer", "attorney", "legal", "lawsuit", "sue", "chargeback", "fraud",
      "injury", "injured", "hospital", "burn", "fire", "smoke", "allergic",
      "discrimination", "press", "journalist", "bbb", "regulator",
    ],
    shortMessageChars: 240,
    escalateBelow: 0.7,
  },
};

export default pack;
