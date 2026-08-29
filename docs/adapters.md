# Writing an adapter

Four interfaces, all in [`src/adapters/types.ts`](../src/adapters/types.ts), all
checked by [`src/adapters/conformance.ts`](../src/adapters/conformance.ts). The
conformance suite is the real contract; this page explains it.

**Before you write one, consider not writing one.** The `generic-webhook` source
takes a signed POST of the canonical ticket shape. Doing the field mapping inside
the system you already control — a Zendesk trigger template, a Jira automation
rule, six lines in your own backend — is usually faster to build, easier to test,
and less brittle than a vendor adapter that has to guess at your custom fields.
Write an adapter when you want the mapping versioned in this repo.

---

## `TicketSource` — how tickets arrive

```ts
interface TicketSource {
  name: string;
  verify(headers: Headers, rawBody: string): Promise<VerifyResult>;
  normalize(payload: unknown): CanonicalTicket[];
}
```

### `verify` must fail closed

If the secret is not configured, **refuse every request**. The tempting
alternative — "no secret set, so skip verification" — turns a missing environment
variable into an open ingest endpoint, and the person who deployed it never finds
out. The conformance suite asserts this.

Compare signatures in constant time (`safeEqual` in
[`sources/generic-webhook.ts`](../src/adapters/sources/generic-webhook.ts)).
`a === b` on a signature leaks its prefix through timing; it is two lines to fix
and it is left out of most webhook examples on the internet.

You receive `rawBody` as text rather than a parsed object because signature
schemes sign exact bytes, and re-serializing parsed JSON gives you different
bytes and a signature that never matches.

### `normalize` must never throw

Returning `[]` is the **normal** case, not an error: a label change, a bot
comment, an event type you ignore. Most webhook traffic is events you do not
want, and treating them as failures produces retry storms. `null`, `42`, a bare
string and an array all have to come back as `[]` — a sender you do not control
will eventually send you one of them.

### `external_id` is the idempotency key

Set it, and make it stable. Webhooks retry — GitHub retries, Zendesk retries,
your own proxy retries a timeout that already succeeded — and without this you
pay twice and file the same escalation twice. A queue full of doubled tickets is
how a reviewer learns to stop trusting it.

Use a scheme prefix so ids from different systems cannot collide:
`github:owner/repo#42`, `zendesk:9001`.

---

## `TicketSink` — where decisions go

```ts
interface TicketSink {
  name: string;
  publish(decision: Decision): Promise<PublishResult>;
  capabilities: { comment; tag; setField; assign };
}
```

### `publish` must not throw, ever

A sink failure is an operational problem with someone else's service. It must not
cost you a decision you already paid a model for and already stored. Return
`{ok: false, error}`; the pipeline logs it and moves on. The conformance suite
calls `publish` on an unconfigured sink specifically to check this.

### Default to internal, not customer-visible

Write an internal note, a label, a private comment. If your sink *can* reach a
customer, make that an explicitly named option that defaults to off, and put a
comment next to it saying why. See
[`sinks/zendesk.ts`](../src/adapters/sinks/zendesk.ts).

### Do not re-trigger yourself

If your sink comments on the same object your source watches, filter your own
writes out in `normalize` — the GitHub adapter drops `sender.type === "Bot"`.
Otherwise a sink comment becomes a new ticket becomes a sink comment.

---

## `Store` — what is remembered

The full interface is in `types.ts`. Four properties the conformance suite
enforces, each of which is a bug someone has shipped:

1. **`rateLimit` fails closed.** An unreachable backend returns `false`. A rate
   limiter that opens up when its store is down stops working exactly when you
   are already having a bad day.
2. **`rateLimit` is atomic.** Two concurrent requests must not both read
   "count = 4" and both decide they are under a limit of 5. One round trip, one
   document — see the `findOneAndUpdate` in the Mongo store.
3. **Cost accumulates as integer micro-dollars.** Floats drift over a million
   $0.0004 charges, and a cost dashboard that is quietly wrong is worse than none.
4. **Retention is a mechanism, not a promise.** A TTL index, a scheduled job,
   something that runs without anyone remembering.

`memoryStore()` is the reference for behaviour; `mongoStore()` is the reference
for operations. Postgres is a straightforward addition and the interface is
already carved for it.

---

## `DataProvider` — what the model may look up

```ts
interface DataProvider {
  name: string;
  lookupOrder?(id: string): Promise<OrderRecord | null>;
  lookupCustomer?(email: string): Promise<CustomerRecord | null>;
}
```

**The methods are optional, and that is load-bearing.** A provider that does not
implement `lookupCustomer` means the `lookup_customer` tool is never offered to
the model — withholding a tool is a stronger guarantee than instructing the model
not to use it — and the rolling refund ceiling reports itself as unavailable
rather than silently passing. See [`src/lib/authority.ts`](../src/lib/authority.ts).

Two rules for the records you return:

- **404 is `null`, not an error.** It becomes `{found: false}`, which the model
  handles well, usually by telling the customer their order number looks wrong,
  which is often the truth. A throw teaches it nothing.
- **Return `refunds_last_30d_usd` as `undefined` if you cannot compute it, never
  `0`.** A wrong zero silently disables the rolling ceiling — the exact failure
  the optional-method design exists to prevent.

Set a timeout. An agentic loop makes several lookups per ticket; one slow call
does not cost you one slow request, it costs you the whole loop.

---

## Running the conformance suite

Add your adapter to `test/adapters.test.ts`:

```ts
test("my-helpdesk source conforms", async () => {
  process.env.MY_SECRET = "test-secret";
  await checkSource(myHelpdeskSource("MY_SECRET"), {
    validPayload,
    ignoredPayload,
    signedRequest: () => ({ headers: signedHeaders(body), body }),
    unsignedRequest: () => ({ headers: new Headers(), body }),
  });
});
```

```bash
npm test
```

Every check in the suite has a comment explaining the failure mode it prevents.
If one seems pedantic, read the comment — it is a bug someone shipped, usually in
this repo.

---

## Worked example: Chatwoot (shipped)

The fullest connector in the repo, and the one to read before writing your own.
It exercises every part of the contract — a signed-with-timestamp source, a loop
guard, a read-before-write sink, capability flags that reflect config rather than
wishes — and each of its sharp edges is a real property of a real API rather than
a hypothetical.

Full walkthrough: [docs/integrations/chatwoot.md](integrations/chatwoot.md).
The four things it exists to teach:

1. **Two events fire for one message.** `conversation_created` and
   `message_created` both fire for a conversation's first message. Accept both
   and you triage it twice under two ids, so idempotency does not save you. The
   adapter accepts one by default and makes you opt into the other.
2. **A field's type changes with its position.** `message_type` is the string
   `"incoming"` at the top level of a message event and the raw integer `0`
   inside a conversation's `messages[]`. Handle both or silently drop half your
   traffic.
3. **A write endpoint that replaces rather than appends.** Chatwoot's label API
   sets the whole list. The sink reads first and posts the union, and when the
   read fails it skips the write rather than deleting the agent's labels.
4. **A boolean that reaches a customer.** `private: false` delivers the message
   on the customer's channel. Default to internal, name the option that changes
   it, and put the reason next to it.

---

## Worked example: Zammad (shipped)

Read this one **after** Chatwoot, because the interesting thing about it is where
it disagrees. Same job, same contract, opposite answers in four places.

Full walkthrough: [docs/integrations/zammad.md](integrations/zammad.md).

| | Chatwoot | Zammad |
|---|---|---|
| Event model | subscribe to named events | a **trigger** with conditions calls a webhook; the filter lives in their admin UI |
| Signature | HMAC-**SHA256** over `{ts}.{body}`, `X-Chatwoot-Signature` | HMAC-**SHA1** over the body, `X-Hub-Signature` |
| Tags/labels | endpoint **replaces** the list — read and merge first | endpoint **appends** one at a time — no read needed |
| Writes | four calls (labels, priority, assignment, note) | **one** `PUT` carrying priority, group and the note |

That last row has a sting. Because the fields and the note ride in the same call,
and because Zammad resolves `priority`/`group` **by name** and 422s on a name it
cannot find, a typo in your config would take the reviewer's note down with it.
The sink retries with the article alone and reports the cause. One transactional
call is a real advantage and it has a real failure mode; both are worth seeing.

**The transferable lesson is the tags row.** The same conceptual operation —
"add a label" — replaces in one system and appends in the other. Neither is
wrong. Read what the endpoint does; never carry the last connector's assumption
into the next one.

---

## Worked example: Jira Service Management

Not shipped, because it cannot be tested without a licensed instance. The shape:

**Source.** JSM fires a webhook per issue event. Verify with a shared secret in a
custom header (JSM does not sign bodies, so put the endpoint behind an allowlist
or a gateway too, and say so in your runbook). Filter to
`webhookEvent === "jira:issue_created"`. Build the message from `fields.summary`
plus `fields.description` — note that a Cloud instance returns description as
Atlassian Document Format, not text, so you will be walking a node tree.
`external_id` is `jira:<issue.key>`.

**Sink.** `POST /rest/api/3/issue/{key}/comment` with `properties: [{key:
"sd.public.comment", value: {internal: true}}]` — that property is what makes the
comment internal, and omitting it emails your customer. Set the request type or
priority field via `PUT /rest/api/3/issue/{key}`.

**Data provider.** Usually not JSM at all. Your order data lives elsewhere; use
the `http` provider against the service that owns it.
