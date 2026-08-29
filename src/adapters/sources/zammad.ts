/**
 * Zammad as a ticket source.
 *
 * Zammad does not have a "webhook" you subscribe to events on. It has
 * **triggers**, and a webhook is one action a trigger can take. That is the
 * important structural difference from Chatwoot and it shapes this adapter:
 * the event filtering lives in Zammad's trigger conditions, where an operator
 * can see it and change it without a deploy, and this file only does what a
 * trigger cannot — reject the writes we made ourselves.
 *
 * Setup: Manage -> Webhook (create one, set a signature token), then
 * Manage -> Trigger with the condition **Action is created**, and the action
 * "Webhook -> <your webhook>". Leave the payload as the default; the custom
 * payload editor exists, but a mapping you can only read inside Zammad's admin
 * UI is a mapping nobody reviews.
 *
 * SIGNATURE SCHEME (verified against zammad/zammad lib/user_agent.rb):
 *
 *   X-Hub-Signature: sha1=<hex HMAC-SHA1 of the raw body>
 *
 * Two things about that. It is **SHA-1, not SHA-256** — Zammad uses GitHub's
 * original scheme, and HMAC-SHA1 is still sound as a MAC even though bare SHA-1
 * is not collision resistant, so this is a compatibility fact rather than a
 * finding. And the header is `X-Hub-Signature`, one character away from the
 * `X-Hub-Signature-256` the GitHub source in this repo reads. Wiring a Zammad
 * webhook to the GitHub source, or the reverse, fails closed with "missing
 * header" rather than accepting anything, which is the outcome you want from a
 * near-miss like that.
 *
 * The signature token is optional in Zammad's UI. Leave it empty and Zammad
 * sends the payload unsigned, and this source refuses every request.
 */
import { createHmac } from "node:crypto";
import type { CanonicalTicket, Ticket } from "../../schemas.js";
import type { TicketSource, VerifyResult } from "../types.js";
import { safeEqual } from "./generic-webhook.js";

export interface ZammadSourceOptions {
  secretEnv: string;
  /** Env var holding your Zammad origin, for the reviewer deep link. Optional. */
  baseUrlEnv: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function id(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return str(v);
}

/** Zammad article type -> our canonical channel. */
function channelFor(articleType: unknown): Ticket["channel"] {
  switch (str(articleType)) {
    case "email": return "email";
    case "phone": return "phone_transcript";
    case "web": return "web";
    case "chat": return "chat";
    default: return "email";
  }
}

/**
 * A deliberately minimal HTML-to-text pass.
 *
 * Zammad stores web-form and most email articles as `text/html`, so an adapter
 * that passes `body` straight through hands the model a wall of markup: it
 * costs tokens, it degrades classification, and every `<` in it is one more
 * thing the untrusted-input escaping in lib/untrusted.ts has to deal with.
 *
 * This is not a sanitizer and does not need to be — the output is treated as
 * untrusted text either way, and nothing here is ever rendered as HTML. It
 * exists to recover readable prose, so it drops script/style content entirely
 * and turns block boundaries into newlines rather than silently welding two
 * sentences together.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `Dana Smith <dana@example.com>` -> `dana@example.com`. */
function emailFrom(from: string | undefined): string | undefined {
  const m = from?.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/);
  return m?.[0];
}

export function zammadSource(opts: ZammadSourceOptions): TicketSource {
  return {
    name: "zammad",

    async verify(headers: Headers, rawBody: string): Promise<VerifyResult> {
      const secret = process.env[opts.secretEnv];
      if (!secret) {
        return { ok: false, reason: `${opts.secretEnv} is not set; this source refuses all requests` };
      }

      const provided = headers.get("x-hub-signature");
      if (!provided) {
        return {
          ok: false,
          reason: "missing X-Hub-Signature; the webhook has no signature token set in Zammad " +
            "(note: Zammad sends the SHA-1 header, not X-Hub-Signature-256)",
        };
      }

      const expected = "sha1=" + createHmac("sha1", secret).update(rawBody).digest("hex");
      return safeEqual(provided, expected) ? { ok: true } : { ok: false, reason: "signature mismatch" };
    },

    normalize(payload: unknown): CanonicalTicket[] {
      const p = obj(payload);
      if (!p) return [];

      const ticket = obj(p.ticket);
      const article = obj(p.article);
      const ticketId = id(ticket?.id);
      if (!ticket || !ticketId) return [];

      // THE LOOP GUARD, and the only event filtering this adapter does.
      //
      // A Zammad trigger fires on whatever conditions an operator gave it, and
      // this repo's Zammad sink adds an article of its own on every decision.
      // If that trigger is ever widened to "Action is updated" — and it will
      // be, by someone who wants follow-ups triaged — our own note comes back
      // as a new ticket, which produces another note, on every turn.
      //
      // `sender` is the string "Customer" | "Agent" | "System"; the sink writes
      // as the token's user, so never "Customer". `internal` is true on the
      // note it writes. Either check alone would hold; both are here because
      // the failure mode is a billed infinite loop rather than a wrong label.
      if (article) {
        if (str(article.sender) !== "Customer") return [];
        if (article.internal === true) return [];
      }

      const rawBody = str(article?.body);
      const body = rawBody && str(article?.content_type) === "text/html"
        ? htmlToText(rawBody)
        : rawBody;

      const subject = str(ticket.title);
      if (!body && !subject) return [];
      const message = [subject, body].filter(Boolean).join("\n\n");

      // `customer` is resolved to a full attribute hash by Zammad's webhook
      // payload builder, so the address is right there. `article.from` is the
      // fallback for a ticket whose customer record has no email on it.
      const customer = obj(ticket.customer);
      const base = process.env[opts.baseUrlEnv];

      let externalUrl: string | undefined;
      if (base) {
        try { externalUrl = new URL(`/#ticket/zoom/${ticketId}`, base).toString(); }
        catch { externalUrl = undefined; }
      }

      const articleId = id(article?.id);

      return [{
        message: message.slice(0, 20_000),
        subject: subject?.slice(0, 500),
        customer_email: str(customer?.email) ?? emailFrom(str(article?.from)),
        channel: channelFor(article?.type),
        // Article-scoped when we have one, so a follow-up on the same ticket is
        // a new thing to triage rather than a duplicate delivery of the first.
        // The ticket id stays the first segment: it is what the sink writes to,
        // and it is Zammad's internal id, NOT the human-facing ticket number.
        external_id: articleId ? `zammad:${ticketId}:a${articleId}` : `zammad:${ticketId}`,
        external_url: externalUrl,
        source: "zammad",
      }];
    },
  };
}
