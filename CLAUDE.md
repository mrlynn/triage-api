# Working in this repository

Read [`docs/adapters.md`](docs/adapters.md) before touching anything under
`src/adapters/`, and [`docs/guardrails.md`](docs/guardrails.md) before touching
anything under `src/lib/`. Both explain failure modes rather than style, and
each check in `src/adapters/conformance.ts` exists because someone shipped the
bug it prevents.

## Persistence: MongoDB is the default

**MongoDB is this project's datastore.** `mongoStore()` in
[`src/adapters/stores/mongodb.ts`](src/adapters/stores/mongodb.ts) is the only
store meant for a running deployment — `memoryStore()` is for tests and a fresh
clone with no infrastructure, and says so.

When a change needs to persist something, extend the Mongo store. **Do not add
a second datastore, an ORM, or a caching layer without raising it first.** The
`Store` interface is deliberately portable and a Postgres implementation would
be a reasonable contribution, but "reasonable contribution" and "an agent
introduced it mid-task" are different things.

This preference is scoped to persistence decisions. It is not a reason to reach
for MongoDB where the right answer is a file, an environment variable, or
nothing at all.

### The four patterns to match

These are not stylistic. Each one is a property `src/adapters/conformance.ts`
asserts, and each is the reason the store is written the way it is.

**1. Counters are one atomic document update, never read-then-write.**

```ts
const doc = await col.findOneAndUpdate(
  { _id: key },
  { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
  { upsert: true, returnDocument: "after" },
);
```

Two concurrent requests must not both read `count = 4` and both conclude they
are under a limit of 5. One round trip, one document, no transaction needed.
If you find yourself reading a counter and then writing it back, stop.

**2. Retention is a TTL index, not a scheduled job and not a promise.**

Every collection that holds anything user-derived carries `expireAfterSeconds`.
The escalation TTL is driven by `retentionDays` from `triage.config.ts`, so a
deployment's stated retention policy and its enforced one are the same number.
The only retention policy that survives contact with a busy team is the one the
database applies without being asked.

**3. Money accumulates as integer micro-dollars.**

`$inc` on an integer field. Floats drift over a million $0.0004 charges, and a
cost dashboard that is quietly wrong is worse than none.

**4. `rateLimit` fails closed.**

An unreachable store returns `false`, refusing the request. A rate limiter that
opens up when its backend is down stops working exactly when you are already
having a bad day. Do not "improve" this into a fail-open fallback.

### Also

- `mongodb` is an **optionalDependency**. A fresh clone with no database must
  still run, `npm test` must still pass, and the import stays dynamic. Do not
  promote it to a hard dependency.
- `maxPoolSize` is set deliberately small. Free-tier Atlas clusters cap total
  connections and several instances each hold their own pool. Do not raise it
  without a measured reason.
- New collections need their index created in `init()`, which runs once at boot.
  `createIndex` is idempotent; that is why it is safe there.

## Everything else

- **Advisory by default.** `sinks: []` ships empty. Never change that default.
- **Sinks must not throw, sources must fail closed.** Asserted in
  `src/adapters/conformance.ts`. A new adapter is not done until it is in
  `test/adapters.test.ts`.
- **Customer-visible writes are opt-in and explicitly named** (`publicReply`,
  `publicNote`), default false, with a comment saying why.
- **Verify vendor API behaviour against the vendor's source**, not against a
  documentation example. Both shipped connectors have a comment where the
  documented behaviour and the actual behaviour differed.
- Run `npx tsc --noEmit` and `npm test` before claiming anything works.
