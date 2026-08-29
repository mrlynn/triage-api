---
name: Adapter request
about: Ask for support for a ticketing system this repo does not ship
labels: adapter
---

**Which system?**

**How does it deliver events?** Webhook, polling, something else. If webhooks:
does it sign the body, and with what header and scheme?

**Do you have an instance you can test against?** This is the deciding question.
A vendor adapter nobody has pointed at the vendor is a guess with types on it —
if you have access, an adapter PR from you will land far faster than a request.

**Have you tried `generic-webhook`?** Mapping fields inside the system you
already control is often faster and less brittle than a vendor adapter. If that
does not work for you, say why — it is useful signal.
