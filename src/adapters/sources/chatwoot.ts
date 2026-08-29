/**
 * Chatwoot as a ticket source.
 *
 * Configured in Chatwoot under Settings -> Integrations -> Webhooks, or via
 * `POST /api/v1/accounts/{account_id}/webhooks`. Set a **secret** on the
 * webhook; without one Chatwoot sends the payload unsigned and this adapter
 * refuses every request, which is the correct outcome and not a bug.
 *
 * SIGNATURE SCHEME (verified against chatwoot/chatwoot lib/webhooks/trigger.rb):
 *
 *   X-Chatwoot-Timestamp: <unix seconds>
 *   X-Chatwoot-Signature: sha256=<hex HMAC-SHA256 of "{timestamp}.{rawBody}">
 *
 * The timestamp is INSIDE the signed string, which is what makes it worth
 * checking for freshness: an attacker who captures a valid delivery cannot
 * change the timestamp without invalidating the signature, so refusing stale
 * timestamps refuses replays. Zendesk's scheme has the same property; this
 * adapter is the one that actually uses it, because Chatwoot is the connector
 * we expect people to run in the write path.
 *
 * WHICH EVENTS TO SUBSCRIBE TO — read this before you tick boxes in the UI.
 * Chatwoot fires `conversation_created` AND `message_created` for the opening
 * message of a conversation. Subscribe to both and you triage that message
 * twice, under two different external ids, so idempotency will not save you.
 * This adapter therefore accepts `conversation_created` only unless you
 * explicitly widen `events`, and it says so here rather than in a release note.
 */
import { createHmac } from "node:crypto";
import type { CanonicalTicket, Ticket } from "../../schemas.js";
import type { TicketSource, VerifyResult } from "../types.js";
import { safeEqual } from "./generic-webhook.js";

export type ChatwootEvent = "conversation_created" | "message_created";

export interface ChatwootSourceOptions {
  /** Env var holding the webhook secret configured in Chatwoot. */
  secretEnv: string;
  /**
   * Which events produce a ticket. See the header note: subscribing to both in
   * Chatwoot AND enabling both here double-triages every opening message.
   */
  events: readonly ChatwootEvent[];
  /**
   * Env var holding your Chatwoot base URL (`https://app.chatwoot.com`, or your
   * self-hosted origin). Only used to build a deep link for reviewers; when it
   * is unset the ticket simply carries no `external_url`.
   */
  baseUrlEnv: string;
  /**
   * How many seconds of clock skew to tolerate on X-Chatwoot-Timestamp.
   * Anything older is a replay or a badly wrong clock, and both should fail.
   */
  toleranceSeconds: number;
}

/** Chatwoot inbox channel_type -> our canonical channel. */
function channelFor(channelType: unknown): Ticket["channel"] {
  if (typeof channelType !== "string") return "chat";
  if (channelType.includes("Email")) return "email";
  if (channelType.includes("Voice")) return "phone_transcript";
  if (channelType.includes("Api")) return "api";
  if (channelType.includes("WebWidget")) return "chat";
  // Telegram, WhatsApp, SMS, Facebook, Instagram, Line, TikTok. All messaging.
  return "chat";
}

/**
 * Is this a message FROM the customer?
 *
 * THE TYPE OF THIS FIELD CHANGES DEPENDING ON WHERE YOU READ IT. In a
 * `message_created` payload the top-level `message_type` is the enum's string
 * form ("incoming"). In the `messages[]` array nested inside a conversation
 * payload it is `message_type_before_type_cast` — the raw integer, where
 * 0 = incoming, 1 = outgoing, 2 = activity, 3 = template. An adapter that
 * checks only for `"incoming"` silently drops every conversation_created event;
 * one that checks only for `0` silently accepts agent replies. Handle both.
 */
function isIncoming(m: Record<string, unknown>): boolean {
  const t = m.message_type;
  if (t === 0 || t === "0" || t === "incoming") return m.private !== true;
  return false;
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

/**
 * The dashboard URL a reviewer clicks. Built only when the base URL is a valid
 * absolute URL — `external_url` is validated as a URL downstream, and a
 * half-configured env var must not turn a good ticket into a rejected one.
 */
function deepLink(base: string | undefined, accountId: string, convId: string): string | undefined {
  if (!base) return undefined;
  try {
    return new URL(`/app/accounts/${accountId}/conversations/${convId}`, base).toString();
  } catch {
    return undefined;
  }
}

export function chatwootSource(opts: ChatwootSourceOptions): TicketSource {
  const wanted = new Set(opts.events);

  return {
    name: "chatwoot",

    async verify(headers: Headers, rawBody: string): Promise<VerifyResult> {
      const secret = process.env[opts.secretEnv];
      if (!secret) {
        // FAIL CLOSED. Chatwoot lets you save a webhook with no secret, so the
        // "it works without one" path is a real path a real person will take.
        return { ok: false, reason: `${opts.secretEnv} is not set; this source refuses all requests` };
      }

      const provided = headers.get("x-chatwoot-signature");
      const timestamp = headers.get("x-chatwoot-timestamp");
      if (!provided || !timestamp) {
        return {
          ok: false,
          reason: "missing X-Chatwoot-Signature[-Timestamp]; the webhook has no secret configured in Chatwoot",
        };
      }

      // Freshness first: it is integer arithmetic, and it lets us drop a replay
      // without doing HMAC over a body an attacker chose the size of.
      const ts = Number(timestamp);
      if (!Number.isFinite(ts)) return { ok: false, reason: "malformed X-Chatwoot-Timestamp" };
      const skew = Math.abs(Date.now() / 1000 - ts);
      if (skew > opts.toleranceSeconds) {
        return { ok: false, reason: `timestamp is ${Math.round(skew)}s out of tolerance (replay, or a wrong clock)` };
      }

      const expected = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
      return safeEqual(provided, expected) ? { ok: true } : { ok: false, reason: "signature mismatch" };
    },

    normalize(payload: unknown): CanonicalTicket[] {
      const p = obj(payload);
      if (!p) return [];

      const event = str(p.event);
      if (!event || !wanted.has(event as ChatwootEvent)) return [];

      const base = process.env[opts.baseUrlEnv];

      if (event === "conversation_created") {
        // `id` here is the conversation's DISPLAY id, which is also the path
        // segment every Chatwoot conversation API takes. The database primary
        // key never appears in the API and must not be used.
        const convId = id(p.id);
        const accountId = id(obj(p.account)?.id);
        if (!convId || !accountId) return [];

        const messages = Array.isArray(p.messages) ? p.messages : [];
        const first = messages.map(obj).find((m): m is Record<string, unknown> => Boolean(m) && isIncoming(m!));
        const body = str(first?.content);
        if (!body) return [];

        const sender = obj(obj(p.meta)?.sender);

        return [{
          message: body.slice(0, 20_000),
          customer_email: str(sender?.email),
          channel: channelFor(p.channel),
          external_id: `chatwoot:${accountId}:${convId}`,
          external_url: deepLink(base, accountId, convId),
          source: "chatwoot",
        }];
      }

      // message_created.
      //
      // The two filters below are also the LOOP GUARD. This repo's Chatwoot
      // sink writes its findings as `message_type: "outgoing", private: true`,
      // so both checks reject it independently. Without them a sink note
      // becomes a ticket becomes a sink note, and you find out from the bill.
      if (!isIncoming(p)) return [];

      const conversation = obj(p.conversation);
      const convId = id(conversation?.id);
      const accountId = id(obj(p.account)?.id);
      const msgId = id(p.id);
      const body = str(p.content);
      if (!convId || !accountId || !body) return [];

      const sender = obj(p.sender) ?? obj(obj(conversation?.meta)?.sender);

      return [{
        message: body.slice(0, 20_000),
        customer_email: str(sender?.email),
        channel: channelFor(conversation?.channel ?? obj(p.inbox)?.channel_type),
        // Scoped to the MESSAGE, not the conversation: a follow-up is a new
        // thing to triage, and reusing the conversation id would make the
        // second customer message look like a duplicate delivery of the first.
        external_id: msgId
          ? `chatwoot:${accountId}:${convId}:m${msgId}`
          : `chatwoot:${accountId}:${convId}`,
        external_url: deepLink(base, accountId, convId),
        source: "chatwoot",
      }];
    },
  };
}
