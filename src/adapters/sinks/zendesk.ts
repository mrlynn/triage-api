/**
 * Writes the decision back to a Zendesk ticket.
 *
 * THE ONE THING TO GET RIGHT HERE is `public: false`. A Zendesk comment with
 * `public: true` is emailed to the customer. A model's prose reaching a human
 * being with no review is a different product with a different risk profile,
 * and it is not what this repository is for — so the default is an INTERNAL
 * NOTE, the config flag that changes it is named `publicComment` so nobody sets
 * it by accident, and this comment exists so that if you do set it, you did it
 * on purpose.
 *
 * Auth is the API-token scheme: base64("<email>/token:<api_token>").
 */
import type { Decision, TicketSink } from "../types.js";

function ticketId(externalId: string | undefined): string | null {
  const m = externalId?.match(/^zendesk:(.+)$/);
  return m?.[1] ?? null;
}

export function zendeskSink(opts: {
  subdomainEnv: string; emailEnv: string; tokenEnv: string;
  publicComment: boolean; tag: boolean; customFieldId?: number;
}): TicketSink {
  return {
    name: "zendesk",
    capabilities: { comment: true, tag: opts.tag, setField: opts.customFieldId !== undefined, assign: false },

    async publish(decision: Decision) {
      const subdomain = process.env[opts.subdomainEnv];
      const email = process.env[opts.emailEnv];
      const token = process.env[opts.tokenEnv];
      if (!subdomain || !email || !token) {
        return {
          ok: false, actions: [],
          error: `${opts.subdomainEnv}, ${opts.emailEnv} and ${opts.tokenEnv} must all be set`,
        };
      }
      const id = ticketId(decision.ticket.external_id);
      if (!id) {
        return { ok: false, actions: [], error: `ticket has no Zendesk id (external_id: ${decision.ticket.external_id})` };
      }

      const t = decision.triage;
      const flags = decision.violations.length > 0
        ? `\nGuardrail findings: ${decision.violations.join(", ")}`
        : "";
      const body =
        `Automated triage — ${t.category} / ${t.urgency} (confidence ${t.confidence.toFixed(2)})\n` +
        `${t.summary}\n` +
        (t.requires_human ? `Needs a human: ${t.escalation_reason ?? "unspecified"}\n` : "") +
        (decision.redactions.length > 0 ? `${decision.redactions.length} identifier(s) redacted before processing.\n` : "") +
        flags +
        `\nClassification only — no action taken. Model: ${decision.model}.`;

      const ticket: Record<string, unknown> = {
        comment: { body, public: opts.publicComment },
      };
      const actions: string[] = [opts.publicComment ? "commented (PUBLIC)" : "commented (internal note)"];

      if (opts.tag) {
        ticket.additional_tags = [`triage_${t.category}`, `triage_${t.urgency}`]
          .concat(t.requires_human ? ["triage_needs_human"] : []);
        actions.push("tagged");
      }
      if (opts.customFieldId !== undefined) {
        ticket.custom_fields = [{ id: opts.customFieldId, value: t.category }];
        actions.push(`set custom field ${opts.customFieldId}`);
      }

      try {
        const res = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${id}.json`, {
          method: "PUT",
          headers: {
            authorization: "Basic " + Buffer.from(`${email}/token:${token}`).toString("base64"),
            "content-type": "application/json",
          },
          body: JSON.stringify({ ticket }),
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return { ok: false, actions: [], error: `${res.status} ${res.statusText}` };
        return { ok: true, actions };
      } catch (e) {
        return { ok: false, actions: [], error: (e as Error).message };
      }
    },
  };
}
