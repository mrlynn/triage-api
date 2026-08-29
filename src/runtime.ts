/**
 * The runtime: config in, live service out.
 *
 * One place resolves `triage.config.ts` into the objects the routes use. That
 * matters for a reason beyond tidiness — the routes never see a config union,
 * never branch on `store.kind`, and never ask "do we have customer lookup
 * here?". They get an object that already knows. Every "which adapter is this"
 * decision happens once, at boot, where a wrong answer crashes immediately
 * instead of at 3am under load.
 *
 * BOOT ORDER IS LOAD-BEARING: pack first (it validates), then data (it decides
 * which tools exist), then tools, then guardrails (they close over the pack),
 * then store, then adapters. Each step can fail with a sentence that says what
 * to fix.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigSchema, type TriageConfig } from "./define-config.js";
import { loadPack } from "./pack-loader.js";
import type { Pack } from "./pack.js";
import { MODEL_TIERS, specFor } from "./config.js";
import { buildRouter, type Router } from "./lib/route-model.js";
import { buildCitationVerifier, type CitationVerifier } from "./lib/citations.js";
import { compileRedactions, type ExtraRedaction } from "./lib/untrusted.js";
import { buildToolDefs, type ToolDef } from "./tools/definitions.js";
import type { ControlAvailability } from "./lib/authority.js";
import type { DataProvider } from "./adapters/data.js";
import type { Store, TicketSink, TicketSource } from "./adapters/types.js";

import { fixturesProvider } from "./adapters/data/fixtures.js";
import { httpProvider } from "./adapters/data/http.js";
import { memoryStore } from "./adapters/stores/memory.js";
import { mongoStore } from "./adapters/stores/mongodb.js";
import { genericWebhookSource } from "./adapters/sources/generic-webhook.js";
import { githubIssuesSource } from "./adapters/sources/github-issues.js";
import { zendeskSource } from "./adapters/sources/zendesk.js";
import { chatwootSource } from "./adapters/sources/chatwoot.js";
import { zammadSource } from "./adapters/sources/zammad.js";
import { fixturesSource } from "./adapters/sources/fixtures.js";
import { noopSink } from "./adapters/sinks/noop.js";
import { genericWebhookSink } from "./adapters/sinks/generic-webhook.js";
import { githubIssuesSink } from "./adapters/sinks/github-issues.js";
import { zendeskSink } from "./adapters/sinks/zendesk.js";
import { chatwootSink } from "./adapters/sinks/chatwoot.js";
import { zammadSink } from "./adapters/sinks/zammad.js";

export interface Runtime {
  config: TriageConfig;
  pack: Pack;
  data: DataProvider;
  toolDefs: ToolDef[];
  store: Store;
  sources: Map<string, TicketSource>;
  sinks: TicketSink[];
  router: Router;
  verifyCitations: CitationVerifier;
  redactions: ExtraRedaction[];
  /** What guardrails this deployment can actually enforce. See authority.ts. */
  availability: ControlAvailability;
  /** Resolves the model for a message, honouring config.models. */
  modelFor(message: string): { model: string; reason: string };
}

function buildData(cfg: TriageConfig, pack: Pack): DataProvider {
  switch (cfg.data.kind) {
    case "fixtures": return fixturesProvider(pack);
    case "none": return { name: "none" };
    case "http": return httpProvider({
      orderUrl: cfg.data.orderUrl,
      customerUrl: cfg.data.customerUrl,
      headers: cfg.data.headers,
      timeoutMs: cfg.data.timeoutMs,
    });
  }
}

function buildStore(cfg: TriageConfig): Store {
  switch (cfg.store.kind) {
    case "memory": return memoryStore();
    case "mongodb": return mongoStore({
      uri: cfg.store.uri, db: cfg.store.db, retentionDays: cfg.store.retentionDays,
    });
  }
}

function buildSources(cfg: TriageConfig): Map<string, TicketSource> {
  const map = new Map<string, TicketSource>();
  for (const [key, s] of Object.entries(cfg.sources)) {
    switch (s.kind) {
      case "generic-webhook": map.set(key, genericWebhookSource(s.secretEnv)); break;
      case "github-issues":   map.set(key, githubIssuesSource(s.secretEnv)); break;
      case "zendesk":         map.set(key, zendeskSource(s.secretEnv)); break;
      case "chatwoot":        map.set(key, chatwootSource(s)); break;
      case "zammad":          map.set(key, zammadSource(s)); break;
      case "fixtures":        map.set(key, fixturesSource()); break;
    }
  }
  return map;
}

function buildSinks(cfg: TriageConfig): TicketSink[] {
  return cfg.sinks.map((s) => {
    switch (s.kind) {
      case "noop": return noopSink();
      case "generic-webhook": return genericWebhookSink(s.urlEnv, s.secretEnv);
      case "github-issues": return githubIssuesSink(s);
      case "zendesk": return zendeskSink(s);
      case "chatwoot": return chatwootSink(s);
      case "zammad": return zammadSink(s);
    }
  });
}

export async function loadConfig(path = "triage.config.ts"): Promise<TriageConfig> {
  const abs = resolve(process.cwd(), path);
  const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
  const parsed = ConfigSchema.safeParse(mod.default ?? {});
  if (!parsed.success) {
    throw new Error(
      `Invalid ${path}:\n  ` +
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n  "),
    );
  }
  return parsed.data;
}

export async function buildRuntime(configPath?: string): Promise<Runtime> {
  const config = await loadConfig(configPath);
  const pack = await loadPack(config.pack);
  const data = buildData(config, pack);
  const toolDefs = buildToolDefs(pack, data);
  const store = buildStore(config);
  await store.init();

  const availability: ControlAvailability = { customerLookup: Boolean(data.lookupCustomer) };

  if (!availability.customerLookup) {
    console.warn(
      `[runtime] DataProvider "${data.name}" does not implement lookupCustomer. The rolling ` +
        `refund-ceiling control CANNOT RUN. Refund recommendations will be escalated with ` +
        `violation code "control_unavailable:rolling_ceiling" rather than approved. This is ` +
        `deliberate — see src/lib/authority.ts — and the fix is to implement the lookup, not to ` +
        `suppress the warning.`,
    );
  }

  // Validate the configured model at boot. `specFor` throws on an unknown id,
  // which is the whole point: a typo'd model becomes a startup crash rather
  // than a 400 on the first real ticket.
  const fixed = config.models.model
    ?? (config.models.tier === "auto" ? null : MODEL_TIERS[config.models.tier]);
  if (fixed) specFor(fixed);

  const router = buildRouter(pack);

  return {
    config, pack, data, toolDefs, store, availability, router,
    sources: buildSources(config),
    sinks: buildSinks(config),
    verifyCitations: buildCitationVerifier(pack),
    redactions: compileRedactions(pack.redaction),

    modelFor(message: string) {
      if (config.models.model) return { model: config.models.model, reason: "pinned in triage.config.ts" };
      if (config.models.tier === "auto") return router.pickModel(message);
      return { model: MODEL_TIERS[config.models.tier], reason: `fixed tier "${config.models.tier}"` };
    },
  };
}

export type { Pack };
