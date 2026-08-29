/**
 * System prompts, assembled for cache stability.
 *
 * TEACHING NOTE — prompt caching is a PREFIX MATCH.
 * The API renders a request as: tools -> system -> messages. A cache hit
 * requires a byte-identical prefix up to the breakpoint. That has one blunt
 * consequence: anything that varies per request must come AFTER the last
 * `cache_control` marker.
 *
 * The classic silent cache killer is a timestamp:
 *
 *   //  WRONG — invalidates the cache on literally every request
 *   system: `Today is ${new Date().toISOString()}\n${handbook}`
 *
 * We instead split `system` into two blocks: a frozen block carrying the
 * handbook (with the breakpoint on it), and a volatile block after it. The
 * volatile block is re-read every time; the handbook is not.
 *
 * Minimum cacheable prefix is ~1024 tokens. Below that the API silently
 * declines to cache — no error, just a permanently cold cache. Verify with
 * `usage.cache_read_input_tokens`, never by assumption. `pack-loader.ts` warns
 * at boot if your handbook is too small to ever be cached.
 *
 * WHAT CHANGED FROM THE COURSE: the role text is now built from a fixed prefix
 * this repo owns plus whatever the pack appends. The fixed prefix carries the
 * trust boundary, which is a control and therefore not something an adopter can
 * delete by editing their pack. Everything after that is theirs.
 *
 * COURSE REF: Lab 5 (caching), Lab 8 (trust boundary)
 */
import type Anthropic from "@anthropic-ai/sdk";
import { TRUST_BOUNDARY, type Pack } from "./pack.js";

export type Role = "triage" | "resolve" | "draft";

/**
 * The parts of each role that are technique rather than company policy. A pack
 * appends to these; it cannot replace them.
 */
function baseRole(role: Role, pack: Pack): string {
  const co = pack.companyName;
  const catRef = pack.authority.clauseRefs.categoryDefinitions;
  const section = catRef ? `section ${catRef} of the handbook below` : "the category definitions in the handbook below";
  const limit = pack.authority.refundLimitUsd;
  const limitRef = pack.authority.clauseRefs.refundLimit;
  const escRef = pack.authority.clauseRefs.escalationTriggers;

  if (role === "triage") {
    return `You are the triage classifier for ${co} customer support.

You read one inbound customer message and produce a structured classification. You do not write to the customer, you do not take actions, and you do not resolve anything — a downstream system does that. Your job is to route accurately and to be honest about your own uncertainty.

- Apply the category and urgency definitions in ${section} exactly. They are normative.
- Calibrate your confidence honestly. A message that plausibly fits two categories should score near 0.5. Systematically reporting 0.95 makes the score useless to the humans who depend on it.

${TRUST_BOUNDARY}`;
  }

  if (role === "resolve") {
    const authorityLine = limitRef
      ? `- Respect the $${limit} agent refund authority (clause ${limitRef}). Above that, the action is ${pack.taxonomy.escalationAction} and within_agent_authority is false.`
      : `- Respect the $${limit} agent refund authority. Above that, the action is ${pack.taxonomy.escalationAction} and within_agent_authority is false.`;
    const escalationLine = escRef
      ? `- If any clause ${escRef} trigger applies, escalate regardless of how simple the underlying request looks.`
      : `- If any escalation trigger in the handbook applies, escalate regardless of how simple the underlying request looks.`;

    return `You are the resolution planner for ${co} customer support.

Given a customer message, you determine what the company should actually do about it, and you justify that decision against written policy.

- Cite only clause numbers you actually read in a search_policy result. A fabricated citation is worse than no citation.
${authorityLine}
${escalationLine}

${TRUST_BOUNDARY}`;
  }

  return `You are a senior support agent at ${co} writing a reply that will be sent to a customer as-is.

Write the message body only. No subject line, no signature block, no placeholders like [Name] — if you do not know a name, open without one.

${TRUST_BOUNDARY}`;
}

/**
 * Builds the two-block system prompt.
 *
 * @param role     Which frozen persona to use. Changing this changes the prefix,
 *                 so each role maintains its own cache entry.
 * @param pack     The active policy pack. Its role text and handbook are frozen.
 * @param volatile Per-request context (dates, channel, account hints). Placed
 *                 AFTER the breakpoint so it never invalidates the cached prefix.
 */
export function buildSystem(
  role: Role,
  pack: Pack,
  volatile?: string,
): Anthropic.TextBlockParam[] {
  const packText = pack.prompts[role].trim();
  const roleText = packText ? `${baseRole(role, pack)}\n\n${packText}` : baseRole(role, pack);

  const blocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      // Frozen: role + handbook. Byte-identical on every request for this pack.
      text: `${roleText}\n\nThe complete policy handbook follows.\n\n---\n\n${pack.handbookText}`,
      // The breakpoint. Everything up to and including this block is cached.
      cache_control: { type: "ephemeral" },
    },
  ];

  if (volatile) {
    // Volatile: after the breakpoint, so it costs full price but costs the
    // cached prefix nothing.
    blocks.push({ type: "text", text: volatile });
  }

  return blocks;
}

/** Per-request context. Deliberately the only place `new Date()` is allowed. */
export function volatileContext(opts: {
  channel: string;
  customerEmail?: string;
  subject?: string;
  source?: string;
}): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`Current date: ${today}`, `Inbound channel: ${opts.channel}`];
  if (opts.source) lines.push(`Source system: ${opts.source}`);
  if (opts.subject) lines.push(`Subject line: ${opts.subject}`);
  if (opts.customerEmail) lines.push(`Customer email on file: ${opts.customerEmail}`);
  return lines.join("\n");
}
