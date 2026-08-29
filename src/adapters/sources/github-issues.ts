/**
 * GitHub Issues as a ticket source.
 *
 * WHY THIS ONE SHIPS: every adapter in a reference repo should be testable by
 * the person evaluating it, in the next ten minutes, without a sales call. A
 * GitHub repo costs nothing and a webhook takes two minutes to point at a
 * tunnel. That makes this the adapter you use to convince yourself the whole
 * pipeline works before you go anywhere near your real helpdesk.
 *
 * It is also a real use case on its own — plenty of teams run support out of
 * issues in a public repo.
 */
import { createHmac } from "node:crypto";
import type { CanonicalTicket } from "../../schemas.js";
import type { TicketSource, VerifyResult } from "../types.js";
import { safeEqual } from "./generic-webhook.js";

interface GitHubIssuePayload {
  action?: string;
  issue?: { number: number; title: string; body: string | null; html_url: string; user?: { login: string } };
  repository?: { full_name: string };
  sender?: { type?: string };
}

export function githubIssuesSource(secretEnv: string): TicketSource {
  return {
    name: "github-issues",

    async verify(headers: Headers, rawBody: string): Promise<VerifyResult> {
      const secret = process.env[secretEnv];
      if (!secret) return { ok: false, reason: `${secretEnv} is not set; this source refuses all requests` };

      const provided = headers.get("x-hub-signature-256");
      if (!provided) return { ok: false, reason: "missing X-Hub-Signature-256" };

      const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
      return safeEqual(provided, expected) ? { ok: true } : { ok: false, reason: "signature mismatch" };
    },

    normalize(payload: unknown): CanonicalTicket[] {
      // A webhook sender you do not control will eventually send you null, an
      // array, or a string. Normalize must return [] for all of it — a throw
      // here becomes a 500, which becomes a retry, which becomes a retry storm.
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
      const p = payload as GitHubIssuePayload;

      // Most webhook traffic is events you do not want. Returning [] is the
      // normal case, not an error — a label change is not a new ticket, and
      // re-triaging on every edit burns money for no signal.
      if (p.action !== "opened" || !p.issue) return [];

      // A bot opening an issue is usually your own automation. Triaging it
      // produces a decision nobody reads and, if a sink is wired, a comment
      // that can trigger the bot again.
      if (p.sender?.type === "Bot") return [];

      const body = (p.issue.body ?? "").trim();
      const message = body.length > 0 ? `${p.issue.title}\n\n${body}` : p.issue.title;

      return [{
        message: message.slice(0, 20_000),
        subject: p.issue.title.slice(0, 500),
        channel: "web",
        external_id: `github:${p.repository?.full_name ?? "unknown"}#${p.issue.number}`,
        external_url: p.issue.html_url,
        source: "github-issues",
      }];
    },
  };
}
