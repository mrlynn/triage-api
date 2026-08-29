/**
 * The one file you edit.
 *
 * Out of the box this runs the course's Northwind demo with no infrastructure:
 * in-memory store, JSON fixtures, and no sink — meaning it classifies tickets
 * and writes nothing back to anything. Add an ANTHROPIC_API_KEY and `npm run
 * dev` works.
 *
 * To make it yours:
 *   1. cp -r packs/starter packs/<your-company>   and edit it
 *   2. point `pack` at it
 *   3. add a source so your helpdesk can reach it
 *   4. leave `sinks` empty until you trust the output — then add one
 *
 * See docs/quickstart.md and docs/adapters.md.
 */
import { defineConfig } from "./src/define-config.js";

export default defineConfig({
  pack: "northwind",

  models: { tier: "flagship" },

  store: { kind: "memory" },

  data: { kind: "fixtures" },

  sources: {
    // Uncomment and set the matching secret in .env to accept real webhooks.
    // Each source REFUSES every request until its secret is set. Fail closed.
    //
    // "generic":  { kind: "generic-webhook" },
    // "github":   { kind: "github-issues" },
    // "zendesk":  { kind: "zendesk" },
    //
    // Chatwoot. Subscribe the webhook to `conversation_created` ONLY — Chatwoot
    // fires both that and `message_created` for a conversation's opening
    // message, and enabling both triages it twice under two ids.
    // See docs/integrations/chatwoot.md.
    // "chatwoot": { kind: "chatwoot" },
    //
    // Zammad. Create a webhook WITH a signature token, then a trigger whose
    // condition is "Action is created". The event filter lives in the trigger,
    // not here. See docs/integrations/zammad.md.
    // "zammad":   { kind: "zammad" },
  },

  /**
   * ADVISORY MODE. Empty means: classify, store, serve on /v1/queue — and write
   * nothing back. Start here. Add a sink only once you have watched the queue
   * for a week and believe the output.
   */
  sinks: [],
});
