/**
 * GET /v1/limits — what the API last told us about our own headroom.
 *
 * CAPABILITY DEMONSTRATED: reading the rate-limit headers that come back on
 * every single response and that almost nobody looks at.
 *
 * The value here is not the endpoint, it is the habit. Rate limits are the
 * most invisible constraint in the system: you have a full accounting of your
 * remaining capacity on every response, and the usual first encounter with it
 * is a 429 during a spike, at which point you are answering a capacity
 * question with no history of your own capacity.
 *
 * HONEST CAVEATS, stated in the response body as well as here:
 *  - This reflects the LAST response this process saw. It is a snapshot, not a
 *    live reading, and it can be arbitrarily stale.
 *  - It says nothing about other processes sharing the key. Two deploys and a
 *    laptop all draw on the same bucket.
 */
import { Hono } from "hono";
import { latestRateLimits } from "../lib/limits.js";

export const limitsRoute = new Hono();

limitsRoute.get("/", (c) => {
  const snapshot = latestRateLimits();

  if (!snapshot) {
    return c.json({
      snapshot: null,
      note: "No upstream call has been made yet in this process. Hit /v1/triage first.",
    });
  }

  return c.json({
    snapshot,
    note:
      "Headers from the most recent upstream response in THIS process. Stale by " +
      "definition, and blind to other processes sharing the same key.",
  });
});
