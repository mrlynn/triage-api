/**
 * The ingest path, end to end, with the model call stubbed.
 *
 * WHY STUB RATHER THAN SKIP: the properties this file asserts — redaction
 * happens first, storage is a consequence of escalation, sink failure cannot
 * lose a decision, duplicate webhooks are dropped — are properties of OUR code,
 * not of the model. Making them depend on an API key means they do not run on a
 * fork, in CI without secrets, or on the laptop of the person evaluating this
 * repo. They run everywhere instead.
 *
 * There is a real end-to-end check that does spend money: `npm run smoke`.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { anthropic } from "../src/anthropic.js";
import { buildRuntime } from "../src/runtime.js";
import { runPipeline } from "../src/pipeline.js";
import type { TriageResult } from "../src/schemas.js";
import type { TicketSink } from "../src/adapters/types.js";

const TRIAGE: TriageResult = {
  category: "billing", urgency: "high", sentiment: "frustrated",
  summary: "Charged twice for a renewal.",
  entities: { order_ids: [], product_names: [], requested_remedy: "refund" },
  requires_human: true, escalation_reason: "Duplicate charge over the auto-resolve threshold.",
  confidence: 0.91,
};

function stubModel(triage: Partial<TriageResult> = {}) {
  return mock.method(anthropic.messages, "parse", async () => ({
    model: "claude-opus-5",
    stop_reason: "end_turn",
    parsed_output: { ...TRIAGE, ...triage },
    usage: { input_tokens: 40, output_tokens: 120, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 },
  }) as never);
}

async function runtime() {
  process.env.ANTHROPIC_API_KEY ??= "test-key-not-used";
  return buildRuntime();
}

test("an escalated ticket is stored, redacted, and never in raw form", async (t) => {
  const m = stubModel();
  t.after(() => m.mock.restore());
  const rt = await runtime();

  const out = await runPipeline(rt, {
    message: "You charged my card 4111 1111 1111 1111 twice. Fix it.",
    channel: "email",
  });

  assert.equal(out.stored, true);
  const stored = await rt.store.getEscalation(out.decision.id);
  assert.ok(stored);
  assert.equal(stored.message_redacted.includes("4111 1111 1111 1111"), false,
    "the raw card number must not reach the store");
  assert.ok(stored.message_redacted.includes("[card ending 1111]"));
  assert.equal(stored.redactions.length, 1);
  // And the model never saw it either: redaction runs before the call.
  const sentMessage = (m.mock.calls[0]?.arguments[0] as { messages: { content: string }[] }).messages[0]!.content;
  assert.equal(sentMessage.includes("4111 1111 1111 1111"), false);
  await rt.store.close();
});

test("a confidently handled ticket is NOT stored", async (t) => {
  const m = stubModel({ requires_human: false, escalation_reason: null, confidence: 0.95 });
  t.after(() => m.mock.restore());
  const rt = await runtime();

  const out = await runPipeline(rt, { message: "What are your delivery times?", channel: "email" });
  assert.equal(out.stored, false);
  assert.equal((await rt.store.queueStats()).depth, 0,
    "storage is a consequence of escalation, not of submission");
  // Usage is still counted — a rollup carries no privacy cost.
  const usage = await rt.store.usageFor(new Date().toISOString().slice(0, 10));
  assert.equal(usage.requests, 1);
  await rt.store.close();
});

test("the confidence floor overrides the model's own requires_human", async (t) => {
  const m = stubModel({ requires_human: false, escalation_reason: null, confidence: 0.42 });
  t.after(() => m.mock.restore());
  const rt = await runtime();

  const out = await runPipeline(rt, { message: "Not sure what happened with my thing.", channel: "email" });
  assert.equal(out.forced_human, true);
  assert.equal(out.decision.triage.requires_human, true);
  assert.match(out.decision.triage.escalation_reason ?? "", /below the 0.7 floor/);
  assert.equal(out.stored, true);
  await rt.store.close();
});

test("a sink that fails cannot cost us a decision we already paid for", async (t) => {
  const m = stubModel();
  t.after(() => m.mock.restore());
  const rt = await runtime();

  const exploding: TicketSink = {
    name: "exploding",
    capabilities: { comment: false, tag: false, setField: false, assign: false },
    async publish() { throw new Error("their API is down"); },
  };
  rt.sinks.push(exploding);

  const out = await runPipeline(rt, { message: "Charged twice.", channel: "email" });
  assert.equal(out.stored, true, "the decision is stored regardless of the sink");
  assert.equal(out.published[0]?.result.ok, false);
  assert.match(out.published[0]?.result.error ?? "", /their API is down/);
  await rt.store.close();
});

test("the ingest route drops a duplicate webhook without a second model call", async (t) => {
  const m = stubModel();
  t.after(() => m.mock.restore());
  process.env.DUP_TEST_SECRET = "s3cret";

  const { createApp } = await import("../src/server.js");
  const { app, rt } = await createApp();
  // Register a source on the runtime the app closes over.
  const { genericWebhookSource } = await import("../src/adapters/sources/generic-webhook.js");
  rt.sources.set("dup", genericWebhookSource("DUP_TEST_SECRET"));

  const body = JSON.stringify({ message: "Charged twice.", external_id: "dup-1" });
  const send = () => app.request("/v1/ingest/dup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-triage-signature": createHmac("sha256", "s3cret").update(body).digest("hex"),
    },
    body,
  });

  const first = await send();
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { results: { status: string }[] }).results[0]?.status, "escalated");

  const second = await send();
  assert.equal(second.status, 200);
  assert.equal((await second.json() as { results: { status: string }[] }).results[0]?.status, "duplicate",
    "webhooks retry; a second delivery must not pay for a second triage");

  assert.equal(m.mock.callCount(), 1, "exactly one model call for two deliveries");
  assert.equal((await rt.store.queueStats()).depth, 1, "and exactly one ticket in the queue");
  await rt.store.close();
});

test("the ingest route refuses an unsigned request and an unknown source", async (t) => {
  const m = stubModel();
  t.after(() => m.mock.restore());
  process.env.DUP_TEST_SECRET = "s3cret";

  const { createApp } = await import("../src/server.js");
  const { app, rt } = await createApp();
  const { genericWebhookSource } = await import("../src/adapters/sources/generic-webhook.js");
  rt.sources.set("dup", genericWebhookSource("DUP_TEST_SECRET"));

  const body = JSON.stringify({ message: "hi", external_id: "x1" });

  const unsigned = await app.request("/v1/ingest/dup", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  assert.equal(unsigned.status, 401);

  // 404, not a list of configured sources: an unauthenticated caller does not
  // need to learn your integration inventory.
  const unknown = await app.request("/v1/ingest/nope", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  assert.equal(unknown.status, 404);

  assert.equal(m.mock.callCount(), 0, "neither request reached the model");
  await rt.store.close();
});

test("an event the adapter ignores returns 202, so the sender does not retry", async (t) => {
  const m = stubModel();
  t.after(() => m.mock.restore());
  process.env.GH_TEST_SECRET = "s3cret";

  const { createApp } = await import("../src/server.js");
  const { app, rt } = await createApp();
  const { githubIssuesSource } = await import("../src/adapters/sources/github-issues.js");
  rt.sources.set("gh", githubIssuesSource("GH_TEST_SECRET"));

  const body = JSON.stringify({ action: "labeled", issue: { number: 1, title: "t", body: "b", html_url: "u" } });
  const res = await app.request("/v1/ingest/gh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex"),
    },
    body,
  });

  assert.equal(res.status, 202);
  assert.equal(m.mock.callCount(), 0);
  await rt.store.close();
});
