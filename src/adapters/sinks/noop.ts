/**
 * The advisory-mode sink. Writes nothing anywhere.
 *
 * TEACHING NOTE — this file is a design position, not a placeholder.
 *
 * The default configuration of this service classifies tickets, stores the ones
 * that need a human, serves them on /queue, and touches your ticketing system
 * not at all. That is deliberate on two grounds:
 *
 *   1. Nobody puts an unvetted classifier in the write path of their helpdesk
 *      on day one, and a reference repo whose quickstart demands write
 *      credentials to your production Zendesk does not get run.
 *   2. It is the same shape the course argues for anyway — human in the loop,
 *      escalation as the thing you store, confirmation before action.
 *
 * Run advisory for a week. Read the queue. When the decisions stop surprising
 * you, wire a real sink.
 */
import type { Decision, TicketSink } from "../types.js";

export function noopSink(): TicketSink {
  return {
    name: "noop",
    capabilities: { comment: false, tag: false, setField: false, assign: false },
    async publish(decision: Decision) {
      return { ok: true, actions: [`advisory-only: decision ${decision.id} stored, nothing written back`] };
    },
  };
}
