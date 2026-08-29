# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/mrlynn/triage-api/security/advisories/new).
Please do not open a public issue for anything exploitable.

Include what you did, what happened, and what you expected. A reproducing request
is worth more than a description.

## What is in scope

- A prompt injection that defeats the trust boundary and changes a classification
  or an action. Include the message; we will add it to the red-team corpus.
- Any path that lets an over-authority action survive `enforceAuthority`.
- A signature-verification bypass on `/v1/ingest/:source`.
- PII surviving redaction into a stored record, a log, or a model request.
- Any way to make a source accept an unsigned request.

## What is not

- The handbook is not secret. A model that quotes it is not leaking.
- The in-memory store loses data on restart and is per-instance. This is
  documented and warned about at boot.
- `API_TOKENS` being unset leaves `/v1/*` open. This is a documented default for
  local development, warned about at boot, and stated in the README.
- The model producing a wrong classification. That is an eval problem, and the
  eval set is how you fix it — issues welcome, but it is not a vulnerability.

## Notes for operators

- Set `API_TOKENS` before exposing the service anywhere.
- Set a distinct secret per ingest source. A source with no secret refuses all
  requests, which is intended — do not "temporarily" unset one.
- Use the MongoDB store in production. The memory store's rate limiting and
  idempotency do not work across replicas.
- Check `GET /readyz` reports `degraded_controls: []`. A deployment with no
  customer lookup cannot enforce the rolling refund ceiling.
- Sinks are opt-in and default to internal, non-customer-visible writes. Keep
  them that way unless you have a review process for what the model produces.
