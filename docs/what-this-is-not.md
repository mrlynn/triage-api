# What this is not

A reference implementation earns trust by being specific about its edges. Read
this before you plan around the repository.

## It is not a helpdesk

There is no inbox, no threading, no SLA engine, no customer identity, no
agent seat management, no reporting. The `/queue` page is a reviewer board
sufficient to prove the loop and demo it internally. It is not a product and it
will not become one — Zendesk, Jira Service Management, Freshdesk and the rest
have solved that problem, and this service is designed to sit beside them.

## It does not reply to customers

`POST /v1/draft` writes a reply. Nothing in this repository sends one. The
Zendesk sink posts an **internal note** by default; making it customer-visible is
a named config flag with a warning next to it, because a model's prose reaching a
human being with no review is a different product with a different risk profile.

If you want auto-reply, you are building something this repo can be a component
of. You are not configuring this repo.

## It is not multi-tenant

One pack, one policy, one set of authority limits per process. If you serve
several brands with different refund rules, run several deployments. The pack
system makes that cheap; making one process serve many packs would put a tenant
identifier in the cache prefix and in every guardrail path, and getting that
subtly wrong means applying one customer's refund ceiling to another's ticket.

## It is not a compliance artifact

Nothing here is certified against SOC 2, ISO 27001, HIPAA, PCI-DSS, or GDPR. The
redaction is a Luhn-checked card rule, a US SSN rule, and whatever patterns your
pack adds — it is a sensible default, not a DLP product, and it has not been
audited. The TTL retention is a real mechanism and is not a legal opinion about
your retention obligations.

What you *do* get toward a review: every control is named on `/readyz`, every
decision has a trace page showing which ones ran, and the guardrails have tests
you can point at. Start there, do not finish there.

## The evals are a starting shape, not a benchmark

`packs/northwind/evals/` is the course's fictional dataset. Its accuracy number
means nothing about your traffic. `packs/starter/evals/` is eight cases written
to demonstrate the file format. Neither is a substitute for labelling your own
tickets, and a deployment running on someone else's eval set has no evidence
about itself at all.

## The red-team corpus is a floor

Fourteen cases in the Northwind pack, eight in starter. Real adversaries are more
patient and more creative than a checked-in JSONL file. Passing this gate means
the known families are contained; it does not mean the system is secure. Add
cases every time you find one, especially ones that quote your own clause numbers
back at you.

## Cost projections are estimates

`/v1/estimate` runs the real tokenizer, so the token counts are exact. The dollar
figures come from a price table in `src/config.ts` that was correct when it was
written and will drift. Verify against <https://claude.com/pricing> before
quoting a number to anyone who will hold you to it.

## The in-memory store is not for production

It says so at boot. The queue vanishes on restart, and on more than one replica
your rate limits are per-replica and your idempotency check is a coin flip. It
exists so the first five minutes work.

## `search_policy` is not retrieval

It is a keyword scan over the handbook's `##` sections, and the whole handbook is
already in the cached prompt. The tool exists to make the model's reliance on a
specific clause **visible in the trace**, which is what citation verification and
a human reviewer both need. If your policy corpus is large enough to need real
retrieval, that is a genuine extension and the tool interface is the place to
put it.

## It is a starting point you own

This is distributed as a template, not a dependency. There is no upgrade path,
no semver contract, and no promise that a later version merges cleanly into your
fork. That is the trade: you can read all of it and change any of it.
