/**
 * MongoDB store. The production reference.
 *
 * Ported from the course's storefront, which is where the operational details
 * were actually learned. Three of them are worth reading before you swap this
 * for Postgres, because they are the parts people leave out:
 *
 * 1. **Retention is a TTL INDEX, not a README sentence.** `created_at` carries
 *    an `expireAfterSeconds`, so an escalation deletes itself. A retention
 *    policy that depends on someone remembering to run a cleanup job is a
 *    retention policy that quietly did not happen.
 *
 * 2. **Cost is stored as integer micro-dollars.** Accumulating float dollars
 *    over a million $0.0004 charges drifts, and a cost dashboard that is
 *    quietly wrong is worse than no dashboard. Divide by 1e6 at read time.
 *
 * 3. **Usage is a daily ROLLUP, not per-request logging.** One document per UTC
 *    day, atomic `$inc`. You get spend and volume without building a second,
 *    unbounded copy of your traffic that you now have to secure and retain.
 *
 * Connection pooling assumes a serverless-ish runtime with warm reuse: small
 * pool, zero minimum, short idle. The client is cached on `globalThis` so a
 * warm invocation and a dev-server hot reload do not each open a new pool.
 */
import type { Collection, Db, MongoClient as MongoClientType } from "mongodb";
import type { EscalationRecord, QueueStats, QueueStatus, Store } from "../types.js";

interface UsageDoc { _id: string; tokens: number; micro_dollars: number; requests: number; day: Date; }
interface RateDoc { _id: string; count: number; expiresAt: Date; }
interface SeenDoc { _id: string; expiresAt: Date; }

declare global {
  // eslint-disable-next-line no-var
  var __triageMongo: Promise<MongoClientType> | undefined;
}

export interface MongoOptions {
  uri?: string;
  db?: string;
  retentionDays: number;
}

export function mongoStore(opts: MongoOptions): Store {
  const uri = opts.uri ?? process.env.MONGODB_URI;
  const dbName = opts.db ?? process.env.MONGODB_DB ?? "triage_api";
  let db: Db | null = null;
  let client: MongoClientType | null = null;

  async function connect(): Promise<Db> {
    if (db) return db;
    if (!uri) throw new Error("store.kind is \"mongodb\" but MONGODB_URI is not set.");

    // Imported lazily so the package stays optional — a memory-store deployment
    // should not have to install a database driver it will never call.
    const { MongoClient } = await import("mongodb");

    globalThis.__triageMongo ??= new MongoClient(uri, {
      maxPoolSize: 5,
      minPoolSize: 0,
      maxIdleTimeMS: 30_000,
      connectTimeoutMS: 5_000,
      socketTimeoutMS: 10_000,
      serverSelectionTimeoutMS: 5_000,
    }).connect();

    client = await globalThis.__triageMongo;
    db = client.db(dbName);
    return db;
  }

  const esc = async (): Promise<Collection<EscalationRecord & { created_date: Date }>> =>
    (await connect()).collection("escalations");

  return {
    name: "mongodb",

    async init() {
      const d = await connect();
      await d.collection("escalations").createIndexes([
        { key: { status: 1, created_at: -1 }, name: "board" },
        {
          key: { created_date: 1 },
          name: "retention",
          expireAfterSeconds: opts.retentionDays * 86_400,
        },
      ]);
      await d.collection("rate_limits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await d.collection("seen").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await d.collection("usage_daily").createIndex(
        { day: 1 }, { name: "usage_retention", expireAfterSeconds: 90 * 86_400 },
      );
    },

    async close() {
      if (client) await client.close();
      db = null; client = null; globalThis.__triageMongo = undefined;
    },

    async health() {
      try {
        const d = await connect();
        await d.command({ ping: 1 });
        return { ok: true, detail: `connected to ${dbName}` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },

    async insertEscalation(record) {
      const c = await esc();
      // created_date duplicates created_at as a BSON Date purely so the TTL
      // index has something it can expire on — TTL cannot read an ISO string.
      await c.insertOne({ ...record, created_date: new Date(record.created_at) });
    },

    async listEscalations(o = {}) {
      const c = await esc();
      const q = o.status ? { status: o.status } : {};
      return c.find(q).sort({ created_at: -1 }).limit(o.limit ?? 200).toArray();
    },

    async getEscalation(id) {
      const c = await esc();
      return c.findOne({ _id: id } as never);
    },

    async setStatus(id, status: QueueStatus, by) {
      const c = await esc();
      const set: Record<string, unknown> = { status };
      if (status === "claimed") { set.claimed_by = by; set.claimed_at = new Date().toISOString(); }
      if (status === "resolved" || status === "dismissed") set.resolved_at = new Date().toISOString();
      const r = await c.updateOne({ _id: id } as never, { $set: set });
      return r.matchedCount > 0;
    },

    async queueStats(): Promise<QueueStats> {
      const c = await esc();
      const [depth, claimed, resolved, claimedDocs] = await Promise.all([
        c.countDocuments({ status: "new" }),
        c.countDocuments({ status: "claimed" }),
        c.countDocuments({ status: "resolved" }),
        c.find({ claimed_at: { $exists: true } }, { projection: { created_at: 1, claimed_at: 1 } })
          .limit(500).toArray(),
      ]);
      const times = claimedDocs
        .map((d) => new Date(d.claimed_at!).getTime() - new Date(d.created_at).getTime())
        .sort((a, b) => a - b);
      return {
        depth, claimed, resolved,
        median_time_to_claim_ms: times.length === 0 ? null : times[Math.floor(times.length / 2)] ?? null,
      };
    },

    /**
     * Atomic fixed-window counter. `findOneAndUpdate` with an upsert is one
     * round trip and one document, so two concurrent requests cannot both read
     * "count = 4" and both decide they are under a limit of 5.
     */
    async rateLimit(key, limit, windowMs) {
      try {
        const d = await connect();
        const col = d.collection<RateDoc>("rate_limits");
        const now = Date.now();
        const bucket = `${key}:${Math.floor(now / windowMs)}`;
        const doc = await col.findOneAndUpdate(
          { _id: bucket },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(now + windowMs * 2) } },
          { upsert: true, returnDocument: "after" },
        );
        return (doc?.count ?? 1) <= limit;
      } catch {
        // FAIL CLOSED. An unreachable database is not permission to skip the
        // limiter — it is the moment you most need one.
        return false;
      }
    },

    async recordUsage(day, tokens, microDollars) {
      const d = await connect();
      await d.collection<UsageDoc>("usage_daily").updateOne(
        { _id: day },
        {
          $inc: { tokens, micro_dollars: Math.round(microDollars), requests: 1 },
          $setOnInsert: { day: new Date(`${day}T00:00:00Z`) },
        },
        { upsert: true },
      );
    },

    async usageFor(day) {
      const d = await connect();
      const doc = await d.collection<UsageDoc>("usage_daily").findOne({ _id: day });
      return {
        tokens: doc?.tokens ?? 0,
        micro_dollars: doc?.micro_dollars ?? 0,
        requests: doc?.requests ?? 0,
      };
    },

    async markSeen(externalId) {
      const d = await connect();
      const col = d.collection<SeenDoc>("seen");
      try {
        await col.insertOne({ _id: externalId, expiresAt: new Date(Date.now() + 7 * 86_400_000) });
        return false;
      } catch {
        // Duplicate key: we have processed this webhook before.
        return true;
      }
    },
  };
}
