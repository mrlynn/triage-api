/**
 * The service.
 *
 * `app` is exported WITHOUT binding a port, so tests and the eval harness can
 * call `app.request(...)` in-process — no server, no port, no flake. The
 * bottom-of-file guard is what makes `npm run dev` also work.
 */
import "./lib/env.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { buildRuntime, type Runtime } from "./runtime.js";
import { triageRoute } from "./routes/triage.js";
import { resolveRoute } from "./routes/resolve.js";
import { draftRoute } from "./routes/draft.js";
import { estimateRoute } from "./routes/estimate.js";
import { limitsRoute } from "./routes/limits.js";
import { ingestRoute } from "./routes/ingest.js";
import { queueRoute, decisionsRoute } from "./routes/queue.js";
import { healthRoute } from "./routes/health.js";
import { uiRoutes } from "./ui/index.js";

/**
 * Bearer auth for /v1/*.
 *
 * UNSET MEANS OPEN, and that is a deliberate exception to this repo's
 * fail-closed rule, made once and stated loudly at boot. The alternative —
 * requiring a token before the quickstart prints anything — costs more
 * adoption than it buys safety on a laptop. /v1/ingest is exempt because it
 * has its own, stronger per-source signature verification: a webhook sender
 * cannot present a bearer token you invented.
 */
function bearerAuth() {
  const tokens = (process.env.API_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) {
    console.warn(
      "[auth] API_TOKENS is not set — /v1/* is OPEN. Fine on a laptop. Before you expose this " +
        "service to anything, set API_TOKENS to one or more secrets and send them as " +
        "`Authorization: Bearer <token>`.",
    );
  }
  const allow = new Set(tokens);

  return async (c: { req: { path: string; header: (n: string) => string | undefined }; json: (b: unknown, s?: number) => Response }, next: () => Promise<void>) => {
    if (allow.size === 0) return next();
    if (c.req.path.startsWith("/v1/ingest")) return next();
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!allow.has(token)) return c.json({ error: "unauthorized" }, 401);
    return next();
  };
}

export async function createApp(configPath?: string): Promise<{ app: Hono; rt: Runtime }> {
  const rt = await buildRuntime(configPath);
  const app = new Hono();

  app.use("/v1/*", bearerAuth() as never);

  app.route("/", healthRoute(rt));
  app.route("/v1/triage", triageRoute(rt));
  app.route("/v1/resolve", resolveRoute(rt));
  app.route("/v1/draft", draftRoute(rt));
  app.route("/v1/estimate", estimateRoute(rt));
  app.route("/v1/limits", limitsRoute);
  app.route("/v1/ingest", ingestRoute(rt));
  app.route("/v1/queue", queueRoute(rt));
  app.route("/v1/decisions", decisionsRoute(rt));
  app.route("/", uiRoutes(rt));

  return { app, rt };
}

// Only bind a port when run directly, never on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, rt } = await createApp();
  const port = rt.config.port;
  serve({ fetch: app.fetch, port }, () => {
    console.log(`\n  triage-api  →  http://localhost:${port}`);
    console.log(`  pack        →  ${rt.pack.id} (${rt.pack.companyName})`);
    console.log(`  store       →  ${rt.store.name}`);
    console.log(`  tools       →  ${rt.toolDefs.map((d) => d.name).join(", ")}`);
    console.log(`  sinks       →  ${rt.sinks.length === 0 ? "none (advisory mode)" : rt.sinks.map((s) => s.name).join(", ")}`);
    console.log(`\n  queue       →  http://localhost:${port}/queue`);
    console.log(`  readiness   →  http://localhost:${port}/readyz\n`);
  });

  const shutdown = async () => { await rt.store.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
