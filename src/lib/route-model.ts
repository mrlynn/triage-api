/**
 * Model routing — the "routing" workflow pattern, applied to model choice.
 *
 * TEACHING NOTE: this is the smallest useful agentic pattern and the one most
 * teams skip. The observation behind it: your traffic is not uniform. Most
 * inbound support messages are three lines about a late package, and a few are
 * a parent describing an allergic reaction. Paying flagship rates for the first
 * kind to be safe on the second kind means paying flagship rates on everything.
 *
 * Two mechanisms, and the difference between them matters:
 *
 *   pickModel()  routes BEFORE the call, on cheap signals (length, keywords).
 *                Zero extra cost, but it can only see the input.
 *   escalate     routes AFTER a cheap call, on the model's own confidence.
 *                Costs a second call when it fires, but it sees the answer.
 *
 * Lab 7 measures both. The honest result is that the second one is better and
 * the first one is nearly free, so real systems tend to run them together.
 *
 * A WARNING that Lab 8 makes concrete: `pickModel` reads untrusted customer
 * text. Its keyword list is therefore an attack surface — a message can be
 * written to route itself DOWN to the cheap tier by avoiding safety language,
 * which is exactly what a casually-worded injury report does by accident. That
 * is why the bias here is toward escalation and why `requires_human` is never
 * decided by this function.
 *
 * WHAT CHANGED FROM THE COURSE: the keyword list moves to the pack, because
 * "words that mean this is expensive to get wrong" is domain knowledge, not
 * technique. A medical device company and a games studio share almost none of
 * this list. Built-in stems below are added to whatever the pack supplies —
 * safety and legal language is universal enough to be a floor.
 */
import { MODEL_TIERS } from "../config.js";
import type { Pack } from "../pack.js";

export interface RoutingDecision {
  model: string;
  /** Human-readable, and returned in `meta.routed` so the choice is auditable. */
  reason: string;
}

/**
 * The floor. Deliberately over-broad: a false positive costs the difference
 * between a Haiku call and an Opus call — a fraction of a cent. A false
 * negative costs a mis-routed injury report. The asymmetry is not close.
 *
 * These are stems, matched as substrings, so "injur" catches injured/injury.
 */
const UNIVERSAL_HIGH_STAKES = [
  "injur", "hurt", "burn", "rash", "allerg", "swallow", "choke",
  "hospital", "doctor", "emergency", "child", "kid", "baby", "toddler",
  "lawyer", "attorney", "legal", "lawsuit", "sue ", "court", "regulator",
  "discriminat", "harass", "chargeback", "fraud", "unauthorized",
];

export interface Router {
  pickModel(message: string): RoutingDecision;
  escalateBelow: number;
}

export function buildRouter(pack: Pack): Router {
  const terms = [
    ...UNIVERSAL_HIGH_STAKES,
    ...pack.routing.highStakesKeywords.map((t) => t.toLowerCase()),
  ];
  const shortChars = pack.routing.shortMessageChars;

  return {
    /**
     * Chooses a model for a ticket: the cheapest tier that is defensible.
     *
     * Order matters. The high-stakes check runs FIRST and unconditionally. A
     * short message that mentions a child is still a short message, and it
     * still goes to the flagship model.
     */
    pickModel(message: string): RoutingDecision {
      const haystack = message.toLowerCase();

      const hit = terms.find((term) => haystack.includes(term));
      if (hit) {
        return {
          model: MODEL_TIERS.flagship,
          reason: `high-stakes language ("${hit.trim()}") — cost of a wrong answer exceeds the model price difference`,
        };
      }

      if (message.length <= shortChars) {
        return {
          model: MODEL_TIERS.fast,
          reason: `short message (${message.length} chars), no high-stakes language`,
        };
      }

      return {
        model: MODEL_TIERS.balanced,
        reason: `long message (${message.length} chars) — more facts to extract, no high-stakes language`,
      };
    },

    /**
     * Below this confidence, a cheap-tier answer gets a second opinion.
     *
     * The course's 0.7 is measured, not chosen: on its gold set the ambiguous
     * case scores ~0.46 and the confidently-wrong case scores ~0.71. That is
     * the point Lab 7 makes — escalation buys you coverage of the UNSURE cases
     * and buys you nothing at all against the confidently wrong ones. For those
     * you need a deterministic check, which is Lab 8. Set your own threshold
     * from your own eval run, not from this number.
     */
    escalateBelow: pack.routing.escalateBelow,
  };
}
