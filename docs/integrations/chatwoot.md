# Chatwoot

The fullest connector in this repo, and the one to copy when you write your own.
Chatwoot is conversation-centric rather than ticket-centric, which is a better
match for how triage actually runs: a decision per conversation, at the moment
it arrives, written back as labels, priority, a team assignment and a note an
agent reads before they reply.

It is also the connector you can actually try. Chatwoot is MIT licensed and
self-hosts in an afternoon, so nothing on this page needs a sales call to verify.

- Source: [`src/adapters/sources/chatwoot.ts`](../../src/adapters/sources/chatwoot.ts)
- Sink: [`src/adapters/sinks/chatwoot.ts`](../../src/adapters/sinks/chatwoot.ts)
- Conformance + behaviour tests: [`test/adapters.test.ts`](../../test/adapters.test.ts)

---

## Setup

**1. A bot user and an access token.** Create a user in Chatwoot for this
service — not a human agent's account. Every label, priority change and note the
sink writes is attributed to whoever owns the token, and you want that to read as
`Triage Bot` in the conversation history. Copy the token from Profile Settings →
Access Token.

**2. A webhook, with a secret.** Settings → Integrations → Webhooks, or
`POST /api/v1/accounts/{account_id}/webhooks`. Point it at
`https://your-service/v1/ingest/chatwoot` and **set a secret**.

Chatwoot will happily save a webhook with no secret, in which case it sends the
payload unsigned and this source refuses every request. That is the designed
outcome, not a bug — see [adapters.md](../adapters.md#verify-must-fail-closed).

**3. Subscribe to `conversation_created`. Only that.** More on this below.

**4. Configure.**

```ts
// triage.config.ts
sources: { chatwoot: { kind: "chatwoot" } },
sinks: [],   // advisory. leave it empty until you have watched the queue.
```

```bash
CHATWOOT_WEBHOOK_SECRET=...        # the secret from step 2
CHATWOOT_BASE_URL=https://chat.example.com
CHATWOOT_API_ACCESS_TOKEN=...      # step 1; only needed once you add the sink
```

When you are ready to write back:

```ts
sinks: [{
  kind: "chatwoot",
  teamMap: { billing: 4, safety: 7 },
  escalationTeamId: 9,
}],
```

---

## The four things that bite

Each of these is a real property of Chatwoot's API, verified against
`chatwoot/chatwoot` rather than inferred from an example. Each has a test.

### 1. `conversation_created` and `message_created` both fire for the first message

Subscribe to both and you triage the opening message twice, under two different
external ids, so the idempotency check does not save you — you pay twice and the
reviewer sees the same conversation in the queue twice.

The source accepts `conversation_created` only unless you widen it:

```ts
sources: { chatwoot: { kind: "chatwoot", events: ["message_created"] } },
```

Pick one. If you want every customer follow-up re-triaged rather than one
decision per conversation, use `message_created` **and subscribe to only that
event in Chatwoot**.

### 2. `message_type` is an integer in one place and a string in another

In a `message_created` payload the top-level `message_type` is the enum's string
form (`"incoming"`). In the `messages[]` array nested inside a conversation
payload it is the raw integer — `0` incoming, `1` outgoing, `2` activity,
`3` template.

An adapter that checks only for `"incoming"` silently drops every
`conversation_created` event and looks like a broken webhook. One that checks
only for `0` silently accepts agent replies as customer tickets.

### 3. The label endpoint replaces the whole list

`POST /conversations/{id}/labels` calls `update_labels` in Chatwoot, which sets
the label list wholesale. Post your two triage labels to a conversation an agent
had marked `vip` and `vip` is gone — 200 OK, no error anywhere.

So the sink reads the current labels first and posts the union. If that read
fails it **skips the write** rather than falling back to posting only its own,
and says so in the returned actions. An integration that quietly deletes human
work is the fastest way to get itself switched off.

Label titles are also a restricted charset — unicode letters, numbers, hyphen
and underscore. No slashes. The GitHub sink's `triage/` prefix is a 422 here,
which is why the default is `triage-` and pack values are sanitized on the way
out.

### 4. `private: false` is delivered to the customer

A Chatwoot message with `private: false` goes out on whatever channel the
conversation arrived on — email, WhatsApp, live chat. The sink writes
`private: true`. The option that changes it is named `publicReply`, it defaults
to `false`, and there is a comment next to it saying why.

Those same two fields are the **loop guard**: the source rejects anything that is
not `message_type: incoming` and not private, so a note this sink writes cannot
come back in as a new ticket. Either check alone would do it; both are there
because a loop here costs money on every turn.

---

## What the sink writes

| Decision field | Chatwoot write | Endpoint |
|---|---|---|
| `category`, `urgency`, `requires_human` | labels, merged with existing | `POST /conversations/{id}/labels` |
| `urgency` via `priorityMap` | conversation priority | `POST /conversations/{id}/toggle_priority` |
| `category` via `teamMap`, or `escalationTeamId` when `requires_human` | team assignment | `POST /conversations/{id}/assignments` |
| summary, confidence, escalation reason, guardrail findings, redaction count | private note | `POST /conversations/{id}/messages` |

`priorityMap` defaults to `{urgent, high, normal → medium, low}`, which covers
the urgency vocabulary both shipped packs use. A pack with different urgency
names gets no priority writes until you map them — better than guessing at
someone else's queue.

`teamMap` and `escalationTeamId` default to empty, so nothing is assigned until
you say so. Get the ids from `GET /api/v1/accounts/{account_id}/teams`.

Each write is independent. One dead endpoint produces a line in `actions` and
does not stop the others, because a sink failure must never cost you a decision
you already paid a model for.

---

## Identity and replay

`external_id` is `chatwoot:<account_id>:<display_id>`, or
`chatwoot:<account_id>:<display_id>:m<message_id>` for `message_created`. The
conversation segment is Chatwoot's **display id** — the per-account counter you
see in the UI and the only id the conversation endpoints accept as a path
parameter. The database primary key never appears in the API and must not be
used.

Chatwoot signs deliveries as:

```
X-Chatwoot-Timestamp: <unix seconds>
X-Chatwoot-Signature: sha256=<hex HMAC-SHA256 of "{timestamp}.{rawBody}">
```

The timestamp is inside the signed string, so an attacker replaying a captured
delivery cannot move it without invalidating the signature. That is what makes
checking it worth doing, and the source refuses anything more than
`toleranceSeconds` (default 300) out of date.

---

## Where this stops

Chatwoot ships its own AI features. This connector is not competing with them
and does not try to answer anyone — it produces a typed, explainable
classification with the guardrails in
[docs/guardrails.md](../guardrails.md) already applied, and writes it where an
agent will see it before they act. If you want the model drafting replies, that
is a different product with a different risk profile, and `publicReply` is not
the way to get there safely.

**Licensing.** Chatwoot is MIT. This connector talks to its HTTP API and embeds
none of its code, so it carries this repository's own license. That is the model
for every connector here: call the API, ship no vendored source. It matters more
for the AGPL and GPL helpdesks — Zammad, FreeScout, osTicket — where an API
client is clean but copying or modifying upstream code pulls their terms onto
whatever you distribute. Ask a lawyer before you vendor anything from them; do
not ask this file.
