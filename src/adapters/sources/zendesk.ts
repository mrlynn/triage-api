/**
 * Zendesk as a ticket source.
 *
 * Configured in Zendesk under Admin Center -> Apps and integrations -> Webhooks,
 * with a trigger that fires on ticket creation and a JSON body you control. The
 * template that matches this adapter:
 *
 *   {
 *     "ticket_id": "{{ticket.id}}",
 *     "subject": "{{ticket.title}}",
 *     "description": "{{ticket.description}}",
 *     "requester_email": "{{ticket.requester.email}}",
 *     "via": "{{ticket.via}}",
 *     "url": "{{ticket.link}}"
 *   }
 *
 * A NOTE ON WHY THIS IS SHAPED LOOSELY: Zendesk's payload is whatever your
 * trigger template says it is, and every installation customises it. So this
 * reads a handful of plausible field names rather than asserting one schema. If
 * yours differs, either change the template above or — better — use the
 * generic-webhook source and do the mapping in Zendesk, where you can see it.
 */
import { createHmac } from "node:crypto";
import type { CanonicalTicket } from "../../schemas.js";
import type { TicketSource, VerifyResult } from "../types.js";
import { safeEqual } from "./generic-webhook.js";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export function zendeskSource(secretEnv: string): TicketSource {
  return {
    name: "zendesk",

    async verify(headers: Headers, rawBody: string): Promise<VerifyResult> {
      const secret = process.env[secretEnv];
      if (!secret) return { ok: false, reason: `${secretEnv} is not set; this source refuses all requests` };

      const provided = headers.get("x-zendesk-webhook-signature");
      const timestamp = headers.get("x-zendesk-webhook-signature-timestamp");
      if (!provided || !timestamp) {
        return { ok: false, reason: "missing X-Zendesk-Webhook-Signature[-Timestamp]" };
      }

      // Zendesk signs timestamp + body and base64-encodes the digest.
      const expected = createHmac("sha256", secret).update(timestamp + rawBody).digest("base64");
      return safeEqual(provided, expected) ? { ok: true } : { ok: false, reason: "signature mismatch" };
    },

    normalize(payload: unknown): CanonicalTicket[] {
      // See the note in github-issues.ts: malformed input is normal traffic.
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
      const p = payload as Record<string, unknown>;
      const nested = p.detail ?? p.ticket;
      const detail = (typeof nested === "object" && nested !== null ? nested : p) as Record<string, unknown>;

      const body = str(detail.description) ?? str(detail.body) ?? str(detail.comment);
      const subject = str(detail.subject) ?? str(detail.title);
      if (!body && !subject) return [];

      const id = str(detail.ticket_id) ?? str(detail.id);
      const message = [subject, body].filter(Boolean).join("\n\n");

      return [{
        message: message.slice(0, 20_000),
        subject: subject?.slice(0, 500),
        customer_email: str(detail.requester_email) ?? str(detail.email),
        channel: "email",
        external_id: id ? `zendesk:${id}` : undefined,
        external_url: str(detail.url) ?? str(detail.link),
        source: "zendesk",
      }];
    },
  };
}
