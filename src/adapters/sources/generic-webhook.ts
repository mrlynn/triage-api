/**
 * The universal source: you POST the canonical shape, signed.
 *
 * WHY THIS IS THE ONE TO REACH FOR FIRST. Most companies do not run stock
 * Zendesk — they run Zendesk plus an internal service, or a homegrown ticket
 * table, or three systems that a workflow tool stitches together. Writing a
 * six-line transform in the system you already control is faster, more
 * testable, and less brittle than adopting a vendor adapter that has to guess
 * at your custom fields.
 *
 * So: send `{message, customer_email?, subject?, external_id?, external_url?}`
 * with an HMAC-SHA256 of the raw body in `X-Triage-Signature`, and you are done.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { TicketInput, type CanonicalTicket } from "../../schemas.js";
import type { TicketSource, VerifyResult } from "../types.js";

/**
 * Constant-time comparison.
 *
 * `a === b` on a signature leaks its prefix through timing. This is textbook,
 * it is two lines, and it is left out of most webhook examples on the internet.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function genericWebhookSource(secretEnv: string): TicketSource {
  return {
    name: "generic-webhook",

    async verify(headers: Headers, rawBody: string): Promise<VerifyResult> {
      const secret = process.env[secretEnv];
      if (!secret) {
        // FAIL CLOSED. "No secret configured, so skip the check" turns a
        // missing environment variable into an open ingest endpoint, and the
        // person who deployed it never finds out.
        return { ok: false, reason: `${secretEnv} is not set; this source refuses all requests` };
      }
      const provided = headers.get("x-triage-signature");
      if (!provided) return { ok: false, reason: "missing X-Triage-Signature" };

      const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
      return safeEqual(provided.replace(/^sha256=/, ""), expected)
        ? { ok: true }
        : { ok: false, reason: "signature mismatch" };
    },

    normalize(payload: unknown): CanonicalTicket[] {
      const parsed = TicketInput.safeParse(payload);
      if (!parsed.success) return [];
      return [{ ...parsed.data, source: "generic-webhook" }];
    },
  };
}
