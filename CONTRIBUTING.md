# Contributing

## What is most welcome

**Adapters.** Freshdesk, Intercom, Front, Jira Service Management, Linear,
HubSpot, Salesforce, Postgres, Redis. The interfaces are stable and the
conformance suite is the spec.

**Packs.** A pack for a domain that is not e-commerce — SaaS support, internal
IT, healthcare intake — teaches something the Northwind fixture cannot.

**Better arguments.** If a design decision here is wrong, the comment explaining
it is the thing to argue with. Several comments in this repo document being wrong
the first time; that is the house style, not an embarrassment.

## Ground rules

**Every adapter passes `src/adapters/conformance.ts`.** Add it to
`test/adapters.test.ts`. If a check seems pedantic, read its comment — each one
is a failure mode someone shipped.

**Guardrails do not become optional.** A PR that adds a flag to skip authority
re-derivation, disable escaping, or turn off the red-team gate will not be merged.
Configure the *limits*, not the *existence*.

**Offline tests stay offline.** `npm test` must run with no API key, on a fork,
in CI. Model-backed checks live in `evals/` and `scripts/smoke.ts`, and CI skips
them rather than failing when no key is available.

**Explain the why in the file.** This repository is meant to be read. A comment
that says what the code does is redundant with the code; a comment that says why
this shape and not the obvious one is the reason anyone forked it. If your change
fixes something subtle, say what the subtle thing was.

**Sinks default to internal.** Anything that can reach a customer is an
explicitly named option, defaulting to off, with a comment saying why.

## Before you open a PR

```bash
npm run typecheck
npm test
npm run pack:validate -- northwind
npm run pack:validate -- starter
```

If you touched prompts, schemas, or a pack, also run the paid checks and say what
they printed:

```bash
npm run eval:quick -- --gate
npm run eval:redteam
npm run smoke
```

## Adding a shipped adapter

1. Implement it in `src/adapters/{sources,sinks,stores,data}/`.
2. Add its config variant to `src/define-config.ts` and wire it in
   `src/runtime.ts`.
3. Add its env vars to `.env.example`, commented out.
4. Add conformance coverage to `test/adapters.test.ts`.
5. Say in the PR how you tested it against the real service — a vendor adapter
   nobody has pointed at the vendor is a guess with types on it.

## Code of conduct

Be decent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
