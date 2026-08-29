# Zammad

The connector for teams that already run a mature, self-hosted helpdesk and want
the triage decision to be auditable rather than magical. Zammad is ticket-centric
where Chatwoot is conversation-centric, it has real group/owner routing, and
every write this sink makes lands in the ticket history under the token's user.

- Source: [`src/adapters/sources/zammad.ts`](../../src/adapters/sources/zammad.ts)
- Sink: [`src/adapters/sinks/zammad.ts`](../../src/adapters/sinks/zammad.ts)
- Conformance + behaviour tests: [`test/adapters.test.ts`](../../test/adapters.test.ts)

---

## Zammad has triggers, not event subscriptions

This is the structural difference from Chatwoot and it decides how you set the
integration up. There is no list of events to tick. There is a **webhook**
(an endpoint plus a signature token) and a **trigger** (conditions plus actions,
one of which can be "call that webhook").

That is a better arrangement than it first looks: the event filter lives in
Zammad's admin UI where an operator can see and change it without a deploy. So
this adapter does not try to reimplement it. It filters on exactly one thing —
whether the article came from the customer — because that is the part a trigger
condition cannot safely express and the part that stops a feedback loop.

**Setup:**

1. **Manage → Webhook → New.** Endpoint `https://your-service/v1/ingest/zammad`.
   Set a **signature token**. Leave the payload as the default — the custom
   payload editor exists, but a mapping you can only read inside someone's admin
   UI is a mapping nobody reviews.
2. **Manage → Trigger → New.** Condition **Action is *created***. Action
   **Webhook → <the webhook you just made>**.
3. **Settings → System → API.** "API token access" must be enabled, or every
   sink write is a 403.
4. A **bot user** with agent rights on the groups you write to, and an access
   token from its profile.

```ts
// triage.config.ts
sources: { zammad: { kind: "zammad" } },
sinks: [],   // advisory. leave it empty until you have watched the queue.
```

```bash
ZAMMAD_WEBHOOK_SECRET=...     # the signature token from step 1
ZAMMAD_URL=https://help.example.com
ZAMMAD_TOKEN=...              # step 4; only needed once you add the sink
```

When you are ready to write back:

```ts
sinks: [{
  kind: "zammad",
  groupMap: { billing: "Billing", safety: "Safety" },
  escalationGroup: "Supervisors",
}],
```

---

## The four things that bite

Each is a real property of Zammad verified against `zammad/zammad`, and each has
a test.

### 1. The signature is SHA-**1**, under the legacy header name

```
X-Hub-Signature: sha1=<hex HMAC-SHA1 of the raw body>
```

Zammad uses GitHub's original scheme (`lib/user_agent.rb`). Two consequences.

HMAC-SHA1 is still a sound MAC — bare SHA-1's collision weakness does not carry
over to HMAC — so this is a compatibility fact, not a finding. Do not "fix" it
by reaching for SHA-256; Zammad will not send it.

More practically: the header is one character away from the
`X-Hub-Signature-256` this repo's GitHub source reads. Point a Zammad webhook at
`/v1/ingest/github` and it fails closed with "missing header" rather than
accepting anything. There is a test asserting exactly that near-miss.

The signature token is optional in Zammad's UI. Leave it blank and Zammad sends
the payload unsigned, and this source refuses every request.

### 2. A field's type depends on whether it is in `ASSOCIATIONS`

Zammad's webhook payload builder resolves *some* associations into full
attribute hashes and leaves the rest as plain name strings. For a ticket,
`ASSOCIATIONS` is `owner customer created_by updated_by organization priority
group` — so `ticket.customer` and `ticket.priority` are **objects**
(`ticket.customer.email` is right there), while `ticket.state` is the **string**
`"new"`. For an article it is only `created_by updated_by`, so `article.sender`
is the string `"Customer"` and `article.type` is `"email"`.

The adapter reads `ticket.customer.email` and falls back to parsing
`article.from` for a customer record with no address on it.

### 3. Article bodies are often HTML

Zammad stores web-form and most email articles as `text/html`. Passing `body`
straight to the model costs tokens, degrades classification, and hands the
untrusted-input escaping in `lib/untrusted.ts` a wall of angle brackets to deal
with. The source runs a deliberately minimal HTML-to-text pass first: script and
style content dropped, block boundaries turned into newlines rather than welding
two sentences together.

It is not a sanitizer and does not need to be — the output is treated as
untrusted either way and nothing is ever rendered as HTML.

### 4. `internal: false` is visible to the customer

A Zammad article with `internal: false` shows in the customer portal, and
depending on type is sent to them. The sink writes `type: "note",
internal: true`. The option that changes it is named `publicNote`, it defaults
to `false`, and there is a comment next to it saying why.

That flag plus `sender` is also the **loop guard**. This sink adds an article on
every decision, and someone will eventually widen the trigger to "Action is
updated" because they want follow-ups triaged. Without the guard, our own note
comes back as a ticket, which produces another note, on every turn. The source
rejects any article whose `sender` is not `"Customer"` or whose `internal` is
true — either check alone would hold, and both are there because the failure
mode is a billed infinite loop.

---

## What the sink writes

Zammad takes priority, group and a new article in a **single**
`PUT /api/v1/tickets/{id}`. One round trip instead of Chatwoot's four, and
transactional.

| Decision field | Zammad write | Call |
|---|---|---|
| `urgency` via `priorityMap` | ticket priority, by name | `PUT /api/v1/tickets/{id}` |
| `category` via `groupMap`, or `escalationGroup` when `requires_human` | ticket group, by name | same PUT |
| summary, confidence, escalation reason, guardrail findings, redaction count | internal note | same PUT (`article`) |
| `category`, `urgency`, `requires_human` | tags | `POST /api/v1/tags/add` per tag |

### Names, not ids — and what that costs

`Ticket.association_name_to_id_convert` resolves `priority: "3 high"` and
`group: "Support"` against the database, and raises `UnprocessableContent` for
anything it cannot find. Passing names keeps your config readable and portable
across instances. The cost is that a typo is a 422 **on every ticket** — and
since the fields and the note ride in the same call, a naive implementation
would lose the note too.

So a failed update is retried with the article alone, and the action log says
`check priorityMap/groupMap names exist in Zammad`. The reviewer still gets
their note; you still get a loud signal.

`priorityMap` defaults to `{urgent → "3 high", high → "3 high", normal →
"2 normal", low → "1 low"}`. A stock Zammad ships exactly three priorities, so
the shipped packs' four urgencies collapse onto them rather than this adapter
inventing a fourth in your instance. Add one in Zammad and remap if you want the
split.

`groupMap` and `escalationGroup` default to empty — nothing is routed anywhere
until you say so.

### Tags append here; they replaced in Chatwoot

`POST /api/v1/tags/add` calls `Tag.tag_add` for one tag at a time, so this sink
needs no read-before-write. Chatwoot's label endpoint replaces the whole list and
does. **The same conceptual operation has opposite semantics in two helpdesks.**
That is the transferable lesson for the next connector: read what the endpoint
does, do not carry the last one's assumption into it.

One Zammad-specific failure: a 403 on `tags/add` means the `tag_new` setting is
off and the tag does not exist yet. Create your triage tags once under
Manage → Tags, or enable creation. The sink says so in the action log instead of
reporting a bare status, and the note still lands.

---

## Identity

`external_id` is `zammad:<ticket_id>` or `zammad:<ticket_id>:a<article_id>`.

The first segment is Zammad's **internal ticket id** — the `id` column, what
`PUT /api/v1/tickets/{id}` takes — **not** the human-facing ticket `number` you
see in the UI. They are different fields and both are in the payload; using
`number` gives you a sink that 404s on every write.

The article segment makes a follow-up on the same ticket a new thing to triage
rather than a duplicate delivery of the first.

---

## Licensing

Zammad is **AGPL-3.0**. This connector talks to its HTTP REST API over the
network and embeds, links, or redistributes none of its code, so it carries this
repository's own license and imposes nothing on yours.

That distinction is the whole reason the connector layer is shaped this way, and
it gets sharper from here — FreeScout and osTicket are AGPL and GPL too. Calling
a published API is clean. Vendoring a patched controller, shipping a modified
fork, or bundling upstream source into your distribution is not, and the AGPL's
network clause means "we only run it on our own server" is not the escape hatch
people assume. Ask a lawyer before you vendor anything from them; do not ask
this file.
