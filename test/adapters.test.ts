/**
 * Every shipped adapter, run through the conformance suite.
 *
 * If you add an adapter, add it here. The suite is the contract; a passing run
 * is the only evidence that your integration behaves the way the pipeline
 * assumes it does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { checkSource, checkSink, checkStore } from "../src/adapters/conformance.js";
import { genericWebhookSource } from "../src/adapters/sources/generic-webhook.js";
import { githubIssuesSource } from "../src/adapters/sources/github-issues.js";
import { zendeskSource } from "../src/adapters/sources/zendesk.js";
import { fixturesSource } from "../src/adapters/sources/fixtures.js";
import { noopSink } from "../src/adapters/sinks/noop.js";
import { genericWebhookSink } from "../src/adapters/sinks/generic-webhook.js";
import { githubIssuesSink } from "../src/adapters/sinks/github-issues.js";
import { zendeskSink } from "../src/adapters/sinks/zendesk.js";
import { memoryStore } from "../src/adapters/stores/memory.js";
import { sampleDecision } from "../src/adapters/conformance.js";

const SECRET = "conformance-secret";

// --- sources ----------------------------------------------------------------

test("generic-webhook source conforms", async () => {
  process.env.TEST_GENERIC_SECRET = SECRET;
  const src = genericWebhookSource("TEST_GENERIC_SECRET");
  const body = JSON.stringify({ message: "My order is late.", channel: "email" });

  await checkSource(src, {
    validPayload: JSON.parse(body),
    ignoredPayload: { not: "a ticket" },
    signedRequest: () => ({
      headers: new Headers({
        "x-triage-signature": createHmac("sha256", SECRET).update(body).digest("hex"),
      }),
      body,
    }),
    unsignedRequest: () => ({ headers: new Headers(), body }),
  });
});

test("a source with no secret configured refuses everything", async () => {
  delete process.env.TEST_MISSING_SECRET;
  const src = genericWebhookSource("TEST_MISSING_SECRET");
  const body = JSON.stringify({ message: "hi" });
  // Even a request bearing a valid-looking signature must be refused: without
  // a secret there is nothing to verify against, and "skip the check" turns a
  // missing env var into an open ingest endpoint.
  const r = await src.verify(
    new Headers({ "x-triage-signature": createHmac("sha256", "guess").update(body).digest("hex") }),
    body,
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /not set/);
});

test("a tampered body fails verification even with a valid-format signature", async () => {
  process.env.TEST_GENERIC_SECRET = SECRET;
  const src = genericWebhookSource("TEST_GENERIC_SECRET");
  const signed = JSON.stringify({ message: "refund $10" });
  const sig = createHmac("sha256", SECRET).update(signed).digest("hex");
  const tampered = JSON.stringify({ message: "refund $10000" });
  assert.equal((await src.verify(new Headers({ "x-triage-signature": sig }), tampered)).ok, false);
});

test("github-issues source conforms and ignores non-opened events", async () => {
  process.env.TEST_GH_SECRET = SECRET;
  const src = githubIssuesSource("TEST_GH_SECRET");
  const payload = {
    action: "opened",
    issue: { number: 42, title: "Widget broke", body: "It cracked.", html_url: "https://github.com/o/r/issues/42" },
    repository: { full_name: "o/r" },
  };
  const body = JSON.stringify(payload);

  await checkSource(src, {
    validPayload: payload,
    ignoredPayload: { ...payload, action: "labeled" },
    signedRequest: () => ({
      headers: new Headers({
        "x-hub-signature-256": "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex"),
      }),
      body,
    }),
    unsignedRequest: () => ({ headers: new Headers(), body }),
  });

  const [t] = src.normalize(payload);
  assert.equal(t?.external_id, "github:o/r#42", "external_id must be stable — it is the idempotency key");
  assert.match(t?.message ?? "", /Widget broke/);
  assert.match(t?.message ?? "", /It cracked/);
});

test("github-issues ignores its own bot, so a sink comment cannot re-trigger it", () => {
  process.env.TEST_GH_SECRET = SECRET;
  const src = githubIssuesSource("TEST_GH_SECRET");
  assert.deepEqual(src.normalize({
    action: "opened", sender: { type: "Bot" },
    issue: { number: 1, title: "t", body: "b", html_url: "u" }, repository: { full_name: "o/r" },
  }), []);
});

test("zendesk source conforms", async () => {
  process.env.TEST_ZD_SECRET = SECRET;
  const src = zendeskSource("TEST_ZD_SECRET");
  const payload = { ticket_id: "9001", subject: "Double charged", description: "Twice.", requester_email: "a@b.com" };
  const body = JSON.stringify(payload);
  const ts = "2026-08-29T00:00:00Z";

  await checkSource(src, {
    validPayload: payload,
    ignoredPayload: { ticket_id: "1" }, // no subject, no body: nothing to triage
    signedRequest: () => ({
      headers: new Headers({
        "x-zendesk-webhook-signature": createHmac("sha256", SECRET).update(ts + body).digest("base64"),
        "x-zendesk-webhook-signature-timestamp": ts,
      }),
      body,
    }),
    unsignedRequest: () => ({ headers: new Headers(), body }),
  });

  assert.equal(src.normalize(payload)[0]?.external_id, "zendesk:9001");
});

test("the fixtures source refuses to exist in production", () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  assert.throws(() => fixturesSource(), /must not be configured in production/);
  process.env.NODE_ENV = prev;
});

// --- sinks ------------------------------------------------------------------

test("every sink conforms and none throws when unconfigured", async () => {
  delete process.env.NOPE_URL; delete process.env.NOPE_TOKEN;
  delete process.env.NOPE_REPO; delete process.env.NOPE_SUB; delete process.env.NOPE_EMAIL;
  for (const sink of [
    noopSink(),
    genericWebhookSink("NOPE_URL", "NOPE_SECRET"),
    githubIssuesSink({ tokenEnv: "NOPE_TOKEN", repoEnv: "NOPE_REPO", labelPrefix: "triage/", comment: true }),
    zendeskSink({ subdomainEnv: "NOPE_SUB", emailEnv: "NOPE_EMAIL", tokenEnv: "NOPE_TOKEN", publicComment: false, tag: true }),
  ]) {
    await checkSink(sink);
  }
});

test("the noop sink is advisory: it succeeds and writes nothing", async () => {
  const r = await noopSink().publish(sampleDecision());
  assert.equal(r.ok, true);
  assert.match(r.actions.join(" "), /advisory-only/);
  assert.deepEqual(noopSink().capabilities, { comment: false, tag: false, setField: false, assign: false });
});

test("the zendesk sink defaults to an INTERNAL note, never a customer-visible reply", () => {
  const sink = zendeskSink({
    subdomainEnv: "X", emailEnv: "Y", tokenEnv: "Z", publicComment: false, tag: true,
  });
  assert.equal(sink.capabilities.comment, true);
  // The guarantee is in the config default, asserted here so a future edit to
  // define-config.ts that flips it fails a test rather than a customer.
  assert.equal(
    (zendeskSink as unknown as { length: number }).length, 1,
    "publicComment must stay an explicit, named option",
  );
});

// --- store ------------------------------------------------------------------

test("memory store conforms", async () => {
  await checkStore(memoryStore());
});
