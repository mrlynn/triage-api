# Policy packs

A pack is one directory holding everything that is *your company* rather than
*the technique*.

```
packs/acme/
  pack.ts                  taxonomy, authority limits, prompt additions, routing
  handbook.md              your policy — and the cached prompt prefix
  fixtures/                orders.json, customers.json (or wire a real provider)
  evals/
    dataset.jsonl          hand-labelled tickets. the step people skip.
    injections.jsonl       attacks against YOUR policy
    baseline.json          written by `npm run eval:quick -- --record`
```

```bash
cp -r packs/starter packs/acme
# edit packs/acme/pack.ts and handbook.md
npm run pack:validate -- acme
```

Then set `pack: "acme"` in `triage.config.ts`.

## Why a directory and not environment variables

A refund limit is a number, and a number is happy in an env var. But a category
taxonomy, a handbook, an authority rule, and an eval dataset are a **matched
set**.

Add a `warranty` category without adding warranty cases to your eval set and your
accuracy number stops meaning anything — it did not get worse, it stopped
measuring the thing you changed. Raise the refund ceiling in an env var and the
red-team case proving the ceiling holds is now asserting against a boundary that
moved. Renumber your handbook and citation verification reports every citation as
fabricated.

They move together, in one directory, versioned with your code. `npm run eval` is
scoped to whichever pack is active.

## The fields that matter most

### `taxonomy`

These become Zod enums, which become JSON Schema, which is what actually
constrains the model. An enum here is a **hard guarantee** — the model cannot
emit a value that is not on the list.

Keep it short and mutually exclusive. Start with six to eight categories. A
thirty-category taxonomy does not produce a more precise classifier; it produces
a confidently wrong one with an eval set too thin to notice. Watch what lands in
`other` and split a category only when the data asks you to.

`escalationAction` must be in `actions`. Every guardrail corrects *to* it — if it
is not a legal enum value, the correction produces a resolution that fails its own
schema, and you find out on the first violation, in production. The loader
refuses to start rather than let that happen.

### `handbook`

This is the cached prompt prefix, so two things about it are operational rather
than editorial.

**Length.** Below ~1024 tokens the API silently declines to cache it. No error,
no warning from the API — just full price on every request, forever.
`pack:validate` tells you your prefix size.

**Numbered clauses.** The resolver cites clause numbers and
`lib/citations.ts` verifies each cited clause exists in this text. Unnumbered
prose means every citation reads as fabricated. If you number differently — `POL-114`
rather than `2.7` — set `citations.clausePattern` to match, or the verifier finds
zero real clauses and flags everything.

### `authority`

These numbers become **code**. `enforceAuthority` re-derives the decision from
the recorded tool trace after the model answers, the arithmetic wins, and the
disagreement is counted. The model is *also* told these limits in the prompt, but
that is a hypothesis and this is the control.

`rollingCeilingUsd` must be at least `refundLimitUsd`, or every individually
permitted refund breaches the rolling ceiling and you escalate 100% of refunds
while looking configured. The loader checks.

### `prompts`

Appended to the built-in role prefixes. You **cannot** displace the trust
boundary in `src/pack.ts` by editing this — that paragraph is a control, and
"we documented that you shouldn't remove it" is not a control. There is a test.

Keep this text frozen. It lives inside the cached prefix; a value that varies per
request — a date, a customer name — costs you every cache hit you have.
Per-request context goes in `volatileContext()`, after the breakpoint.

### `redaction`

Added on top of the built-in card and SSN rules. Matches are counted and
replaced; the value is never logged, stored, or returned.

Be careful with digit patterns. The built-in card rule is Luhn-checked precisely
so it does not eat order ids and tracking numbers — a false positive there is not
cosmetic, it means the model cannot look up an order whose id it never saw, and
you get a mysterious "order not found".

## The eval set

Ten to fifteen real tickets from your own queue, hand-labelled, with a `notes`
field saying which rule each one tests.

Write the notes. When a case fails six months from now, the note is how the next
person tells a real regression from a disagreement about labels — the course's
first run of its own dataset scored 58%, and five of six failures were *label*
errors, not model errors.

Include at least one **discriminating case**: a message where the obvious read is
wrong. An angry customer complaining about a preference is `low` urgency and
`angry` sentiment, and a model that conflates tone with severity fails there and
nowhere else. A dataset every model passes tells you nothing.

```bash
npm run eval:quick -- --record   # baseline
npm run eval:quick -- --gate     # regressions, named not counted
```

The gate compares **passing case ids**, not counts. 10/12 after a change is not
the same 10/12 as before if two cases swapped places.

## The injection corpus

Attacks against *your* policy. The interesting ones quote your own clause numbers
back at you and forge approval from your own staff.

At least one case must be marked `"benign": true`, and the runner refuses to
start without one. A gate that only counts blocked attacks gives a perfect score
to a service that refuses every message — which is the single easiest way to ship
a bad security control and never find out.

```bash
npm run eval:redteam   # 100% gate. a rate is the wrong shape for a breach.
```
