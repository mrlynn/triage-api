/**
 * Fixture source — replays a JSON file. Development and demos only.
 *
 * Accepts an unsigned POST so you can `curl` the ingest endpoint without
 * generating an HMAC, which is exactly the property that makes it dangerous.
 * It therefore REFUSES TO REGISTER when NODE_ENV=production, at boot, loudly.
 * A dev convenience that can be left on by accident is a back door.
 */
import { TicketInput, type CanonicalTicket } from "../../schemas.js";
import type { TicketSource } from "../types.js";

export function fixturesSource(): TicketSource {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      'The "fixtures" source accepts unsigned requests and must not be configured in production. ' +
        "Remove it from `sources` in triage.config.ts.",
    );
  }
  return {
    name: "fixtures",
    async verify() { return { ok: true }; },
    normalize(payload: unknown): CanonicalTicket[] {
      const items = Array.isArray(payload) ? payload : [payload];
      return items
        .map((i) => TicketInput.safeParse(i))
        .filter((r) => r.success)
        .map((r) => ({ ...r.data, source: "fixtures" }));
    },
  };
}
