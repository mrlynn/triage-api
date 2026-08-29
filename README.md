# triage-api

**An opinionated, open-source reference implementation of AI ticket triage — with the guardrails already in it.**

You have a ticketing system. You are not going to replace it. You want Claude to
read inbound tickets, classify them, decide what should happen, and flag the ones
a human needs to see — without inventing refunds, quoting policy clauses that do
not exist, or taking instructions from the customer.

This is that service. Fork it, point a webhook at it, and it writes nothing back
until you say so.

```bash
git clone https://github.com/mrlynn/triage-api && cd triage-api
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
npm run dev
```

```bash
curl -s localhost:8787/v1/triage -H 'content-type: application/json' \
  -d '{"message":"Order NW-48211 arrived with a broken zipper. I want a replacement."}' | jq .triage
```

No database. No adapter config. No account with anyone. That is the whole
five-minute path, and it is deliberate — a reference repo that needs Postgres and
a Zendesk sandbox before it prints anything gets evaluated by nobody.

---

## What you get

| | |
|---|---|
| `POST /v1/triage` | Structured classification. Enum-constrained by the API, validated by Zod, typed end to end. |
| `POST /v1/resolve` | A capped agentic loop that looks up orders and policy, then recommends an action — **re-checked in code** before it is returned. |
| `POST /v1/draft` | A streamed reply for a human to read before sending. |
| `POST /v1/estimate` | What this will cost you, per ticket and per month. Free — no inference. |
| `POST /v1/ingest/:source` | Signed webhook receiver with idempotency. Point your helpdesk here. |
| `GET /queue` | A reviewer board and a full decision trace, server-rendered. |
| `GET /readyz` | Which guardrails are actually running in *this* deployment. |
| `npm run mcp` | The same tools over MCP, for Claude Desktop or any MCP client. |

## The guardrails, and why they are the point

Anyone can call a model and get JSON back. The reason this repository exists is
everything after that.

**A model-judged boolean is a hypothesis. A control is code.** The resolution
schema has a field called `within_agent_authority`. Nothing about a model
reporting `true` there makes it true. So [`src/lib/authority.ts`](src/lib/authority.ts)
re-derives the answer from the recorded tool trace, the arithmetic wins, and the
disagreement is **counted** as `model_claimed_authority_it_lacked` — because a
silent correction fixes one response and a counted one tells you your prompt is
drifting.

**Escape, do not blocklist.** A customer can close your `<customer_message>` tag.
[`wrapUntrusted`](src/lib/untrusted.ts) escapes `<`, which is the SQL-parameterization
argument in a new costume. It does not make the model immune to persuasion — that
is what the deterministic checks are for — it guarantees the attack arrives
*inside* the data block.

**Verify citations by existence, not by tool call.** The handbook is already in
the cached system prompt, so citing clause 2.7 without searching is legitimate.
Checking "did it search first" produces false positives on every run. Checking
"does this clause exist" catches the forged one. [The comment in
`citations.ts`](src/lib/citations.ts) documents getting this wrong first.

**Degrade loudly.** If your deployment has no customer lookup, the rolling refund
ceiling *cannot run*. This service does not quietly approve refunds it cannot
check — it escalates them with `control_unavailable:rolling_ceiling` and says so
on `/readyz`. A guardrail that stops running when its inputs disappear, while its
summary still reads "0 violations", is worse than no guardrail.

**Storage is a consequence of escalation, not of submission.** Only tickets a
human must see are persisted, only in redacted form, under a **MongoDB TTL
index** driven by the `retentionDays` in your config — so the retention policy
you wrote down and the one that actually runs are the same number, and nothing
has to remember to delete anything. A support system that logs every inbound
message forever has built a breach waiting for an occasion.

**Advisory by default.** `sinks: []` out of the box. It classifies, it stores, it
shows you a queue, and it touches your ticketing system not at all. Run it that
way for a week. Add a sink when the decisions stop surprising you.

## Making it yours

Two things to edit, in this order.

**1. Your policy pack.** `cp -r packs/starter packs/acme`, then edit
`packs/acme/handbook.md` and `packs/acme/pack.ts` — your categories, your refund
limits, your clause numbering. The pack is a *matched set*: taxonomy, handbook,
authority rules, and eval cases move together, because changing one without the
others silently invalidates the others. See [docs/policy-packs.md](docs/policy-packs.md).

```bash
npm run pack:validate -- acme
```

**2. Your adapters.** One config file, four seams — where tickets come from,
where decisions go, what is remembered, and what the model may look up.

```ts
// triage.config.ts
export default defineConfig({
  pack: "acme",
  store: { kind: "mongodb" },
  data: { kind: "http", orderUrl: "https://internal/orders/{id}" },
  sources: { chatwoot: { kind: "chatwoot" } },
  sinks: [],  // still advisory. add one when you believe it.
});
```

Shipped: **Chatwoot** (the fullest connector — labels, priority, team routing
and a private note, over an open-source helpdesk you can self-host in an
afternoon: [docs/integrations/chatwoot.md](docs/integrations/chatwoot.md)),
**Zammad** (ticket-centric, for mature self-hosted deployments that need
auditable routing: [docs/integrations/zammad.md](docs/integrations/zammad.md)),
**generic-webhook** (the one to reach for first — sign a POST from the system
you already control), **Zendesk**, **GitHub Issues** (testable in five minutes
with no sales call), **fixtures** (dev). Everything else is an interface plus a
conformance suite: [docs/adapters.md](docs/adapters.md).

**3. Your eval set.** This is the step people skip and the one that decides
whether any of the rest works. Ten to fifteen real tickets, hand-labelled, in
`packs/acme/evals/dataset.jsonl`. Without them you have a system that produces
confident output and no way to know whether it is right — which is worse than no
system, because someone will trust it.

```bash
npm run eval:quick -- --record   # put a number on the board
npm run eval:redteam             # 100% gate. a rate is the wrong shape for a breach.
```

## Built on MongoDB

[`src/adapters/stores/mongodb.ts`](src/adapters/stores/mongodb.ts) is the store
meant for a running deployment; `memoryStore()` exists so a fresh clone works
with no infrastructure. Three of this service's stated guarantees are not
application code at all — they are things the database does:

| Guarantee | How |
|---|---|
| Retention is a mechanism, not a promise | `expireAfterSeconds` on the escalations collection, set from `retentionDays`. MongoDB deletes the document. |
| The rate limiter cannot be raced | One `findOneAndUpdate` with `$inc` + `$setOnInsert` under an upsert. One round trip, one document, no transaction — two concurrent requests cannot both read `count = 4`. |
| Cost accounting does not drift | `$inc` on an integer field of micro-dollars, because floats drift over a million $0.0004 charges. |

Indexes are created in `init()` at boot, which is safe because `createIndex` is
idempotent. `maxPoolSize` is deliberately small: free-tier Atlas clusters cap
total connections and every instance holds its own pool.

`mongodb` is an `optionalDependency`. The service runs, and the test suite
passes, on a machine that has never seen a database.

The `Store` interface is portable and Postgres would be a straightforward
addition. That is deliberate, and it is not the same as the choice being
arbitrary — the atomic-counter and TTL guarantees above are what everything
upstream assumes it has. See [docs/adapters.md](docs/adapters.md).

## What this is not

Read [docs/what-this-is-not.md](docs/what-this-is-not.md) before you plan around
it. Briefly: not a helpdesk, not multi-tenant, not a compliance artifact, and it
does not reply to customers.

## Where it comes from

This is the reference implementation extracted from [**Building a Production
Triage API with Claude**](https://triage.mlynn.dev) — a ten-lab course that
builds this system against a fictional retailer, argues about every decision, and
documents the ones that were wrong the first time. Files here carry
`COURSE REF:` pointers to the lab that explains them.

The course teaches the technique. This repository is the technique with the
fictional retailer moved behind a config seam.

## Contributing

Adapters, packs, and better arguments all welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). New adapters must pass
`src/adapters/conformance.ts`.

Apache-2.0.
