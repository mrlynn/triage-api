/**
 * Writes the decision back to a GitHub issue: labels, and an optional comment.
 *
 * A GitHub issue comment is PUBLIC on a public repo. That is fine for a repo
 * doing support in the open and wrong for anything else, so `comment` is
 * configurable and the body is written to be read by a maintainer rather than
 * by the person who filed the issue: it says what the classifier thought and
 * how confident it was, and it does not pretend to answer anyone.
 */
import type { Decision, TicketSink } from "../types.js";

function issueNumber(externalId: string | undefined): number | null {
  const m = externalId?.match(/#(\d+)$/);
  return m?.[1] ? Number(m[1]) : null;
}

export function githubIssuesSink(opts: {
  tokenEnv: string; repoEnv: string; labelPrefix: string; comment: boolean;
}): TicketSink {
  return {
    name: "github-issues",
    capabilities: { comment: opts.comment, tag: true, setField: false, assign: false },

    async publish(decision: Decision) {
      const token = process.env[opts.tokenEnv];
      const repo = process.env[opts.repoEnv];
      if (!token || !repo) {
        return { ok: false, actions: [], error: `${opts.tokenEnv} and ${opts.repoEnv} must both be set` };
      }
      const num = issueNumber(decision.ticket.external_id);
      if (num === null) {
        return { ok: false, actions: [], error: `ticket has no GitHub issue number (external_id: ${decision.ticket.external_id})` };
      }

      const api = `https://api.github.com/repos/${repo}/issues/${num}`;
      const headers = {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      };
      const actions: string[] = [];

      try {
        const labels = [
          `${opts.labelPrefix}${decision.triage.category}`,
          `${opts.labelPrefix}${decision.triage.urgency}`,
        ];
        if (decision.triage.requires_human) labels.push(`${opts.labelPrefix}needs-human`);

        const lr = await fetch(`${api}/labels`, {
          method: "POST", headers, body: JSON.stringify({ labels }),
          signal: AbortSignal.timeout(8_000),
        });
        if (lr.ok) actions.push(`labelled: ${labels.join(", ")}`);
        else actions.push(`label failed: ${lr.status}`);

        if (opts.comment) {
          const flags = decision.violations.length > 0
            ? `\n\n**Guardrail findings:** ${decision.violations.join(", ")}`
            : "";
          const body =
            `**Automated triage** — ${decision.triage.category} / ${decision.triage.urgency} ` +
            `(confidence ${decision.triage.confidence.toFixed(2)})\n\n` +
            `${decision.triage.summary}\n\n` +
            (decision.triage.requires_human
              ? `Needs a human: ${decision.triage.escalation_reason ?? "unspecified"}\n`
              : "") +
            flags +
            `\n\n<sub>Classification only — no action has been taken. Model: ${decision.model}.</sub>`;

          const cr = await fetch(`${api}/comments`, {
            method: "POST", headers, body: JSON.stringify({ body }),
            signal: AbortSignal.timeout(8_000),
          });
          if (cr.ok) actions.push("commented"); else actions.push(`comment failed: ${cr.status}`);
        }

        return { ok: true, actions };
      } catch (e) {
        return { ok: false, actions, error: (e as Error).message };
      }
    },
  };
}
