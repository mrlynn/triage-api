/**
 * Posts the decision to a URL you own, signed the same way the inbound generic
 * source expects. The escape hatch for a homegrown ticket system.
 *
 * Signing the OUTBOUND call matters as much as verifying the inbound one. Your
 * receiver has to know this decision came from your triage service and not from
 * anyone who guessed the URL — and a URL is not a secret, it is in logs and
 * proxies and someone's shell history.
 */
import { createHmac } from "node:crypto";
import type { Decision, TicketSink } from "../types.js";

export function genericWebhookSink(urlEnv: string, secretEnv: string): TicketSink {
  return {
    name: "generic-webhook",
    capabilities: { comment: false, tag: false, setField: false, assign: false },

    async publish(decision: Decision) {
      const url = process.env[urlEnv];
      const secret = process.env[secretEnv];
      if (!url) return { ok: false, actions: [], error: `${urlEnv} is not set` };

      const body = JSON.stringify(decision);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (secret) {
        headers["x-triage-signature"] = createHmac("sha256", secret).update(body).digest("hex");
      }

      try {
        const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(8_000) });
        if (!res.ok) return { ok: false, actions: [], error: `${res.status} ${res.statusText}` };
        return { ok: true, actions: [`posted decision to ${urlEnv}`] };
      } catch (e) {
        // Never throw. A sink outage is not a reason to lose a triage result
        // you have already paid for; the decision is stored regardless.
        return { ok: false, actions: [], error: (e as Error).message };
      }
    },
  };
}
