/**
 * POST /v1/ingest/:source — the webhook receiver.
 *
 * This is the endpoint your existing helpdesk points at, and it is the only
 * one whose security posture matters much, because it is the one exposed to
 * the internet. The order of operations here is the whole design:
 *
 *   1. Is this source configured?           -> 404 (not "which sources exist?")
 *   2. Rate limit, BEFORE verification.     -> 429
 *   3. Verify the signature.                -> 401
 *   4. Parse and normalize.                 -> 202 with reason
 *   5. Idempotency check.                   -> 200 duplicate
 *   6. Run the pipeline.                    -> 200
 *
 * TWO ORDERING DECISIONS WORTH ARGUING ABOUT:
 *
 * Rate limiting runs BEFORE signature verification. HMAC is cheap but not
 * free, and an unauthenticated flood should be dropped by the cheapest check
 * available, not by the one that does crypto over a 2MB body.
 *
 * Idempotency runs BEFORE the model call and AFTER normalization, because the
 * external id comes out of the payload. Webhooks retry — GitHub retries,
 * Zendesk retries, your own proxy retries on a timeout that already succeeded —
 * and a duplicate here means paying twice and filing the same escalation twice.
 * A queue full of doubled tickets is how a reviewer learns to stop trusting it.
 *
 * WHAT THIS RETURNS TO THE CALLER is deliberately thin: an id and a status.
 * Webhook senders do not read response bodies, and the ones that log them log
 * them somewhere you did not choose.
 */
import { Hono } from "hono";
import { runPipeline } from "../pipeline.js";
import { toHttpError } from "../lib/errors.js";
import type { Runtime } from "../runtime.js";

export function ingestRoute(rt: Runtime) {
  const app = new Hono();

  app.post("/:source", async (c) => {
    const name = c.req.param("source");
    const source = rt.sources.get(name);

    // 404 rather than a list of configured sources. An unauthenticated caller
    // does not need to learn your integration inventory.
    if (!source) return c.json({ error: "unknown_source" }, 404);

    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      ?? c.req.header("x-real-ip")
      ?? "unknown";

    const allowed = await rt.store.rateLimit(
      `ingest:${name}:${ip}`, rt.config.rateLimit.ingest, rt.config.rateLimit.windowMs,
    );
    if (!allowed) {
      return c.json({ error: "rate_limited" }, 429, {
        "retry-after": String(Math.ceil(rt.config.rateLimit.windowMs / 1000)),
      });
    }

    // Read the body ONCE, as text. Signature schemes verify exact bytes, and a
    // Request body cannot be consumed twice — re-serializing parsed JSON gives
    // you different bytes and a signature that never matches.
    const rawBody = await c.req.text();

    const verified = await source.verify(c.req.raw.headers, rawBody);
    if (!verified.ok) {
      // Log the reason; return nothing useful. "Signature mismatch" and
      // "secret not configured" are both 401 to the caller and both worth
      // knowing in your logs.
      console.warn(`[ingest:${name}] rejected: ${verified.reason}`);
      return c.json({ error: "unauthorized" }, 401);
    }

    let payload: unknown;
    try { payload = JSON.parse(rawBody); }
    catch { return c.json({ error: "invalid_json" }, 400); }

    const tickets = source.normalize(payload);

    // Empty is the NORMAL case for webhook traffic — a label change, a bot
    // comment, an event type this adapter ignores. 202 rather than 400: the
    // sender did nothing wrong and must not retry.
    if (tickets.length === 0) {
      return c.json({ status: "ignored", detail: "no actionable ticket in this event" }, 202);
    }

    const results: { external_id?: string; id?: string; status: string }[] = [];

    for (const ticket of tickets) {
      if (ticket.external_id) {
        const duplicate = await rt.store.markSeen(ticket.external_id);
        if (duplicate) {
          results.push({ external_id: ticket.external_id, status: "duplicate" });
          continue;
        }
      }

      try {
        const out = await runPipeline(rt, { ...ticket, source: ticket.source ?? name });
        results.push({
          external_id: ticket.external_id,
          id: out.decision.id,
          status: out.stored ? "escalated" : "triaged",
        });
      } catch (err) {
        const { body } = toHttpError(err);
        console.error(`[ingest:${name}] pipeline failed: ${body.detail}`);
        results.push({ external_id: ticket.external_id, status: "failed" });
      }
    }

    const anyFailed = results.some((r) => r.status === "failed");
    return c.json({ received: tickets.length, results }, anyFailed ? 500 : 200);
  });

  return app;
}
