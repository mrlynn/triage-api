/**
 * The service configuration contract.
 *
 * TEACHING NOTE — one file, four seams.
 * A reference implementation earns its name by being honest about where the
 * generic part stops and your company starts. There are exactly four such
 * places in this codebase, and they are all wired here:
 *
 *   pack     WHAT your policy is        (packs/*)
 *   sources  HOW tickets arrive         (src/adapters/sources/*)
 *   sinks    WHERE decisions go         (src/adapters/sinks/*)
 *   store    WHAT is remembered         (src/adapters/stores/*)
 *   data     WHAT the model can look up (src/adapters/data/*)
 *
 * Defaults are chosen so a fresh clone runs with an API key and nothing else:
 * memory store, fixtures data, noop sink. That is not laziness — a reference
 * repo that needs a database and a Zendesk account before it prints anything
 * gets evaluated by nobody.
 *
 * ADVISORY BY DEFAULT. `sinks` is empty out of the box, so this service writes
 * nothing back to your ticket system until you say so. Nobody puts an unvetted
 * classifier in the write path of their helpdesk on day one, and the course's
 * own stance is human-in-the-loop anyway.
 */
import { z } from "zod";

export const ConfigSchema = z.object({
  /** Pack directory name under `packs/`, or a path. */
  pack: z.string().default("northwind"),

  /**
   * Model selection. `tier: "auto"` enables the keyword/length router in
   * `lib/route-model.ts` (Lab 7). A fixed tier or an explicit id disables it.
   */
  models: z.object({
    tier: z.enum(["auto", "flagship", "balanced", "fast"]).default("flagship"),
    /** Overrides everything above. Must exist in MODEL_CATALOG. */
    model: z.string().optional(),
  }).prefault({}),

  store: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("memory") }),
    z.object({
      kind: z.literal("mongodb"),
      uri: z.string().optional(),   // defaults to MONGODB_URI
      db: z.string().optional(),    // defaults to MONGODB_DB
      /** Days before an escalation is deleted by a TTL index. */
      retentionDays: z.number().int().positive().default(30),
    }),
  ]).default({ kind: "memory" }),

  /**
   * Backs `lookup_order` / `lookup_customer`. A provider that cannot do one of
   * these means that tool is NEVER OFFERED to the model — withholding a tool is
   * a stronger guarantee than instructing the model not to use it — and the
   * control that depends on it degrades loudly rather than silently passing.
   */
  data: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("fixtures") }),
    z.object({ kind: z.literal("none") }),
    z.object({
      kind: z.literal("http"),
      orderUrl: z.string().url().optional(),    // {id} is substituted
      customerUrl: z.string().url().optional(), // {email} is substituted
      headers: z.record(z.string(), z.string()).default({}),
      timeoutMs: z.number().int().positive().default(4_000),
    }),
  ]).default({ kind: "fixtures" }),

  /** Keyed by the path segment in POST /v1/ingest/:source. */
  sources: z.record(z.string(), z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("generic-webhook"),
      secretEnv: z.string().default("GENERIC_WEBHOOK_SECRET"),
    }),
    z.object({
      kind: z.literal("github-issues"),
      secretEnv: z.string().default("GITHUB_WEBHOOK_SECRET"),
    }),
    z.object({
      kind: z.literal("zendesk"),
      secretEnv: z.string().default("ZENDESK_WEBHOOK_SECRET"),
    }),
    z.object({
      kind: z.literal("fixtures"),
      /** Dev only. Refuses to register when NODE_ENV=production. */
      file: z.string().optional(),
    }),
  ])).default({}),

  /**
   * Sinks run in order after a decision is made. An empty list is
   * advisory-only: the decision is stored and served, and nothing is written
   * back. This is the default and it is the recommended way to start.
   */
  sinks: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("noop") }),
    z.object({
      kind: z.literal("generic-webhook"),
      urlEnv: z.string().default("OUTBOUND_WEBHOOK_URL"),
      secretEnv: z.string().default("OUTBOUND_WEBHOOK_SECRET"),
    }),
    z.object({
      kind: z.literal("github-issues"),
      tokenEnv: z.string().default("GITHUB_TOKEN"),
      repoEnv: z.string().default("GITHUB_REPO"),
      labelPrefix: z.string().default("triage/"),
      comment: z.boolean().default(true),
    }),
    z.object({
      kind: z.literal("zendesk"),
      subdomainEnv: z.string().default("ZENDESK_SUBDOMAIN"),
      emailEnv: z.string().default("ZENDESK_EMAIL"),
      tokenEnv: z.string().default("ZENDESK_API_TOKEN"),
      /**
       * A PUBLIC comment is visible to the customer. Leave this false. Turning
       * it on means a model's prose reaches a human being with no review, which
       * is a different product with a different risk profile and it is not what
       * this repo is for.
       */
      publicComment: z.boolean().default(false),
      tag: z.boolean().default(true),
      customFieldId: z.number().int().optional(),
    }),
  ])).default([]),

  /** Per-IP windows. Fails CLOSED when the store is unreachable. */
  rateLimit: z.object({
    triage: z.number().int().positive().default(20),
    resolve: z.number().int().positive().default(10),
    ingest: z.number().int().positive().default(120),
    windowMs: z.number().int().positive().default(600_000),
  }).prefault({}),

  /** Bind address for the HTTP server. */
  port: z.number().int().positive().default(8787),
});

export type TriageConfig = z.infer<typeof ConfigSchema>;
export type TriageConfigInput = z.input<typeof ConfigSchema>;

/** Identity function that buys you autocomplete and a compile-time check. */
export function defineConfig(cfg: TriageConfigInput): TriageConfigInput {
  return cfg;
}
