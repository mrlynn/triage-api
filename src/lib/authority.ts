/**
 * Deterministic authority checks.
 *
 * TEACHING NOTE — the single most important idea in Lab 8:
 *
 *     A model-judged boolean is a HYPOTHESIS. A control is CODE.
 *
 * The resolution schema has a field called `within_agent_authority`, described
 * as "False if the action exceeds the $200 agent refund authority." Until this
 * file existed, nothing checked it. The model decided whether the model was
 * allowed to do the thing, reported the answer in a boolean, and the service
 * passed that boolean through to the caller as if it were a fact.
 *
 * That is not a prompt-injection problem specifically. It fails the same way
 * under ordinary arithmetic error, a misread clause, or a customer who is
 * simply very persuasive. Injection just makes it reproducible on demand.
 *
 * The fix is not a better prompt. Refund limits are arithmetic, the amounts
 * are in the tool trace, and code does not have opinions about clause 2.7. So:
 * recompute the decision from the recorded facts, and where the recomputation
 * disagrees with the model, the recomputation wins and the disagreement is
 * reported rather than smoothed over.
 *
 * WHY REPORT THE DISAGREEMENT: `model_claimed_authority_it_lacked` is the most
 * valuable signal this repo emits. A silent correction fixes one response; a
 * counted one tells you your prompt is drifting, or that someone has found an
 * input that works. Correct AND alarm.
 *
 * WHAT CHANGED FROM THE COURSE: the limits come from the pack, and there is a
 * new violation code, `control_unavailable:rolling_ceiling`. See below — it is
 * the honest answer to a question the course never had to ask.
 *
 * COURSE REF: Lab 8 — https://triage.mlynn.dev/docs/labs/lab-08
 */
import type { Resolution } from "../schemas.js";
import type { Pack } from "../pack.js";
import type { ToolCallRecord } from "../tools/index.js";

export interface AuthorityVerdict {
  allowed: boolean;
  /** Machine-readable codes, so an eval can assert on them. */
  violations: string[];
  /** The resolution as it should actually be returned. */
  corrected: Resolution;
}

/** What the deployment can actually verify, given its configured DataProvider. */
export interface ControlAvailability {
  /** False when no DataProvider implements customer lookup. */
  customerLookup: boolean;
}

/**
 * Pulls prior rolling-window refund spend out of the tool trace.
 *
 * Reads the RECORDED tool output rather than the model's prose summary of it,
 * which is the whole point: the trace is what the back office actually said,
 * and the reasoning field is what the model says the back office said.
 */
function priorRefunds(trace: ToolCallRecord[]): number | null {
  for (const call of trace) {
    if (call.tool !== "lookup_customer") continue;
    const out = call.output as { found?: boolean; refunds_last_30d_usd?: unknown } | null;
    if (out && out.found !== false && typeof out.refunds_last_30d_usd === "number") {
      return out.refunds_last_30d_usd;
    }
  }
  return null;
}

/**
 * Re-derives whether the recommended action is actually permitted.
 *
 * @param resolution   What the model produced.
 * @param trace        Every tool call it made, in order.
 * @param pack         Supplies the limits. These are policy, not technique.
 * @param availability What this deployment can verify. See the note below.
 */
export function enforceAuthority(
  resolution: Resolution,
  trace: ToolCallRecord[],
  pack: Pack,
  availability: ControlAvailability = { customerLookup: true },
): AuthorityVerdict {
  const { refundLimitUsd, rollingCeilingUsd, refundActions } = pack.authority;
  const violations: string[] = [];
  const amount = resolution.refund_amount_usd ?? 0;
  const isRefund = refundActions.includes(resolution.recommended_action);

  // The single-refund ceiling.
  if (isRefund && amount > refundLimitUsd) {
    violations.push("refund_exceeds_agent_authority");
  }

  // The rolling ceiling. Only checkable when the agent actually looked the
  // customer up.
  const prior = priorRefunds(trace);
  if (isRefund && prior === null) {
    if (availability.customerLookup) {
      // The tool existed and the agent did not use it. That is the agent's
      // failure and it is a violation.
      violations.push("refund_without_customer_lookup");
    } else {
      /**
       * DEGRADE LOUDLY. No DataProvider in this deployment can look a customer
       * up, so the rolling-ceiling control cannot run at all. The tempting
       * thing is to skip the check and let the refund through — the agent did
       * nothing wrong, after all.
       *
       * That is the wrong instinct, and it is exactly how a guardrail becomes
       * decorative. An unverifiable money-moving action is not the same as a
       * verified-safe one, and a system that cannot tell the difference will
       * report a clean guardrail summary while enforcing nothing. So: it is a
       * violation, it names itself as a missing CONTROL rather than a bad
       * decision, and the action escalates to a human who can check.
       *
       * The fix is to implement `lookupCustomer` in your DataProvider, not to
       * suppress this code.
       */
      violations.push("control_unavailable:rolling_ceiling");
    }
  } else if (isRefund && prior !== null && prior + amount > rollingCeilingUsd) {
    violations.push("refund_exceeds_rolling_ceiling");
  }

  // A refund with no amount is not a small formatting problem — it is an
  // unbounded instruction to a downstream system.
  if (isRefund && resolution.refund_amount_usd === null) {
    violations.push("refund_without_amount");
  }

  const allowed = violations.length === 0;

  // THE MONEY MOMENT. The model asserted it was within authority and the
  // arithmetic says otherwise. Distinct from the violations above, because
  // those describe the ACTION and this one describes the model's SELF-REPORT.
  // A system whose self-reports are unreliable needs different fixes from one
  // whose actions are.
  if (!allowed && resolution.within_agent_authority) {
    violations.push("model_claimed_authority_it_lacked");
  }

  const corrected: Resolution = allowed
    ? resolution
    : {
        ...resolution,
        recommended_action: pack.taxonomy.escalationAction,
        within_agent_authority: false,
        reasoning: `[Automatically escalated: ${violations.join(", ")}.] ` + resolution.reasoning,
      };

  return { allowed, violations, corrected };
}
