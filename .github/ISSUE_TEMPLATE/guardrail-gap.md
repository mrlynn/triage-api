---
name: Guardrail gap
about: A control that did not fire, or fired when it should not have
labels: guardrail
---

**What did you expect the guardrails to catch?**

**What actually happened?** Paste `meta.guardrails` from the response, or the
`/decisions/:id` page contents.

**Output of `GET /readyz`** — specifically `degraded_controls`. A control that
cannot run in your deployment reports itself; this is often the answer.

**Your pack's `authority` block.** The limits are yours, not ours.

If this is an injection that changed a classification or an action, please report
it as a [security advisory](https://github.com/mrlynn/triage-api/security/advisories/new)
instead — we will add it to the red-team corpus.
