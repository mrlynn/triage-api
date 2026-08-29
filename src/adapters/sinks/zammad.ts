/**
 * Writes the decision back to a Zammad ticket: priority, group, tags, and an
 * internal note.
 *
 * THE SHAPE IS DIFFERENT FROM THE CHATWOOT SINK, and the difference is worth
 * understanding rather than smoothing over. Zammad takes priority, group and a
 * new article in a SINGLE `PUT /api/v1/tickets/{id}`. That is one round trip
 * instead of four, and it is transactional — but it also means a bad priority
 * name fails the whole call and takes the note down with it. See the retry
 * below, which exists precisely for that.
 *
 * THREE THINGS TO GET RIGHT:
 *
 * 1. `internal: true` ON THE ARTICLE. A Zammad article with `internal: false`
 *    is visible to the customer in the portal, and depending on type it is sent
 *    to them. We write `type: "note", internal: true`. The option that changes
 *    it is named `publicNote`, it defaults to false, and this comment exists so
 *    that if you turn it on, you did it on purpose.
 *
 * 2. ZAMMAD LOOKS ASSOCIATIONS UP BY NAME AND 422s WHEN IT CANNOT.
 *    `Ticket.association_name_to_id_convert` resolves `priority: "3 high"` and
 *    `group: "Support"` against the database and raises UnprocessableContent
 *    for anything it does not find. Passing names rather than numeric ids keeps
 *    your config readable and portable across instances; the cost is that a
 *    typo is a 422 on every single ticket. Loud, at least — but it would take
 *    the note with it, so a failed update is retried with the article alone.
 *
 * 3. TAGS ADD, THEY DO NOT REPLACE. `POST /api/v1/tags/add` calls `Tag.tag_add`
 *    for one tag at a time. This is the OPPOSITE of Chatwoot's label endpoint,
 *    which replaces the whole list — so this sink needs no read-before-write,
 *    and a sink for the next helpdesk needs neither assumption carried over.
 *    Check what the endpoint does; do not infer it from the last one.
 *
 * Auth is `Authorization: Token token=<token>` from a Zammad access token. Two
 * things have to be true for it to work at all: the instance setting
 * "API token access" must be enabled, and the token's user needs agent rights
 * on the groups you are writing to. Issue it to a dedicated bot user — every
 * write below is attributed to whoever owns it, and it shows up in the ticket
 * history under their name.
 */
import type { Decision, TicketSink } from "../types.js";

export interface ZammadSinkOptions {
  baseUrlEnv: string;
  tokenEnv: string;
  note: boolean;
  /** See the header. Leave this false. */
  publicNote: boolean;
  tag: boolean;
  tagPrefix: string;
  /**
   * Pack urgency -> Zammad priority NAME. A stock Zammad ships exactly three:
   * "1 low", "2 normal", "3 high". The default below maps the shipped packs'
   * four urgencies onto those, which is why `urgent` and `high` both land on
   * "3 high" — inventing a fourth priority in someone's instance is not this
   * adapter's business. Add one in Zammad and remap if you want the split.
   */
  priorityMap: Record<string, string>;
  /** Pack category -> Zammad group NAME. Unmapped categories are left alone. */
  groupMap: Record<string, string>;
  /** Wins over groupMap when the decision sets requires_human. */
  escalationGroup?: string;
}

/** `zammad:<ticket_id>` or `zammad:<ticket_id>:a<article_id>`. */
function ticketId(externalId: string | undefined): string | null {
  const m = externalId?.match(/^zammad:([^:]+)(?::a.+)?$/);
  return m?.[1] ?? null;
}

/**
 * Zammad splits tag input on commas, so a comma in a tag silently becomes two
 * tags. Whitespace is legal in a Zammad tag but makes for miserable filtering.
 */
function safeTag(prefix: string, value: string): string {
  return `${prefix}${value}`.replace(/[,\s]+/g, "-").replace(/-{2,}/g, "-").slice(0, 100);
}

export function zammadSink(opts: ZammadSinkOptions): TicketSink {
  const canAssign = Object.keys(opts.groupMap).length > 0 || opts.escalationGroup !== undefined;

  return {
    name: "zammad",
    capabilities: {
      comment: opts.note,
      tag: opts.tag,
      setField: Object.keys(opts.priorityMap).length > 0,
      assign: canAssign,
    },

    async publish(decision: Decision) {
      const base = process.env[opts.baseUrlEnv];
      const token = process.env[opts.tokenEnv];
      if (!base || !token) {
        return { ok: false, actions: [], error: `${opts.baseUrlEnv} and ${opts.tokenEnv} must both be set` };
      }

      const tid = ticketId(decision.ticket.external_id);
      if (!tid) {
        return {
          ok: false,
          actions: [],
          error: `ticket has no Zammad ticket id (external_id: ${decision.ticket.external_id})`,
        };
      }

      let origin: string;
      try {
        origin = new URL(base).origin;
      } catch {
        return { ok: false, actions: [], error: `${opts.baseUrlEnv} is not a valid URL` };
      }

      const headers = {
        authorization: `Token token=${token}`,
        "content-type": "application/json",
      };
      const actions: string[] = [];
      const t = decision.triage;

      const call = async (url: string, init: RequestInit): Promise<Response | null> => {
        try {
          return await fetch(url, { ...init, headers, signal: AbortSignal.timeout(8_000) });
        } catch (e) {
          actions.push(`${init.method ?? "GET"} failed: ${(e as Error).message}`);
          return null;
        }
      };

      try {
        // --- one PUT carries priority, group and the note --------------------
        const article = opts.note
          ? {
              subject: `Automated triage — ${t.category} / ${t.urgency}`,
              body:
                `Automated triage — ${t.category} / ${t.urgency} (confidence ${t.confidence.toFixed(2)})\n` +
                `${t.summary}\n` +
                (t.requires_human ? `Needs a human: ${t.escalation_reason ?? "unspecified"}\n` : "") +
                (decision.redactions.length > 0
                  ? `${decision.redactions.length} identifier(s) redacted before processing.\n`
                  : "") +
                (decision.violations.length > 0
                  ? `Guardrail findings: ${decision.violations.join(", ")}\n`
                  : "") +
                `\nClassification only — no action taken. Model: ${decision.model}.`,
              type: "note",
              // The single most consequential boolean in this file.
              internal: !opts.publicNote,
              content_type: "text/plain",
            }
          : undefined;

        const priority = opts.priorityMap[t.urgency];
        const group = t.requires_human && opts.escalationGroup !== undefined
          ? opts.escalationGroup
          : opts.groupMap[t.category];

        const fields: Record<string, unknown> = {};
        if (priority) fields.priority = priority;
        if (group) fields.group = group;

        const url = `${origin}/api/v1/tickets/${tid}`;
        const put = async (body: Record<string, unknown>) =>
          call(url, { method: "PUT", body: JSON.stringify(body) });

        if (article || Object.keys(fields).length > 0) {
          const res = await put({ ...fields, ...(article ? { article } : {}) });

          if (res?.ok) {
            if (priority) actions.push(`priority: ${priority}`);
            if (group) actions.push(`group: ${group}`);
            if (article) actions.push(opts.publicNote ? "note added (PUBLIC — customer-visible)" : "internal note added");
          } else if (res) {
            // A 422 here is almost always a priority or group name that does
            // not exist in this instance. That is a config bug worth surfacing
            // loudly — but it must not also swallow the triage note, which is
            // the part a human was going to read. Retry with the article alone.
            actions.push(`ticket update failed: ${res.status} (check priorityMap/groupMap names exist in Zammad)`);
            if (article && Object.keys(fields).length > 0) {
              const retry = await put({ article });
              if (retry?.ok) actions.push("internal note added (retried without field updates)");
              else if (retry) actions.push(`note retry failed: ${retry.status}`);
            }
          }
        }

        // --- tags, one call each ---------------------------------------------
        if (opts.tag) {
          const tags = [
            safeTag(opts.tagPrefix, t.category),
            safeTag(opts.tagPrefix, t.urgency),
            ...(t.requires_human ? [safeTag(opts.tagPrefix, "needs-human")] : []),
          ];
          const added: string[] = [];
          for (const item of tags) {
            const q = new URLSearchParams({ object: "Ticket", o_id: tid, item });
            const res = await call(`${origin}/api/v1/tags/add?${q}`, { method: "POST" });
            if (res?.ok) added.push(item);
            else if (res) {
              // 403 here means Zammad's "tag_new" setting is off and this tag
              // does not exist yet. Create your triage tags once under
              // Manage -> Tags, or turn the setting on.
              actions.push(`tag "${item}" failed: ${res.status}${res.status === 403 ? " (tag does not exist and tag creation is disabled)" : ""}`);
            }
          }
          if (added.length > 0) actions.push(`tagged: ${added.join(", ")}`);
        }

        return { ok: true, actions };
      } catch (e) {
        return { ok: false, actions, error: (e as Error).message };
      }
    },
  };
}
