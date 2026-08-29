/**
 * Shared eval plumbing: build the app once, load the active pack's cases.
 *
 * Every eval in this directory drives the service IN-PROCESS via
 * `app.request(...)`. No port, no server, no flake, and — the part that
 * matters — the eval exercises the same route the webhook does, guardrails
 * included. An eval that calls the model directly measures the model. An eval
 * that calls your route measures your system, which is the thing that can
 * regress.
 */
import "../../src/lib/env.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../src/server.js";
import type { Runtime } from "../../src/runtime.js";
import type { Hono } from "hono";

export interface EvalCase {
  id: string;
  message: string;
  expected: { category: string; urgency: string; requires_human: boolean; requested_remedy: string };
  /**
   * Which rule this case tests. Printed under a failure so the next person can
   * tell a real regression from a disagreement about labels — the course's
   * first run of its own dataset scored 58%, and five of six failures were
   * LABEL errors, not model errors.
   */
  notes: string;
}

export interface InjectionCase {
  id: string;
  family: string;
  message: string;
  must_not?: { urgency?: string[]; requested_remedy?: string[]; requires_human?: boolean[] };
  expect_escalation?: boolean;
  forbid_citation?: string;
  expect_redaction?: boolean;
  /** A legitimate customer. Blocking or mangling this is a FAILURE. */
  benign?: boolean;
  notes: string;
}

let cached: { app: Hono; rt: Runtime } | null = null;

export async function harness(): Promise<{ app: Hono; rt: Runtime }> {
  cached ??= await createApp();
  return cached;
}

function jsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

export function loadCases(rt: Runtime): EvalCase[] {
  const path = join(rt.pack.dir, "evals", "dataset.jsonl");
  const cases = jsonl<EvalCase>(path);
  if (cases.length === 0) {
    throw new Error(
      `No eval cases at ${path}.\n\n` +
        `This is the step people skip, and it is the one that decides whether any of the rest\n` +
        `works. Hand-label 10-15 real tickets from your own queue and put them there. Without\n` +
        `them you have a system that produces confident output and no way to know if it is\n` +
        `right — which is worse than no system, because someone will trust it.`,
    );
  }
  return cases;
}

export function loadInjections(rt: Runtime): InjectionCase[] {
  return jsonl<InjectionCase>(join(rt.pack.dir, "evals", "injections.jsonl"));
}

export function baselinePath(rt: Runtime): string {
  return join(rt.pack.dir, "evals", "baseline.json");
}
