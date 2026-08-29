/**
 * POST /v1/triage — structured outputs.
 *
 * CAPABILITY DEMONSTRATED: constrained generation. Claude is not asked to
 * "reply in JSON"; the schema is enforced by the API, and the SDK validates
 * and types the result for us.
 *
 * The two moving parts:
 *   output_config.format = zodOutputFormat(schema)  <- the constraint
 *   client.messages.parse(...)                      <- validate + type
 *
 * The body itself is built by `buildTriageRequest` in lib/requests.ts, so the
 * eval sweep, the batch script, and the ingest worker send the byte-identical
 * request this route does. What is left here is the HTTP shell: validate in,
 * map errors out.
 *
 * `parse()` returns `parsed_output`, which is null when parsing failed — guard
 * it, do not assert past it in production.
 *
 * QUERY PARAMS, all additive and all off by default:
 *   ?model=<id>     pin the model for this request (the eval sweep uses this)
 *   ?tier=auto      route the model on cheap pre-call signals
 *   ?escalate=true  re-run on the flagship when the first pass is unsure
 *
 * They compose. `?tier=auto&escalate=true` is the shape a real deployment
 * ships: route down by default, buy a second opinion only when the cheap
 * answer admits it is unsure. `meta.usage_per_pass` reports every call made,
 * because a two-pass route that reports only the second pass under-reports its
 * own cost in exactly the way /v1/resolve warns about.
 *
 * COURSE REF: Labs 2 and 7
 */
import { Hono } from "hono";
import { anthropic } from "../anthropic.js";
import { TicketInput, type TriageResult } from "../schemas.js";
import { buildTriageRequest } from "../lib/requests.js";
import { summarizeUsage, sumUsage, type UsageReport } from "../lib/usage.js";
import { toHttpError } from "../lib/errors.js";
import { MODEL_TIERS, MODEL_CATALOG, specFor } from "../config.js";
import type { Runtime } from "../runtime.js";

export function triageRoute(rt: Runtime) {
  const app = new Hono();

  app.post("/", async (c) => {
    const parsedBody = TicketInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsedBody.success) {
      return c.json({ error: "invalid_request", detail: parsedBody.error.issues }, 400);
    }
    const ticket = parsedBody.data;
    const startedAt = Date.now();

    const autoTier = c.req.query("tier") === "auto";
    const mayEscalate = c.req.query("escalate") === "true";
    // An explicit ?model= wins over the configured tier. The eval sweep needs
    // to pin the model per request; a router that quietly overrode it would
    // make the whole comparison measure the router instead.
    const explicitModel = c.req.query("model") ?? null;

    // Validate here rather than letting specFor() throw from inside the cost
    // math. An unknown model in a query param is the CALLER's mistake, so it
    // is a 400 with the known ids listed — not a 500 that reads like our bug.
    if (explicitModel) {
      try { specFor(explicitModel); }
      catch {
        return c.json({
          error: "unknown_model",
          detail: `No pricing or capability data for "${explicitModel}".`,
          known_models: Object.keys(MODEL_CATALOG),
        }, 400);
      }
    }

    const routed = explicitModel
      ? { model: explicitModel, reason: "explicit ?model= override" }
      : autoTier
        ? rt.router.pickModel(ticket.message)
        : rt.modelFor(ticket.message);

    try {
      const usagePerPass: UsageReport[] = [];

      const first = await anthropic.messages.parse(
        buildTriageRequest(ticket, rt.pack, { model: routed.model }),
      );
      // The RESPONSE's model, not the config constant: it survives an alias
      // resolving to something else and stays correct under ?tier=auto.
      usagePerPass.push(summarizeUsage(first.usage, first.model));

      const firstConfidence = (first.parsed_output as TriageResult | null)?.confidence ?? null;

      // Second opinion, but only when the first pass says it needs one AND it
      // was not already the flagship — re-asking the same model the same
      // question costs money and buys nothing.
      const needsSecondOpinion =
        mayEscalate &&
        firstConfidence !== null &&
        firstConfidence < rt.router.escalateBelow &&
        first.model !== MODEL_TIERS.flagship;

      const second = needsSecondOpinion
        ? await anthropic.messages.parse(
            buildTriageRequest(ticket, rt.pack, { model: MODEL_TIERS.flagship }),
          )
        : null;

      if (second) usagePerPass.push(summarizeUsage(second.usage, second.model));

      const response = second ?? first;
      const escalated = second
        ? { from: first.model, to: second.model, confidence: firstConfidence! }
        : null;

      if (!response.parsed_output) {
        return c.json({
          error: "unparseable_output",
          detail: "The model response did not validate against the triage schema.",
          stop_reason: response.stop_reason,
        }, 502);
      }

      return c.json({
        triage: response.parsed_output as TriageResult,
        meta: {
          model: response.model,
          pack: rt.pack.id,
          stop_reason: response.stop_reason,
          latency_ms: Date.now() - startedAt,
          routed,
          escalated,
          usage: sumUsage(usagePerPass),
          // Every call this request made. When two passes ran, `usage` above
          // is their SUM — reporting only the final pass would hide the first
          // one's cost, the same trap /v1/resolve documents for tool loops.
          usage_per_pass: usagePerPass,
        },
      });
    } catch (err) {
      const { status, body } = toHttpError(err);
      return c.json(body, status as 400);
    }
  });

  return app;
}
