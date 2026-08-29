/**
 * Request construction, in one place.
 *
 * TEACHING NOTE: until this file existed, every request body was built inline
 * inside its route handler. That reads fine — right up until you want to send
 * the SAME request somewhere other than the route:
 *
 *   - the Batches API, which takes request bodies and no route (Lab 9)
 *   - `count_tokens`, which must see the EXACT body to be accurate (Lab 5)
 *   - an eval sweep that varies only the model (Lab 7)
 *   - an ingest worker draining a webhook queue (this repo)
 *
 * Each of those is a fork of the route handler if the body is trapped inside
 * it. So the body-building moved out and the routes call these. The rule that
 * falls out: a route handler should own HTTP concerns, not prompt assembly.
 *
 * CACHE WARNING: these functions are on the cached path. `buildSystem` places
 * the breakpoint after the frozen role + handbook, so anything you add here
 * before that block invalidates the prefix for every caller at once.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MAX_TOKENS, EFFORT, specFor } from "../config.js";
import { buildTriageSchema, type Ticket } from "../schemas.js";
import { buildSystem, volatileContext } from "../prompts.js";
import type { Pack } from "../pack.js";
import { wrapUntrusted } from "./untrusted.js";

/** The SDK's own union, so an invalid effort is a compile error, not a 400. */
export type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

/** Overrides an eval sweep or a batch job needs; routes pass none of these. */
export interface BuildOpts {
  model?: string;
  /** Defaults to the per-route value in `EFFORT`. Dropped on models that reject it. */
  effort?: Effort;
  maxTokens?: number;
  /**
   * Interpolates the raw message into the data block instead of escaping it.
   * ONLY for the injection demo and the red-team "undefended" control run —
   * it is the hole Lab 8 closes, kept reachable so you can prove it is real.
   */
  undefended?: boolean;
}

/**
 * Applies `output_config` in a way the target model actually accepts.
 *
 * Haiku 4.5 returns a 400 for `effort`. Rather than making every caller
 * remember that, we consult the catalog and drop the field. The dropped-effort
 * case is reported by `effortApplied` so an eval can label the run honestly
 * instead of quietly comparing a low-effort model against a no-effort one.
 */
export function outputConfigFor(
  model: string,
  effort: Effort,
): { config: { effort?: Effort }; effortApplied: boolean } {
  if (!specFor(model).supportsEffort) {
    return { config: {}, effortApplied: false };
  }
  return { config: { effort }, effortApplied: true };
}

/**
 * The `/v1/triage` request body.
 *
 * The return type is INFERRED, not annotated, and that is load-bearing.
 * `zodOutputFormat(schema)` returns an `AutoParseableOutputFormat` carrying the
 * schema's type as a generic parameter, which is what lets `messages.parse()`
 * type `parsed_output` for you. Annotating this function as
 * `MessageCreateParamsNonStreaming` erases that generic and silently collapses
 * `parsed_output` to `never` — the route still compiles and still runs, and you
 * have quietly thrown away the entire point of Lab 2. Widening a return type is
 * not a free "tidier signature" here.
 */
export function buildTriageRequest(ticket: Ticket, pack: Pack, opts: BuildOpts = {}) {
  const model = opts.model ?? process.env.TRIAGE_MODEL ?? "claude-opus-5";
  const { config } = outputConfigFor(model, opts.effort ?? EFFORT.triage);

  const block = opts.undefended
    ? `<customer_message>\n${ticket.message}\n</customer_message>`
    : wrapUntrusted(ticket.message);

  return {
    model,
    max_tokens: opts.maxTokens ?? MAX_TOKENS.nonStreaming,
    system: buildSystem(
      "triage",
      pack,
      volatileContext({
        channel: ticket.channel,
        customerEmail: ticket.customer_email,
        subject: ticket.subject,
        source: ticket.source,
      }),
    ),
    output_config: {
      // Effort and format both live inside output_config. Triage is a
      // bounded classification on the hot path, so we buy the cheap tier.
      ...config,
      format: zodOutputFormat(buildTriageSchema(pack)),
    },
    messages: [
      {
        role: "user" as const,
        content: `Classify this inbound ${ticket.channel} message.\n\n${block}`,
      },
    ],
  };
}
