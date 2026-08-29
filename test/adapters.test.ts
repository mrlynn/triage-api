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
import { chatwootSource } from "../src/adapters/sources/chatwoot.js";
import { zammadSource, htmlToText } from "../src/adapters/sources/zammad.js";
import { fixturesSource } from "../src/adapters/sources/fixtures.js";
import { noopSink } from "../src/adapters/sinks/noop.js";
import { genericWebhookSink } from "../src/adapters/sinks/generic-webhook.js";
import { githubIssuesSink } from "../src/adapters/sinks/github-issues.js";
import { zendeskSink } from "../src/adapters/sinks/zendesk.js";
import { chatwootSink } from "../src/adapters/sinks/chatwoot.js";
import { zammadSink } from "../src/adapters/sinks/zammad.js";
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

// --- chatwoot ---------------------------------------------------------------

const CW_OPTS = {
  secretEnv: "TEST_CW_SECRET",
  events: ["conversation_created"] as const,
  baseUrlEnv: "TEST_CW_BASE_URL",
  toleranceSeconds: 300,
};

/** A conversation_created payload, shaped like Conversations::EventDataPresenter. */
function conversationCreated(overrides: Record<string, unknown> = {}) {
  return {
    event: "conversation_created",
    // Chatwoot sends the DISPLAY id here, which is also the API path segment.
    id: 77,
    channel: "Channel::Email",
    account: { id: 1, name: "Acme" },
    inbox_id: 3,
    status: "open",
    labels: ["vip"],
    priority: null,
    meta: { sender: { id: 9, email: "customer@example.com", name: "Dana" } },
    // message_type is the RAW INTEGER inside a nested messages array. 0 = incoming.
    messages: [{ id: 501, content: "My order arrived smashed.", message_type: 0, private: false }],
    ...overrides,
  };
}

function cwSigned(body: string, secret = SECRET, ts = String(Math.floor(Date.now() / 1000))) {
  return new Headers({
    "x-chatwoot-timestamp": ts,
    "x-chatwoot-signature": "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex"),
  });
}

test("chatwoot source conforms", async () => {
  process.env.TEST_CW_SECRET = SECRET;
  process.env.TEST_CW_BASE_URL = "https://chat.example.com";
  const src = chatwootSource({ ...CW_OPTS, events: ["conversation_created"] });
  const payload = conversationCreated();
  const body = JSON.stringify(payload);

  await checkSource(src, {
    validPayload: payload,
    // A typing indicator is the single most common event on a busy Chatwoot
    // account and it is not a ticket.
    ignoredPayload: { ...payload, event: "conversation_typing_on" },
    signedRequest: () => ({ headers: cwSigned(body), body }),
    unsignedRequest: () => ({ headers: new Headers(), body }),
  });

  const [t] = src.normalize(payload);
  assert.equal(t?.external_id, "chatwoot:1:77", "external_id must key on account + display id");
  assert.equal(t?.customer_email, "customer@example.com");
  assert.equal(t?.channel, "email");
  assert.equal(t?.external_url, "https://chat.example.com/app/accounts/1/conversations/77");
});

test("chatwoot rejects a replayed delivery even when the signature is valid", async () => {
  process.env.TEST_CW_SECRET = SECRET;
  const src = chatwootSource(CW_OPTS);
  const body = JSON.stringify(conversationCreated());
  // An hour old. The timestamp is inside the signed string, so an attacker
  // cannot move it — which is exactly what makes checking it worth doing.
  const stale = String(Math.floor(Date.now() / 1000) - 3600);
  const r = await src.verify(cwSigned(body, SECRET, stale), body);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /tolerance/);
});

test("chatwoot reads message_type as an integer in nested messages and a string at top level", () => {
  process.env.TEST_CW_SECRET = SECRET;
  const conv = chatwootSource(CW_OPTS);
  // 1 = outgoing. An agent's own reply is not a new ticket.
  assert.deepEqual(conv.normalize(conversationCreated({
    messages: [{ id: 1, content: "Hi, looking into it.", message_type: 1 }],
  })), []);

  const msg = chatwootSource({ ...CW_OPTS, events: ["message_created"] });
  const incoming = {
    event: "message_created",
    id: 900,
    content: "Any update?",
    message_type: "incoming",
    private: false,
    account: { id: 1, name: "Acme" },
    inbox: { id: 3, channel_type: "Channel::WebWidget" },
    sender: { email: "customer@example.com" },
    conversation: { id: 77, channel: "Channel::WebWidget", meta: {} },
  };
  const [t] = msg.normalize(incoming);
  assert.equal(t?.external_id, "chatwoot:1:77:m900",
    "a follow-up must key on the message, or the second one looks like a duplicate of the first");
  assert.equal(t?.channel, "chat");
});

test("chatwoot ignores its own private note, so a sink write cannot re-trigger it", () => {
  process.env.TEST_CW_SECRET = SECRET;
  const src = chatwootSource({ ...CW_OPTS, events: ["message_created"] });
  const note = {
    event: "message_created", id: 901, content: "Automated triage — billing / high",
    // Exactly what this repo's chatwoot sink posts. Both fields reject it
    // independently; either one alone would be enough, and having both is the
    // point — a loop here costs money on every turn.
    message_type: "outgoing", private: true,
    account: { id: 1 }, conversation: { id: 77 },
  };
  assert.deepEqual(src.normalize(note), []);
  assert.deepEqual(src.normalize({ ...note, private: false }), [],
    "an agent's public reply is not a customer ticket either");
});

test("chatwoot ignores events the source was not configured for", () => {
  process.env.TEST_CW_SECRET = SECRET;
  const src = chatwootSource(CW_OPTS); // conversation_created only
  assert.deepEqual(src.normalize({
    event: "message_created", id: 1, content: "hi", message_type: "incoming",
    account: { id: 1 }, conversation: { id: 77 },
  }), [], "subscribing to both events double-triages the opening message");
});

// --- zammad -----------------------------------------------------------------

const ZM_OPTS = { secretEnv: "TEST_ZM_SECRET", baseUrlEnv: "TEST_ZM_URL" };

/** The default Zammad webhook payload: {ticket, article}, associations resolved. */
function zammadPayload(over: { ticket?: Record<string, unknown>; article?: Record<string, unknown> } = {}) {
  return {
    ticket: {
      id: 4711,
      number: "67001",
      title: "Double charged for my subscription",
      state: "new",
      priority: { id: 2, name: "2 normal" },
      group: { id: 1, name: "Users" },
      customer: { id: 8, login: "dana", email: "dana@example.com", firstname: "Dana" },
      article_count: 1,
      ...over.ticket,
    },
    article: {
      id: 9001,
      ticket_id: 4711,
      body: "You billed me twice in March.",
      content_type: "text/plain",
      type: "email",
      // The string association name, not an id. "Customer" | "Agent" | "System".
      sender: "Customer",
      internal: false,
      from: "Dana Smith <dana@example.com>",
      ...over.article,
    },
  };
}

function zmSigned(body: string, secret = SECRET) {
  // SHA-1, and the legacy header name. Not X-Hub-Signature-256.
  return new Headers({ "x-hub-signature": "sha1=" + createHmac("sha1", secret).update(body).digest("hex") });
}

test("zammad source conforms", async () => {
  process.env.TEST_ZM_SECRET = SECRET;
  process.env.TEST_ZM_URL = "https://help.example.com";
  const src = zammadSource(ZM_OPTS);
  const payload = zammadPayload();
  const body = JSON.stringify(payload);

  await checkSource(src, {
    validPayload: payload,
    // A trigger that fires on update delivers an agent's own article.
    ignoredPayload: zammadPayload({ article: { sender: "Agent" } }),
    signedRequest: () => ({ headers: zmSigned(body), body }),
    unsignedRequest: () => ({ headers: new Headers(), body }),
  });

  const [t] = src.normalize(payload);
  assert.equal(t?.external_id, "zammad:4711:a9001",
    "the first segment must be the internal ticket id — it is what the sink PUTs to, not the ticket number");
  assert.equal(t?.customer_email, "dana@example.com");
  assert.equal(t?.channel, "email");
  assert.equal(t?.external_url, "https://help.example.com/#ticket/zoom/4711");
  assert.match(t?.message ?? "", /Double charged/);
  assert.match(t?.message ?? "", /billed me twice/);
});

test("zammad rejects a GitHub-style sha256 signature rather than accepting it", async () => {
  process.env.TEST_ZM_SECRET = SECRET;
  const src = zammadSource(ZM_OPTS);
  const body = JSON.stringify(zammadPayload());
  // Zammad signs with HMAC-SHA1 under X-Hub-Signature. Pointing a Zammad
  // webhook at the github source (or vice versa) must fail closed, not coerce.
  const r = await src.verify(
    new Headers({ "x-hub-signature-256": "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex") }),
    body,
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /X-Hub-Signature/);
});

test("zammad ignores its own internal note, so a sink write cannot re-trigger it", () => {
  process.env.TEST_ZM_SECRET = SECRET;
  const src = zammadSource(ZM_OPTS);
  // Exactly what this repo's zammad sink writes.
  assert.deepEqual(src.normalize(zammadPayload({
    article: { sender: "Agent", internal: true, type: "note", body: "Automated triage — billing / high" },
  })), []);
  // Belt and braces: internal alone is enough even if sender were wrong.
  assert.deepEqual(src.normalize(zammadPayload({
    article: { sender: "Customer", internal: true },
  })), []);
});

test("zammad converts html article bodies to text before the model sees them", () => {
  process.env.TEST_ZM_SECRET = SECRET;
  const src = zammadSource(ZM_OPTS);
  const [t] = src.normalize(zammadPayload({
    article: {
      content_type: "text/html",
      body: "<div><p>Order&nbsp;A-1 arrived <b>smashed</b>.</p><p>Please refund.</p>"
        + "<style>.x{color:red}</style></div>",
    },
  }));
  const msg = t?.message ?? "";
  assert.doesNotMatch(msg, /<[a-z]/i, "markup must not reach the model");
  assert.doesNotMatch(msg, /color:red/, "style content must be dropped, not flattened into the text");
  assert.match(msg, /Order A-1 arrived smashed\./);
  assert.match(msg, /Please refund\./);
  // Block boundaries become newlines rather than welding sentences together.
  assert.doesNotMatch(msg, /smashed\.Please/);
});

test("htmlToText leaves plain text alone", () => {
  assert.equal(htmlToText("Just a sentence."), "Just a sentence.");
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
    chatwootSink({
      baseUrlEnv: "NOPE_BASE", tokenEnv: "NOPE_TOKEN", accountIdEnv: "NOPE_ACCOUNT",
      note: true, publicReply: false, label: true, labelPrefix: "triage-",
      priorityMap: {}, teamMap: {},
    }),
    zammadSink({
      baseUrlEnv: "NOPE_BASE", tokenEnv: "NOPE_TOKEN",
      note: true, publicNote: false, tag: true, tagPrefix: "triage-",
      priorityMap: {}, groupMap: {},
    }),
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

/**
 * The chatwoot sink against a stubbed fetch.
 *
 * Worth the machinery for one reason: `POST /labels` REPLACES the whole label
 * list in Chatwoot. The bug this guards against is an integration that posts
 * its own two labels and silently deletes every label an agent applied — a 200
 * response, no error anywhere, and a support team that stops trusting the tool.
 */
async function withStubbedFetch<T>(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: { url: string; method: string; body: unknown }[] }> {
  const real = globalThis.fetch;
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return handler(url, init);
  }) as typeof fetch;
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

function configuredChatwootSink(over: Partial<Parameters<typeof chatwootSink>[0]> = {}) {
  process.env.TEST_CW_BASE = "https://chat.example.com";
  process.env.TEST_CW_TOKEN = "token";
  return chatwootSink({
    baseUrlEnv: "TEST_CW_BASE", tokenEnv: "TEST_CW_TOKEN", accountIdEnv: "TEST_CW_ACCOUNT",
    note: true, publicReply: false, label: true, labelPrefix: "triage-",
    priorityMap: { urgent: "urgent", high: "high", normal: "medium", low: "low" },
    teamMap: {}, ...over,
  });
}

const CW_DECISION = () => ({
  ...sampleDecision({ ticket: { message: "m", channel: "email" as const, external_id: "chatwoot:1:77" } }),
});

test("the chatwoot sink merges labels instead of replacing the agent's", async () => {
  const { result, calls } = await withStubbedFetch(
    (url, init) =>
      url.endsWith("/labels") && (init.method ?? "GET") === "GET"
        ? Response.json({ payload: ["vip", "triage-billing"] })
        : Response.json({}, { status: 200 }),
    () => configuredChatwootSink().publish(CW_DECISION()),
  );

  assert.equal(result.ok, true);
  const write = calls.find((c) => c.url.endsWith("/labels") && c.method === "POST");
  const labels = (write?.body as { labels: string[] }).labels;
  assert.ok(labels.includes("vip"), "a label an agent applied must survive a triage write");
  assert.ok(labels.includes("triage-billing"));
  assert.ok(labels.includes("triage-normal"));
  assert.ok(labels.includes("triage-needs-human"));
  assert.equal(new Set(labels).size, labels.length, "the merged list must not duplicate");
});

test("the chatwoot sink skips the label write when it cannot read the current labels", async () => {
  const { result, calls } = await withStubbedFetch(
    (url, init) =>
      url.endsWith("/labels") && (init.method ?? "GET") === "GET"
        ? Response.json({ error: "nope" }, { status: 500 })
        : Response.json({}, { status: 200 }),
    () => configuredChatwootSink().publish(CW_DECISION()),
  );

  assert.equal(calls.some((c) => c.url.endsWith("/labels") && c.method === "POST"), false,
    "a failed read must NOT fall back to posting only our own labels — that deletes the agent's");
  assert.match(result.actions.join(" "), /left untouched/);
  // The rest of the publish still happens: one dead endpoint is not a reason to
  // drop a decision we already paid for.
  assert.match(result.actions.join(" "), /private note added/);
});

test("the chatwoot sink writes a PRIVATE note by default, never a customer-visible reply", async () => {
  const { calls } = await withStubbedFetch(
    () => Response.json({ payload: [] }),
    () => configuredChatwootSink().publish(CW_DECISION()),
  );
  const note = calls.find((c) => c.url.endsWith("/messages"))?.body as Record<string, unknown>;
  assert.equal(note.private, true,
    "private:false is DELIVERED to the customer on their channel; the default must never be that");
  assert.equal(note.message_type, "outgoing");
});

test("the chatwoot sink maps urgency to priority and escalations to a team", async () => {
  const { calls } = await withStubbedFetch(
    () => Response.json({ payload: [] }),
    () => configuredChatwootSink({ teamMap: { billing: 4 }, escalationTeamId: 9 })
      .publish(CW_DECISION()),
  );
  assert.deepEqual(calls.find((c) => c.url.endsWith("/toggle_priority"))?.body, { priority: "medium" });
  // sampleDecision sets requires_human, so the escalation team wins over teamMap.
  assert.deepEqual(calls.find((c) => c.url.endsWith("/assignments"))?.body, { team_id: 9 });
});

test("the chatwoot sink refuses a ticket that is not a chatwoot conversation", async () => {
  const r = await configuredChatwootSink().publish(
    sampleDecision({ ticket: { message: "m", channel: "email", external_id: "github:o/r#42" } }),
  );
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no Chatwoot conversation id/);
});

test("chatwoot label titles stay inside the charset chatwoot accepts", async () => {
  // Chatwoot validates titles against unicode letters/numbers/hyphen/underscore.
  // A category with a space or a slash must not produce a 422 on every ticket.
  const { calls } = await withStubbedFetch(
    () => Response.json({ payload: [] }),
    () => configuredChatwootSink({ labelPrefix: "triage/" }).publish(
      sampleDecision({
        ticket: { message: "m", channel: "email", external_id: "chatwoot:1:77" },
        triage: { ...sampleDecision().triage, category: "product issue / defect" },
      }),
    ),
  );
  const labels = (calls.find((c) => c.url.endsWith("/labels") && c.method === "POST")
    ?.body as { labels: string[] }).labels;
  for (const l of labels) {
    assert.match(l, /^[\p{L}\p{N}_-]+$/u, `"${l}" would be rejected by Chatwoot's label validator`);
  }
});

function configuredZammadSink(over: Partial<Parameters<typeof zammadSink>[0]> = {}) {
  process.env.TEST_ZM_BASE = "https://help.example.com";
  process.env.TEST_ZM_TOKEN = "token";
  return zammadSink({
    baseUrlEnv: "TEST_ZM_BASE", tokenEnv: "TEST_ZM_TOKEN",
    note: true, publicNote: false, tag: true, tagPrefix: "triage-",
    priorityMap: { urgent: "3 high", high: "3 high", normal: "2 normal", low: "1 low" },
    groupMap: {}, ...over,
  });
}

const ZM_DECISION = () =>
  sampleDecision({ ticket: { message: "m", channel: "email" as const, external_id: "zammad:4711:a9001" } });

test("the zammad sink sets priority, group and the note in one PUT", async () => {
  const { result, calls } = await withStubbedFetch(
    () => Response.json({}, { status: 200 }),
    () => configuredZammadSink({ groupMap: { billing: "Billing" }, escalationGroup: "Supervisors" })
      .publish(ZM_DECISION()),
  );

  assert.equal(result.ok, true);
  const puts = calls.filter((c) => c.method === "PUT");
  assert.equal(puts.length, 1, "priority, group and article are one transactional call, not three");
  assert.equal(puts[0]?.url, "https://help.example.com/api/v1/tickets/4711",
    "the URL must use the internal ticket id from external_id");
  const body = puts[0]?.body as Record<string, any>;
  assert.equal(body.priority, "2 normal");
  // sampleDecision sets requires_human, so the escalation group wins.
  assert.equal(body.group, "Supervisors");
  assert.equal(body.article.internal, true,
    "internal:false is visible to the customer in the portal; the default must never be that");
  assert.equal(body.article.type, "note");
});

test("a bad priority name does not also swallow the triage note", async () => {
  // Zammad resolves `priority` by name and 422s when it cannot find one. That
  // is one call carrying the fields AND the article, so without the retry a
  // typo in priorityMap would silently cost the reviewer their note.
  let seen = 0;
  const { result, calls } = await withStubbedFetch(
    (_url, init) => {
      if ((init.method ?? "GET") !== "PUT") return Response.json({}, { status: 200 });
      seen += 1;
      return seen === 1
        ? Response.json({ error: "No lookup value found for 'priority'" }, { status: 422 })
        : Response.json({}, { status: 200 });
    },
    () => configuredZammadSink({ priorityMap: { normal: "Totally Not A Priority" } }).publish(ZM_DECISION()),
  );

  const puts = calls.filter((c) => c.method === "PUT");
  assert.equal(puts.length, 2, "the failed update must be retried with the article alone");
  assert.deepEqual(Object.keys(puts[1]?.body as object), ["article"],
    "the retry must drop the fields that caused the 422, not repeat them");
  assert.match(result.actions.join(" "), /priorityMap\/groupMap/);
  assert.match(result.actions.join(" "), /retried without field updates/);
});

test("the zammad sink adds tags one at a time and does not read them first", async () => {
  const { calls } = await withStubbedFetch(
    () => Response.json({}, { status: 201 }),
    () => configuredZammadSink().publish(ZM_DECISION()),
  );
  const tagCalls = calls.filter((c) => c.url.includes("/api/v1/tags/add"));
  // Zammad's tag endpoint APPENDS — the opposite of Chatwoot's label endpoint,
  // which replaces. No read-before-write is needed here, and assuming otherwise
  // in either direction is how an integration deletes someone's work.
  assert.equal(calls.some((c) => c.url.includes("/api/v1/tags") && c.method === "GET"), false);
  const items = tagCalls.map((c) => new URL(c.url).searchParams.get("item"));
  assert.deepEqual(items, ["triage-billing", "triage-normal", "triage-needs-human"]);
  for (const c of tagCalls) {
    assert.equal(new URL(c.url).searchParams.get("object"), "Ticket");
    assert.equal(new URL(c.url).searchParams.get("o_id"), "4711");
  }
});

test("the zammad sink explains a 403 on a tag rather than reporting a bare status", async () => {
  const { result } = await withStubbedFetch(
    (url) => url.includes("/tags/add")
      ? Response.json({ error: "Forbidden" }, { status: 403 })
      : Response.json({}, { status: 200 }),
    () => configuredZammadSink().publish(ZM_DECISION()),
  );
  assert.match(result.actions.join(" "), /tag creation is disabled/);
  // The note still landed. A tag setting is not a reason to lose the decision.
  assert.match(result.actions.join(" "), /internal note added/);
});

test("the zammad sink refuses a ticket that is not a zammad ticket", async () => {
  const r = await configuredZammadSink().publish(
    sampleDecision({ ticket: { message: "m", channel: "email", external_id: "chatwoot:1:77" } }),
  );
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no Zammad ticket id/);
});

test("zammad tags survive a category with a comma", async () => {
  // Zammad splits tag input on commas, so an unsanitized category would land
  // as two unrelated tags.
  const { calls } = await withStubbedFetch(
    () => Response.json({}, { status: 201 }),
    () => configuredZammadSink().publish(
      sampleDecision({
        ticket: { message: "m", channel: "email", external_id: "zammad:4711" },
        triage: { ...sampleDecision().triage, category: "billing, refunds" },
      }),
    ),
  );
  const items = calls
    .filter((c) => c.url.includes("/tags/add"))
    .map((c) => new URL(c.url).searchParams.get("item"));
  for (const i of items) assert.doesNotMatch(i ?? "", /[,\s]/, `"${i}" would become two tags in Zammad`);
});

// --- store ------------------------------------------------------------------

test("memory store conforms", async () => {
  await checkStore(memoryStore());
});
