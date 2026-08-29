## What and why

<!-- The "why" matters more here than in most repos: this codebase is meant to
be read. If your change fixes something subtle, say what the subtle thing was. -->

## Checks

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run pack:validate -- northwind` and `-- starter`

If you touched prompts, schemas, guardrails, or a pack — these cost money, so say
what they printed rather than just ticking the box:

- [ ] `npm run eval:quick -- --gate`
- [ ] `npm run eval:redteam`
- [ ] `npm run smoke`

## For a new adapter

- [ ] Passes `src/adapters/conformance.ts` via `test/adapters.test.ts`
- [ ] Config variant added to `define-config.ts` and wired in `runtime.ts`
- [ ] Env vars documented in `.env.example`
- [ ] Tested against the real service — say how
