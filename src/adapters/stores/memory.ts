/**
 * In-memory store. The default, and the reason a fresh clone works.
 *
 * TEACHING NOTE — why the zero-infrastructure default matters more than it
 * looks: a reference repository that requires a database before it prints
 * anything gets evaluated by nobody. The first five minutes decide whether
 * there is a sixth. So the default path is `npm install`, an API key, `npm run
 * dev`, and a real triage result — and every capability the real store has is
 * present here too, so switching later changes one config line and nothing else.
 *
 * It is NOT for production, and it says so at boot rather than in a README
 * nobody reads: the queue vanishes on restart, and nothing is shared between
 * instances, so on more than one replica your rate limits are per-replica and
 * your idempotency check is a coin flip.
 */
import type { EscalationRecord, QueueStats, QueueStatus, Store } from "../types.js";

interface Window { count: number; resetAt: number; }

export function memoryStore(): Store {
  const escalations = new Map<string, EscalationRecord>();
  const windows = new Map<string, Window>();
  const usage = new Map<string, { tokens: number; micro_dollars: number; requests: number }>();
  const seen = new Set<string>();

  return {
    name: "memory",

    async init() {
      if (process.env.NODE_ENV === "production") {
        console.warn(
          "[store:memory] running in production with the in-memory store. The escalation queue " +
            "will be lost on restart, and rate limits and idempotency are per-instance — on more " +
            "than one replica they do not work. Set store.kind to \"mongodb\" in triage.config.ts.",
        );
      }
    },
    async close() {},
    async health() { return { ok: true, detail: `${escalations.size} escalations in memory` }; },

    async insertEscalation(record) { escalations.set(record.id, record); },

    async listEscalations(opts = {}) {
      const all = [...escalations.values()]
        .filter((e) => (opts.status ? e.status === opts.status : true))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return opts.limit ? all.slice(0, opts.limit) : all;
    },

    async getEscalation(id) { return escalations.get(id) ?? null; },

    async setStatus(id, status: QueueStatus, by) {
      const rec = escalations.get(id);
      if (!rec) return false;
      rec.status = status;
      if (status === "claimed") { rec.claimed_by = by; rec.claimed_at = new Date().toISOString(); }
      if (status === "resolved" || status === "dismissed") rec.resolved_at = new Date().toISOString();
      return true;
    },

    async queueStats(): Promise<QueueStats> {
      const all = [...escalations.values()];
      const claimTimes = all
        .filter((e) => e.claimed_at)
        .map((e) => new Date(e.claimed_at!).getTime() - new Date(e.created_at).getTime())
        .sort((a, b) => a - b);
      const mid = Math.floor(claimTimes.length / 2);
      return {
        depth: all.filter((e) => e.status === "new").length,
        claimed: all.filter((e) => e.status === "claimed").length,
        resolved: all.filter((e) => e.status === "resolved").length,
        median_time_to_claim_ms: claimTimes.length === 0 ? null : claimTimes[mid] ?? null,
      };
    },

    async rateLimit(key, limit, windowMs) {
      const now = Date.now();
      const w = windows.get(key);
      if (!w || w.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (w.count >= limit) return false;
      w.count += 1;
      return true;
    },

    async recordUsage(day, tokens, microDollars) {
      const cur = usage.get(day) ?? { tokens: 0, micro_dollars: 0, requests: 0 };
      cur.tokens += tokens;
      cur.micro_dollars += microDollars;
      cur.requests += 1;
      usage.set(day, cur);
    },

    async usageFor(day) {
      return usage.get(day) ?? { tokens: 0, micro_dollars: 0, requests: 0 };
    },

    async markSeen(externalId) {
      if (seen.has(externalId)) return true;
      seen.add(externalId);
      return false;
    },
  };
}
