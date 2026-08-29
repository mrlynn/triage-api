/**
 * GET /healthz and GET /readyz.
 *
 * `/healthz` says the process is alive. `/readyz` says whether it can actually
 * do its job, and — the part that is unusual and the part that matters — WHICH
 * GUARDRAILS ARE LIVE.
 *
 * A deployment can be perfectly healthy and be running with the rolling refund
 * ceiling disabled because nobody implemented `lookupCustomer`. That fact
 * should be one HTTP call away and visible on a dashboard, not buried in a
 * startup log that scrolled past three weeks ago. If you take one idea from
 * this file, take that one: report what your controls CAN do, not just whether
 * your process is up.
 */
import { Hono } from "hono";
import type { Runtime } from "../runtime.js";

export function healthRoute(rt: Runtime) {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/readyz", async (c) => {
    const store = await rt.store.health();
    const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

    const controls = {
      trust_boundary: true,          // always on; not configurable
      redaction: true,               // always on
      authority_recompute: true,     // always on
      citation_verification: true,   // always on
      single_refund_ceiling: true,
      rolling_refund_ceiling: rt.availability.customerLookup,
      confidence_floor: rt.router.escalateBelow,
    };

    const degraded = Object.entries(controls)
      .filter(([, v]) => v === false)
      .map(([k]) => k);

    const ok = store.ok && hasKey;
    return c.json({
      ok,
      pack: { id: rt.pack.id, company: rt.pack.companyName },
      store: { name: rt.store.name, ...store },
      credentials: hasKey ? "present" : "MISSING — set ANTHROPIC_API_KEY",
      model: rt.config.models.model ?? `tier:${rt.config.models.tier}`,
      tools_offered: rt.toolDefs.map((d) => d.name),
      sources: [...rt.sources.keys()],
      sinks: rt.sinks.length === 0 ? ["(advisory mode — nothing is written back)"] : rt.sinks.map((s) => s.name),
      controls,
      degraded_controls: degraded,
    }, ok ? 200 : 503);
  });

  return app;
}
