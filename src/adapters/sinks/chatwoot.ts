/**
 * Writes the decision back to a Chatwoot conversation: labels, priority, team
 * assignment, and a private note.
 *
 * THREE THINGS TO GET RIGHT HERE, all of them verified against Chatwoot's own
 * source rather than inferred from a happy-path example.
 *
 * 1. `private: true` ON THE NOTE. A Chatwoot message with `private: false` is
 *    DELIVERED TO THE CUSTOMER on whatever channel the conversation came in on
 *    — email, WhatsApp, live chat. A model's prose reaching a human being with
 *    no review is a different product with a different risk profile, and it is
 *    not what this repository is for. The flag that changes it is named
 *    `publicReply`, it defaults to false, and this comment exists so that if
 *    you turn it on, you did it on purpose.
 *
 * 2. THE LABEL ENDPOINT REPLACES, IT DOES NOT APPEND. `POST .../labels` calls
 *    `update_labels` in Chatwoot, which sets the whole list. Post
 *    `["triage-billing"]` to a conversation an agent had labelled `vip` and the
 *    `vip` label is gone, silently, with a 200. So we GET the current labels
 *    first and post the union. That read costs a round trip and it is not
 *    optional — an integration that quietly deletes human work is the fastest
 *    way to get itself switched off.
 *
 * 3. LABEL TITLES ARE A RESTRICTED CHARSET. Chatwoot validates label titles
 *    against unicode letters, numbers, hyphen and underscore — no slashes, no
 *    spaces. The GitHub sink's `triage/` prefix is a 422 here, so the default
 *    prefix is `triage-` and pack values are sanitized on the way out.
 *
 * Auth is a plain `api_access_token` header, from Profile Settings -> Access
 * Token. Scope it to a bot/automation user, not to a human agent's account:
 * every write below is attributed to whoever owns the token.
 */
import type { Decision, TicketSink } from "../types.js";

/** Chatwoot's conversation priority enum. `none` clears it. */
export type ChatwootPriority = "urgent" | "high" | "medium" | "low" | "none";

export interface ChatwootSinkOptions {
  baseUrlEnv: string;
  tokenEnv: string;
  /** Fallback only. The account id in the ticket's external_id wins. */
  accountIdEnv: string;
  /** Post a note at all. */
  note: boolean;
  /** See the header. Leave this false. */
  publicReply: boolean;
  label: boolean;
  labelPrefix: string;
  /**
   * Pack urgency -> Chatwoot priority. Empty means "never touch priority",
   * which is the honest default for a pack whose urgency vocabulary this repo
   * has never seen. The shipped packs use low/normal/high/urgent, so
   * define-config seeds a map for those.
   */
  priorityMap: Record<string, ChatwootPriority>;
  /** Pack category -> Chatwoot team id. Unmapped categories are not assigned. */
  teamMap: Record<string, number>;
  /** Overrides teamMap when the decision requires a human. */
  escalationTeamId?: number;
}

/**
 * `chatwoot:<account>:<conversation>` or `chatwoot:<account>:<conversation>:m<id>`.
 * The conversation segment is Chatwoot's DISPLAY id, which is what every
 * conversation endpoint takes as its path parameter.
 */
function parseExternalId(externalId: string | undefined): { account: string; conversation: string } | null {
  const m = externalId?.match(/^chatwoot:([^:]+):([^:]+)(?::m.+)?$/);
  return m?.[1] && m[2] ? { account: m[1], conversation: m[2] } : null;
}

/** Chatwoot allows unicode letters, numbers, `-` and `_` in a label title. */
function safeLabel(prefix: string, value: string): string {
  return `${prefix}${value}`.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-{2,}/g, "-").slice(0, 100);
}

export function chatwootSink(opts: ChatwootSinkOptions): TicketSink {
  const canAssign = Object.keys(opts.teamMap).length > 0 || opts.escalationTeamId !== undefined;

  return {
    name: "chatwoot",
    capabilities: {
      comment: opts.note,
      tag: opts.label,
      setField: Object.keys(opts.priorityMap).length > 0,
      assign: canAssign,
    },

    async publish(decision: Decision) {
      const base = process.env[opts.baseUrlEnv];
      const token = process.env[opts.tokenEnv];
      if (!base || !token) {
        return { ok: false, actions: [], error: `${opts.baseUrlEnv} and ${opts.tokenEnv} must both be set` };
      }

      const parsed = parseExternalId(decision.ticket.external_id);
      const account = parsed?.account ?? process.env[opts.accountIdEnv];
      if (!parsed || !account) {
        return {
          ok: false,
          actions: [],
          error: `ticket has no Chatwoot conversation id (external_id: ${decision.ticket.external_id})`,
        };
      }

      let root: string;
      try {
        root = new URL(`/api/v1/accounts/${account}/conversations/${parsed.conversation}`, base).toString();
      } catch {
        return { ok: false, actions: [], error: `${opts.baseUrlEnv} is not a valid URL` };
      }

      const headers = { api_access_token: token, "content-type": "application/json" };
      const actions: string[] = [];
      const t = decision.triage;

      // Every call goes through here so that one dead endpoint cannot take the
      // whole publish down, and so a sink failure stays a logged string rather
      // than an exception that costs us a decision we already paid for.
      const call = async (path: string, init: RequestInit): Promise<Response | null> => {
        try {
          return await fetch(`${root}${path}`, { ...init, headers, signal: AbortSignal.timeout(8_000) });
        } catch (e) {
          actions.push(`${path || "/"} failed: ${(e as Error).message}`);
          return null;
        }
      };

      try {
        if (opts.label) {
          const wanted = [
            safeLabel(opts.labelPrefix, t.category),
            safeLabel(opts.labelPrefix, t.urgency),
            ...(t.requires_human ? [safeLabel(opts.labelPrefix, "needs-human")] : []),
          ];

          // READ BEFORE WRITE. See note 2 in the header: this endpoint replaces
          // the label list wholesale. If the read fails we do NOT fall back to
          // posting just our own labels — that would delete the agent's. We
          // skip the write and say so.
          const current = await call("/labels", { method: "GET" });
          if (current?.ok) {
            const body = (await current.json().catch(() => null)) as { payload?: unknown } | null;
            const existing = Array.isArray(body?.payload) ? body.payload.filter((x): x is string => typeof x === "string") : [];
            const merged = [...new Set([...existing, ...wanted])];

            const res = await call("/labels", { method: "POST", body: JSON.stringify({ labels: merged }) });
            if (res?.ok) actions.push(`labelled: ${wanted.join(", ")}`);
            else if (res) actions.push(`label write failed: ${res.status}`);
          } else if (current) {
            actions.push(`label read failed: ${current.status} — labels left untouched rather than overwritten`);
          }
        }

        const priority = opts.priorityMap[t.urgency];
        if (priority) {
          const res = await call("/toggle_priority", { method: "POST", body: JSON.stringify({ priority }) });
          if (res?.ok) actions.push(`priority: ${priority}`);
          else if (res) actions.push(`priority failed: ${res.status}`);
        }

        const teamId = t.requires_human && opts.escalationTeamId !== undefined
          ? opts.escalationTeamId
          : opts.teamMap[t.category];
        if (teamId !== undefined) {
          const res = await call("/assignments", { method: "POST", body: JSON.stringify({ team_id: teamId }) });
          if (res?.ok) actions.push(`assigned to team ${teamId}`);
          else if (res) actions.push(`assignment failed: ${res.status}`);
        }

        if (opts.note) {
          const flags = decision.violations.length > 0
            ? `\nGuardrail findings: ${decision.violations.join(", ")}`
            : "";
          const content =
            `Automated triage — ${t.category} / ${t.urgency} (confidence ${t.confidence.toFixed(2)})\n` +
            `${t.summary}\n` +
            (t.requires_human ? `Needs a human: ${t.escalation_reason ?? "unspecified"}\n` : "") +
            (decision.redactions.length > 0
              ? `${decision.redactions.length} identifier(s) redacted before processing.\n`
              : "") +
            flags +
            `\nClassification only — no action taken. Model: ${decision.model}.`;

          const res = await call("/messages", {
            method: "POST",
            body: JSON.stringify({
              content,
              message_type: "outgoing",
              // The single most consequential boolean in this file.
              private: !opts.publicReply,
            }),
          });
          if (res?.ok) actions.push(opts.publicReply ? "replied (PUBLIC — customer-visible)" : "private note added");
          else if (res) actions.push(`note failed: ${res.status}`);
        }

        return { ok: true, actions };
      } catch (e) {
        // Belt and braces. `call` already swallows fetch failures; this catches
        // anything else (a JSON serialization error, a URL edge case) so that
        // the contract "a sink never throws" holds without depending on my
        // having thought of every case above.
        return { ok: false, actions, error: (e as Error).message };
      }
    },
  };
}
