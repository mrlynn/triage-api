/**
 * Zod schemas that double as the API's response contract AND the model's
 * output contract.
 *
 * TEACHING NOTE: this is the highest-leverage idea in the whole project. One
 * schema, three jobs:
 *   1. `zodOutputFormat(schema)` constrains what Claude may emit.
 *   2. `client.messages.parse()` validates and types the response.
 *   3. The same type flows out to your HTTP consumers.
 * There is no hand-written JSON parsing anywhere in this codebase, and no
 * "please respond only with JSON" pleading in a prompt.
 *
 * `.describe()` is not decoration — the text is compiled into the JSON Schema
 * sent to the model and is the primary way you steer a field's semantics.
 *
 * WHAT CHANGED FROM THE COURSE: the enums are built from the active pack rather
 * than hardcoded, so the schema is a function of the pack instead of a
 * constant. Everything else is identical. The `.describe()` strings interpolate
 * the pack's clause references, which means changing your handbook numbering
 * updates the model's instructions and the citation verifier together.
 *
 * COURSE REF: Lab 2 — https://triage.mlynn.dev/docs/labs/lab-02
 */
import { z } from "zod";
import type { Pack } from "./pack.js";

/**
 * Zod enums need a non-empty tuple type. Packs are validated to have at least
 * two members before we get here, so this narrowing is safe — but it is a cast,
 * so it is worth saying why rather than leaving a bare `as`.
 */
function enumOf(values: string[]): z.ZodEnum<Record<string, string>> {
  return z.enum(values as [string, ...string[]]) as unknown as z.ZodEnum<Record<string, string>>;
}

export function buildTriageSchema(pack: Pack) {
  const { taxonomy, authority } = pack;
  const catRef = authority.clauseRefs.categoryDefinitions || "the category definitions section";
  const escRef = authority.clauseRefs.escalationTriggers || "the escalation section";

  return z.object({
    category: enumOf(taxonomy.categories).describe(
      `The single best-fitting category, using the definitions in section ${catRef} of the policy handbook.`,
    ),
    urgency: enumOf(taxonomy.urgencies).describe(
      `Urgency per the definitions in section ${catRef}. Safety reports are always the highest urgency.`,
    ),
    sentiment: enumOf(taxonomy.sentiments).describe(
      "The customer's emotional register, not the severity of the issue.",
    ),
    summary: z
      .string()
      .describe(
        "One sentence, under 25 words, stating what the customer wants. Written for an agent skimming a queue.",
      ),
    entities: z
      .object({
        order_ids: z
          .array(z.string())
          .describe("Order identifiers mentioned, verbatim. Empty array if none."),
        product_names: z
          .array(z.string())
          .describe("Product or service names mentioned. Empty array if none."),
        requested_remedy: enumOf(taxonomy.remedies).describe(
          "What the customer explicitly asked for, not what you think they should get.",
        ),
      })
      .describe("Structured facts lifted from the message with no inference."),
    requires_human: z
      .boolean()
      .describe(
        `True if policy section ${escRef} mandates supervisor escalation, or if a confident automated reply is not possible.`,
      ),
    escalation_reason: z
      .string()
      .nullable()
      .describe("Why a human is required, or null when requires_human is false."),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Your calibrated confidence in this classification. Use the full range — a genuinely ambiguous ticket should score near 0.5, not 0.9.",
      ),
  });
}

/**
 * The structural shape of a triage result, independent of any pack's
 * vocabulary. Guardrails, stores, and adapters are typed against this so they
 * do not need to know which pack is loaded.
 */
export interface TriageResult {
  category: string;
  urgency: string;
  sentiment: string;
  summary: string;
  entities: {
    order_ids: string[];
    product_names: string[];
    requested_remedy: string;
  };
  requires_human: boolean;
  escalation_reason: string | null;
  confidence: number;
}

/** The resolution plan produced by the tool-using agent in /v1/resolve. */
export function buildResolutionSchema(pack: Pack) {
  const limit = pack.authority.refundLimitUsd;
  const ref = pack.authority.clauseRefs.refundLimit;
  const authorityNote = ref
    ? `False if the action exceeds the $${limit} agent refund authority in clause ${ref}.`
    : `False if the action exceeds the $${limit} agent refund authority.`;

  return z.object({
    recommended_action: enumOf(pack.taxonomy.actions).describe(
      "The single action the agent should take.",
    ),
    policy_citations: z
      .array(z.string())
      .describe(
        "Specific handbook clause numbers that justify the action. Never cite a clause you did not read via the search_policy tool.",
      ),
    refund_amount_usd: z
      .number()
      .nullable()
      .describe("Dollar amount when recommending a refund, otherwise null."),
    within_agent_authority: z.boolean().describe(authorityNote),
    reasoning: z
      .string()
      .describe(
        "Two or three sentences an agent can read before acting. Reference the facts you looked up.",
      ),
  });
}

export interface Resolution {
  recommended_action: string;
  policy_citations: string[];
  refund_amount_usd: number | null;
  within_agent_authority: boolean;
  reasoning: string;
}

/**
 * Request body shared by every route that takes a ticket, and the normalized
 * form every source adapter must produce.
 *
 * `external_id` is what makes ingest idempotent. A webhook that fires twice —
 * and they all do — must not produce two triage calls and two queue entries.
 */
export const TicketInput = z.object({
  message: z.string().min(1, "message is required").max(20_000),
  customer_email: z.string().email().optional(),
  channel: z.enum(["email", "chat", "phone_transcript", "web", "api"]).default("email"),
  subject: z.string().max(500).optional(),
  external_id: z.string().max(200).optional(),
  external_url: z.string().url().optional(),
  source: z.string().max(64).optional(),
});
export type Ticket = z.infer<typeof TicketInput>;
export type CanonicalTicket = Ticket;
