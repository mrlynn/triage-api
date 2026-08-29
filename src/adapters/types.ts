/**
 * The adapter contracts.
 *
 * Four interfaces, one file, because the whole value of this repository is that
 * you can read the boundary in one sitting. If you are here to integrate a
 * ticketing system this repo does not ship, this is the only file you strictly
 * need — plus `conformance.ts`, which is the executable version of it.
 */
import type { CanonicalTicket, TriageResult, Resolution } from "../schemas.js";
import type { Redaction } from "../lib/untrusted.js";

// ---------------------------------------------------------------------------
// Sources: how tickets arrive
// ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  /** Why it failed, for the log. Never returned to the caller verbatim. */
  reason?: string;
}

export interface TicketSource {
  name: string;
  /**
   * Authenticates a raw inbound request.
   *
   * MUST FAIL CLOSED. A source whose secret is not configured returns
   * `{ok:false}` for every request. The tempting alternative — "no secret set,
   * so skip verification" — turns a missing environment variable into an open
   * ingest endpoint, and the person who set it up will never find out.
   *
   * Receives the already-read body text, because a Request body can only be
   * consumed once and signature schemes verify the exact bytes.
   */
  verify(headers: Headers, rawBody: string): Promise<VerifyResult>;

  /**
   * Vendor payload -> canonical tickets. Returns an empty array for events this
   * source does not care about (a label change, a bot comment), which is the
   * normal case for most webhook traffic and is not an error.
   */
  normalize(payload: unknown): CanonicalTicket[];
}

// ---------------------------------------------------------------------------
// Sinks: where decisions go
// ---------------------------------------------------------------------------

/** What the service decided, and everything a reviewer needs to check it. */
export interface Decision {
  id: string;
  ticket: CanonicalTicket;
  triage: TriageResult;
  resolution?: Resolution;
  /** Guardrail findings. An empty array means every control ran and passed. */
  violations: string[];
  redactions: Redaction[];
  model: string;
  cost_usd: number;
  created_at: string;
}

export interface PublishResult {
  ok: boolean;
  /** What the sink actually did, for the trace. "commented", "labelled", … */
  actions: string[];
  error?: string;
}

export interface TicketSink {
  name: string;
  /**
   * Writes the decision back to the source system.
   *
   * MUST NOT THROW. A sink failure is an operational problem with an external
   * service, not a reason to lose a triage result you already paid for. Return
   * `{ok:false, error}` and let the caller store the decision anyway.
   */
  publish(decision: Decision): Promise<PublishResult>;
  capabilities: { comment: boolean; tag: boolean; setField: boolean; assign: boolean };
}

// ---------------------------------------------------------------------------
// Store: what is remembered
// ---------------------------------------------------------------------------

export type QueueStatus = "new" | "claimed" | "resolved" | "dismissed";

export interface EscalationRecord extends Decision {
  status: QueueStatus;
  claimed_by?: string;
  claimed_at?: string;
  resolved_at?: string;
  /**
   * The customer's message AFTER redaction. The raw message is never stored.
   *
   * TEACHING NOTE: storage is a consequence of ESCALATION, not of submission.
   * Only tickets a human needs to see are persisted at all. A support system
   * that logs every inbound message forever has built a breach waiting for an
   * occasion, and "we might want the data later" is not a retention policy.
   */
  message_redacted: string;
}

export interface QueueStats {
  depth: number;
  claimed: number;
  resolved: number;
  median_time_to_claim_ms: number | null;
}

export interface Store {
  name: string;
  /** Called once at boot. Creates indexes, opens pools, verifies reachability. */
  init(): Promise<void>;
  close(): Promise<void>;
  /** For /readyz. Never throws. */
  health(): Promise<{ ok: boolean; detail?: string }>;

  insertEscalation(record: EscalationRecord): Promise<void>;
  listEscalations(opts?: { status?: QueueStatus; limit?: number }): Promise<EscalationRecord[]>;
  getEscalation(id: string): Promise<EscalationRecord | null>;
  setStatus(id: string, status: QueueStatus, by?: string): Promise<boolean>;
  queueStats(): Promise<QueueStats>;

  /**
   * Returns true when the request is ALLOWED.
   *
   * Fails closed: an unreachable store returns false. A rate limiter that opens
   * up when its backend is down is a rate limiter that stops working exactly
   * when you are already having a bad day.
   */
  rateLimit(key: string, limit: number, windowMs: number): Promise<boolean>;

  /**
   * Records usage for a UTC day. Cost is in integer MICRO-dollars because
   * floating-point accumulation over a million small charges drifts, and a
   * cost dashboard that is quietly wrong is worse than none.
   */
  recordUsage(day: string, tokens: number, microDollars: number): Promise<void>;
  usageFor(day: string): Promise<{ tokens: number; micro_dollars: number; requests: number }>;

  /** True if this external id has been seen before. Marks it seen either way. */
  markSeen(externalId: string): Promise<boolean>;
}
