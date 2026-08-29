/**
 * POST /v1/resolve — tool use / agentic loop.
 *
 * CAPABILITY DEMONSTRATED: Claude decides which of our systems to query, in
 * what order, and when it has enough information to stop. The SDK's tool
 * runner drives the request -> execute -> feed-back-result loop so we don't
 * hand-write `while (stop_reason === "tool_use")`.
 *
 * Four things this route does that toy examples usually skip:
 *   1. Caps `max_iterations` — an uncapped agent loop is an uncapped bill.
 *   2. Accumulates usage across EVERY turn, not just the last one. The final
 *      message's usage covers only the final request; a 5-turn loop that
 *      reports the last turn's usage under-reports cost by roughly 5x.
 *   3. Returns the tool trace, so a reviewer can see what the model actually
 *      looked at before deciding. "Show your work" is an auditability
 *      requirement in support tooling, not a nicety.
 *   4. Returns the CORRECTED resolution, having re-derived the authority
 *      decision from the trace rather than trusting the model's self-report.
 *
 * COURSE REF: Labs 3 and 8
 */
import { Hono } from "hono";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { anthropic } from "../anthropic.js";
import { MAX_TOKENS, EFFORT } from "../config.js";
import { buildResolutionSchema, TicketInput, type Resolution } from "../schemas.js";
import { buildSystem, volatileContext } from "../prompts.js";
import { summarizeUsage, sumUsage, type UsageReport } from "../lib/usage.js";
import { toHttpError } from "../lib/errors.js";
import { enforceAuthority } from "../lib/authority.js";
import { wrapUntrusted } from "../lib/untrusted.js";
import { safeJson } from "../lib/json.js";
import { createTools, type ToolCallRecord } from "../tools/index.js";
import type { Runtime } from "../runtime.js";

/** Hard ceiling on agent turns. Tune deliberately; never leave it unset. */
const MAX_ITERATIONS = 8;

export function resolveRoute(rt: Runtime) {
  const app = new Hono();
  const ResolutionSchema = buildResolutionSchema(rt.pack);

  app.post("/", async (c) => {
    const parsedBody = TicketInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsedBody.success) {
      return c.json({ error: "invalid_request", detail: parsedBody.error.issues }, 400);
    }
    const ticket = parsedBody.data;
    const startedAt = Date.now();

    // The trace array is closed over by every tool, so calls land here in order.
    const trace: ToolCallRecord[] = [];
    const usagePerTurn: UsageReport[] = [];

    try {
      const runner = anthropic.beta.messages.toolRunner({
        model: rt.modelFor(ticket.message).model,
        max_tokens: MAX_TOKENS.nonStreaming,
        max_iterations: MAX_ITERATIONS,
        system: buildSystem("resolve", rt.pack, volatileContext({
          channel: ticket.channel,
          customerEmail: ticket.customer_email,
          subject: ticket.subject,
          source: ticket.source,
        })),
        output_config: {
          effort: EFFORT.resolve,
          // Constrains the FINAL answer. Intermediate turns still emit
          // tool_use blocks normally — the format applies to the text Claude
          // settles on.
          format: betaZodOutputFormat(ResolutionSchema),
        },
        tools: createTools(rt.toolDefs, trace, rt.redactions),
        messages: [
          {
            role: "user",
            content:
              `Determine what ${rt.pack.companyName} should do about this ${ticket.channel} message. ` +
              `Look up the facts before you decide.\n\n` +
              wrapUntrusted(ticket.message),
          },
        ],
      });

      // Iterating the runner (rather than just awaiting it) is what lets us
      // observe each turn. Awaiting `runner` directly would give us the final
      // message and silently discard intermediate usage.
      for await (const message of runner) {
        usagePerTurn.push(summarizeUsage(message.usage, message.model));

        // A server-side tool can end a turn with pause_turn. The runner only
        // auto-continues after a CLIENT tool returns a result, so a paused
        // turn would otherwise end the loop with a silently truncated answer.
        if (message.stop_reason === "pause_turn") {
          runner.pushMessages({ role: "assistant", content: message.content });
        }
      }

      const final = await runner.done();

      // `toolRunner` has no `parsed_output` — that convenience belongs to
      // `messages.parse()`. With `output_config.format` set, the final text is
      // schema-conformant JSON, so we validate it ourselves.
      const text = final.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");

      const validated = ResolutionSchema.safeParse(safeJson(text));
      if (!validated.success) {
        return c.json({
          error: "unparseable_output",
          detail: "The agent's final message did not validate against the resolution schema.",
          stop_reason: final.stop_reason,
          iterations: usagePerTurn.length,
          raw: text.slice(0, 2000),
        }, 502);
      }

      // GUARDRAILS. Everything above this line trusted the model's own account
      // of what it was allowed to do. Everything below re-derives it from the
      // recorded facts, and where the two disagree the recomputation wins.
      const resolution = validated.data as Resolution;
      const authority = enforceAuthority(resolution, trace, rt.pack, rt.availability);
      const citations = rt.verifyCitations(resolution.policy_citations, trace);

      return c.json({
        // The CORRECTED resolution, not the model's. A caller that has to
        // remember to check a sibling field before acting will eventually
        // forget, so the safe value is the one in the obvious place.
        resolution: authority.corrected,
        tool_trace: trace,
        meta: {
          guardrails: {
            authority_allowed: authority.allowed,
            authority_violations: authority.violations,
            unsupported_citations: citations.unsupported,
            cited_without_search: citations.cited_without_search,
            policy_searched: citations.searched,
            redactions: trace.reduce((n, t) => n + t.redactions.length, 0),
            /** Which controls this deployment can actually run. See authority.ts. */
            controls_available: rt.availability,
          },
          model: final.model,
          pack: rt.pack.id,
          tools_offered: rt.toolDefs.map((d) => d.name),
          stop_reason: final.stop_reason,
          iterations: usagePerTurn.length,
          hit_iteration_cap: usagePerTurn.length >= MAX_ITERATIONS,
          latency_ms: Date.now() - startedAt,
          usage_total: sumUsage(usagePerTurn),
          usage_per_turn: usagePerTurn,
        },
      });
    } catch (err) {
      const { status, body } = toHttpError(err);
      return c.json(body, status as 400);
    }
  });

  return app;
}
