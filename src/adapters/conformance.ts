/**
 * The executable version of the adapter contract.
 *
 * `docs/adapters.md` describes what an adapter must do. This file CHECKS it,
 * which is the difference between a documented contract and a real one. If you
 * write an adapter for a system this repo does not ship, run it through here
 * before you trust it — and if a check here seems pedantic, read the comment
 * on it, because each one is a failure mode rather than a style preference.
 *
 * Used by `test/adapters.test.ts`. Runs entirely offline: no network, no keys.
 */
import assert from "node:assert/strict";
import type { Store, TicketSink, TicketSource, Decision } from "./types.js";

export function sampleDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "TQ-TEST-0001",
    ticket: { message: "test message", channel: "email" },
    triage: {
      category: "billing", urgency: "normal", sentiment: "neutral",
      summary: "Test.", entities: { order_ids: [], product_names: [], requested_remedy: "none" },
      requires_human: true, escalation_reason: "test", confidence: 0.9,
    },
    violations: [], redactions: [], model: "claude-opus-5", cost_usd: 0.001,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * @param withSecret Sets the source's secret env var and returns a request that
 *                   SHOULD verify. Omit when the adapter has no secret.
 */
export async function checkSource(
  source: TicketSource,
  fixtures: {
    validPayload: unknown;
    /** A payload the adapter should ignore — a label change, a bot comment. */
    ignoredPayload?: unknown;
    signedRequest?: () => { headers: Headers; body: string };
    unsignedRequest?: () => { headers: Headers; body: string };
  },
): Promise<void> {
  assert.ok(source.name, "a source must have a name");

  // 1. FAIL CLOSED on a bad or absent signature. The single most important
  //    property: a missing secret must not become an open endpoint.
  if (fixtures.unsignedRequest) {
    const { headers, body } = fixtures.unsignedRequest();
    const r = await source.verify(headers, body);
    assert.equal(r.ok, false, `${source.name}: an unsigned request must NOT verify`);
    assert.ok(r.reason, `${source.name}: a rejection must say why, for the log`);
  }

  if (fixtures.signedRequest) {
    const { headers, body } = fixtures.signedRequest();
    const r = await source.verify(headers, body);
    assert.equal(r.ok, true, `${source.name}: a correctly signed request must verify`);
  }

  // 2. Normalize produces valid canonical tickets.
  const tickets = source.normalize(fixtures.validPayload);
  assert.ok(tickets.length > 0, `${source.name}: a valid payload must produce a ticket`);
  for (const t of tickets) {
    assert.ok(t.message.length > 0, `${source.name}: ticket.message must be non-empty`);
    assert.ok(t.message.length <= 20_000, `${source.name}: ticket.message must be truncated to 20k`);
  }

  // 3. Ignored events return [], and do NOT throw. Most webhook traffic is
  //    events you do not want; treating them as errors produces retry storms.
  if (fixtures.ignoredPayload !== undefined) {
    assert.deepEqual(source.normalize(fixtures.ignoredPayload), [],
      `${source.name}: an event this adapter ignores must normalize to []`);
  }

  // 4. Garbage in must not throw. A webhook sender you do not control will
  //    eventually send you something malformed.
  for (const junk of [null, undefined, 42, "string", {}, []]) {
    assert.doesNotThrow(() => source.normalize(junk),
      `${source.name}: normalize(${JSON.stringify(junk)}) must not throw`);
  }
}

export async function checkSink(sink: TicketSink): Promise<void> {
  assert.ok(sink.name, "a sink must have a name");
  assert.ok(sink.capabilities, "a sink must declare its capabilities");

  // A sink MUST NOT throw, ever. A sink failure is an operational problem with
  // someone else's service; it must not cost us a decision we already paid for
  // and already stored. Unconfigured is the easiest way to prove it.
  const result = await sink.publish(sampleDecision());
  assert.equal(typeof result.ok, "boolean", `${sink.name}: publish must return {ok}`);
  assert.ok(Array.isArray(result.actions), `${sink.name}: publish must return an actions array`);
  if (!result.ok) {
    assert.ok(result.error, `${sink.name}: a failed publish must explain itself`);
  }
}

export async function checkStore(store: Store): Promise<void> {
  await store.init();
  try {
    const health = await store.health();
    assert.equal(typeof health.ok, "boolean");

    // 1. Insert / read / list round-trip.
    const rec = { ...sampleDecision(), status: "new" as const, message_redacted: "test message" };
    await store.insertEscalation(rec);
    const got = await store.getEscalation(rec.id);
    assert.ok(got, `${store.name}: an inserted escalation must be readable`);
    assert.equal(got.triage.category, "billing");
    assert.ok((await store.listEscalations({ status: "new" })).some((e) => e.id === rec.id));

    // 2. Status transitions and the claim timestamp the stats depend on.
    assert.equal(await store.setStatus(rec.id, "claimed", "reviewer"), true);
    const claimed = await store.getEscalation(rec.id);
    assert.equal(claimed?.status, "claimed");
    assert.ok(claimed?.claimed_at, `${store.name}: claiming must record claimed_at`);
    assert.equal(await store.setStatus("no-such-id", "resolved"), false,
      `${store.name}: setStatus on a missing id must return false, not throw`);

    // 3. Rate limiting counts, and the limit is inclusive of the last allowed.
    const key = `conformance:${Math.random()}`;
    assert.equal(await store.rateLimit(key, 2, 60_000), true);
    assert.equal(await store.rateLimit(key, 2, 60_000), true);
    assert.equal(await store.rateLimit(key, 2, 60_000), false,
      `${store.name}: the third request against a limit of 2 must be refused`);

    // 4. Idempotency: first sighting false, second true.
    const ext = `ext:${Math.random()}`;
    assert.equal(await store.markSeen(ext), false, `${store.name}: a new id must report unseen`);
    assert.equal(await store.markSeen(ext), true, `${store.name}: a repeat id must report seen`);

    // 5. Usage accumulates in integer micro-dollars.
    const day = "2099-01-01";
    await store.recordUsage(day, 100, 1234);
    await store.recordUsage(day, 50, 66);
    const usage = await store.usageFor(day);
    assert.equal(usage.tokens, 150);
    assert.equal(usage.micro_dollars, 1300);
    assert.equal(usage.requests, 2);
    assert.equal(Number.isInteger(usage.micro_dollars), true,
      `${store.name}: cost must accumulate as integer micro-dollars, not floats`);

    await store.queueStats();
  } finally {
    await store.close();
  }
}
