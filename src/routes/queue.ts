/**
 * GET /v1/queue, PATCH /v1/queue/:id, GET /v1/decisions/:id
 *
 * The reviewer's API. Small on purpose.
 *
 * NOTE WHAT IS ABSENT: there is no endpoint to edit a ticket's message or its
 * classification. A reviewer can claim, resolve, or dismiss — three verbs that
 * describe what a human DID — and that is all. The moment you let a reviewer
 * silently correct a classification in place, your queue stops being a record
 * of what the system decided and becomes a record of what someone wishes it
 * had decided, and your eval set loses its only honest source of new cases.
 *
 * If a classification is wrong, dismiss it and add it to `packs/<id>/evals/`.
 * That is slower and it is the point.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Runtime } from "../runtime.js";
import type { QueueStatus } from "../adapters/types.js";

const PatchInput = z.object({
  status: z.enum(["new", "claimed", "resolved", "dismissed"]),
  by: z.string().max(200).optional(),
});

export function queueRoute(rt: Runtime) {
  const app = new Hono();

  app.get("/", async (c) => {
    const status = c.req.query("status") as QueueStatus | undefined;
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
    const [items, stats] = await Promise.all([
      rt.store.listEscalations({ status, limit }),
      rt.store.queueStats(),
    ]);
    return c.json({ items, stats, store: rt.store.name });
  });

  app.patch("/:id", async (c) => {
    const parsed = PatchInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", detail: parsed.error.issues }, 400);
    }
    const ok = await rt.store.setStatus(c.req.param("id"), parsed.data.status, parsed.data.by);
    return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });

  return app;
}

export function decisionsRoute(rt: Runtime) {
  const app = new Hono();

  app.get("/:id", async (c) => {
    const record = await rt.store.getEscalation(c.req.param("id"));
    if (!record) return c.json({ error: "not_found" }, 404);
    return c.json(record);
  });

  return app;
}
