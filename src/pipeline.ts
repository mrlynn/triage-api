/**
 * The ingest pipeline: one canonical ticket in, one stored decision out.
 *
 * Every path that triages a real ticket goes through here — the webhook
 * receiver, the CLI replay, the tests. The route handlers own HTTP; this owns
 * what actually happens, in an order that is deliberate at every step.
 *
 * THE ORDER, AND WHY:
 *
 *   1. redact      Before anything else touches the text. Not after triage,
 *                  not "on the way to the database" — the raw card number
 *                  should never exist anywhere downstream of this line.
 *   2. triage      The model call. The only step that costs money.
 *   3. escalate    Confidence floor applied AFTER the answer, in code. The
 *                  model's own `requires_human` is a hypothesis; a low
 *                  confidence score forcing it true is a control.
 *   4. persist     ONLY when a human is needed. See below.
 *   5. publish     Sinks, last, and their failure cannot lose steps 1-4.
 *
 * STORAGE IS A CONSEQUENCE OF ESCALATION, NOT OF SUBMISSION. A ticket that the
 * classifier handles confidently is answered and forgotten. Only the ones a
 * human has to look at are written down, and only in redacted form. A support
 * system that logs every inbound message forever has built a breach waiting
 * for an occasion, and "we might want the data later" is not a retention
 * policy — the TTL index in the Mongo store is.
 */
import { anthropic } from "./anthropic.js";
import { buildTriageRequest } from "./lib/requests.js";
import { redactPII } from "./lib/untrusted.js";
import { summarizeUsage } from "./lib/usage.js";
import type { CanonicalTicket, TriageResult } from "./schemas.js";
import type { Decision, EscalationRecord, PublishResult } from "./adapters/types.js";
import type { Runtime } from "./runtime.js";

export interface PipelineResult {
  decision: Decision;
  /** True when the decision was written to the escalation queue. */
  stored: boolean;
  /** One entry per configured sink. Empty in advisory mode. */
  published: { sink: string; result: PublishResult }[];
  /** Set when the confidence floor overrode the model's own judgement. */
  forced_human: boolean;
  latency_ms: number;
}

let counter = 0;
function newId(): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  counter = (counter + 1) % 10_000;
  return `TQ-${stamp}-${String(counter).padStart(4, "0")}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function runPipeline(rt: Runtime, ticket: CanonicalTicket): Promise<PipelineResult> {
  const startedAt = Date.now();

  // 1. REDACT. First, unconditionally, before the text reaches a model, a log,
  //    or a database. The counts travel with the decision; the values do not.
  const { text: safeMessage, redactions } = redactPII(ticket.message, rt.redactions);
  const safeTicket: CanonicalTicket = { ...ticket, message: safeMessage };

  // 2. TRIAGE.
  const routed = rt.modelFor(safeMessage);
  const response = await anthropic.messages.parse(
    buildTriageRequest(safeTicket, rt.pack, { model: routed.model }),
  );
  const triage = response.parsed_output as TriageResult | null;
  if (!triage) {
    throw new Error(
      `The model response did not validate against the triage schema (stop_reason: ${response.stop_reason}).`,
    );
  }
  const usage = summarizeUsage(response.usage, response.model);

  // 3. ESCALATE. The model reports its own confidence; the floor is ours.
  //    An unsure classification is not a classification, and the cheapest
  //    possible correction is to hand it to a person.
  const forced_human = !triage.requires_human && triage.confidence < rt.router.escalateBelow;
  if (forced_human) {
    triage.requires_human = true;
    triage.escalation_reason =
      `Confidence ${triage.confidence.toFixed(2)} is below the ${rt.router.escalateBelow} floor for pack "${rt.pack.id}".`;
  }

  const decision: Decision = {
    id: newId(),
    ticket: safeTicket,
    triage,
    violations: [],
    redactions,
    model: response.model,
    cost_usd: usage.estimated_cost_usd,
    created_at: new Date().toISOString(),
  };

  // Usage accounting happens for every ticket, escalated or not — it is a
  // rollup, not a transcript, so it does not carry the privacy cost that
  // storing the ticket would.
  await rt.store.recordUsage(
    decision.created_at.slice(0, 10),
    usage.total_input_tokens + usage.output_tokens,
    Math.round(usage.estimated_cost_usd * 1_000_000),
  );

  // 4. PERSIST — only what a human has to see.
  let stored = false;
  if (triage.requires_human) {
    const record: EscalationRecord = {
      ...decision,
      status: "new",
      message_redacted: safeMessage,
    };
    await rt.store.insertEscalation(record);
    stored = true;
  }

  // 5. PUBLISH. Last, and isolated: a sink outage must not cost us a decision
  //    we already paid for and already wrote down.
  const published: { sink: string; result: PublishResult }[] = [];
  for (const sink of rt.sinks) {
    const result = await sink.publish(decision).catch((e: Error) => ({
      ok: false, actions: [], error: e.message,
    }));
    published.push({ sink: sink.name, result });
    if (!result.ok) console.warn(`[sink:${sink.name}] ${result.error}`);
  }

  return { decision, stored, published, forced_human, latency_ms: Date.now() - startedAt };
}
