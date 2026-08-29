/**
 * POST /v1/draft — streaming.
 *
 * CAPABILITY DEMONSTRATED: token-by-token delivery over SSE, plus the two
 * things people forget when they wire streaming into a real service:
 *
 *   1. `usage` is not available until the stream finishes. `finalMessage()`
 *      resolves with the complete Message, so we emit a terminal `done` event
 *      carrying cost and stop_reason. Clients that need accounting get it.
 *   2. Client disconnects. If the caller hangs up mid-generation you are still
 *      paying for tokens. We abort the upstream stream on the request signal.
 *
 * Note the max_tokens jump to 64k: on a stream, HTTP timeouts are not the
 * constraint they are on a blocking request, so we give the model room.
 *
 * A NOTE ON WHAT THIS ROUTE IS FOR IN THIS REPO. It drafts a reply. It does not
 * send one, and no sink in this repository sends one either — the Zendesk sink
 * writes an internal note by default and says why. A draft a human reads before
 * sending is a useful tool; the same text delivered automatically is a
 * different product with a different risk profile.
 *
 * COURSE REF: Lab 4
 */
import { Hono } from "hono";
import { anthropic } from "../anthropic.js";
import { MAX_TOKENS, EFFORT } from "../config.js";
import { TicketInput } from "../schemas.js";
import { buildSystem, volatileContext } from "../prompts.js";
import { summarizeUsage } from "../lib/usage.js";
import { toHttpError } from "../lib/errors.js";
import { wrapUntrusted } from "../lib/untrusted.js";
import { SSE_HEADERS, sseEvent } from "../lib/sse.js";
import type { Runtime } from "../runtime.js";

export function draftRoute(rt: Runtime) {
  const app = new Hono();

  app.post("/", async (c) => {
    const parsedBody = TicketInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsedBody.success) {
      return c.json({ error: "invalid_request", detail: parsedBody.error.issues }, 400);
    }
    const ticket = parsedBody.data;

    const stream = anthropic.messages.stream({
      model: rt.modelFor(ticket.message).model,
      max_tokens: MAX_TOKENS.streaming,
      system: buildSystem("draft", rt.pack, volatileContext({
        channel: ticket.channel,
        customerEmail: ticket.customer_email,
        subject: ticket.subject,
      })),
      output_config: { effort: EFFORT.draft },
      // `display: "summarized"` is opt-in. Without it, thinking blocks stream
      // with EMPTY text on Opus 5 — from a UI's point of view that looks like
      // a long silent pause before the answer appears.
      thinking: { type: "adaptive", display: "summarized" },
      messages: [
        { role: "user", content: `Write the reply to this customer.\n\n${wrapUntrusted(ticket.message)}` },
      ],
    });

    // Hang up upstream if the client hangs up on us.
    c.req.raw.signal.addEventListener("abort", () => stream.abort());

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) =>
          controller.enqueue(encoder.encode(sseEvent(event, data)));

        try {
          for await (const event of stream) {
            if (event.type === "content_block_delta") {
              switch (event.delta.type) {
                case "text_delta":
                  send("text", { text: event.delta.text });
                  break;
                case "thinking_delta":
                  // Surfaced separately so a UI can render it in a collapsed
                  // "reasoning" panel rather than in the reply body.
                  send("thinking", { text: event.delta.thinking });
                  break;
              }
            }
          }

          const final = await stream.finalMessage();
          send("done", {
            stop_reason: final.stop_reason,
            // stop_details is populated ONLY on stop_reason "refusal" — null
            // everywhere else, so always guard before reading it.
            stop_details: final.stop_reason === "refusal" ? final.stop_details : null,
            model: final.model,
            usage: summarizeUsage(final.usage, final.model),
          });
        } catch (err) {
          const { body: errorBody } = toHttpError(err);
          // The HTTP status is already 200 by the time streaming starts, so
          // errors must be delivered in-band as an event. Clients need to
          // handle an `error` event, not just a non-2xx response.
          send("error", errorBody);
        } finally {
          controller.close();
        }
      },
      cancel() { stream.abort(); },
    });

    return new Response(body, { headers: SSE_HEADERS });
  });

  return app;
}
