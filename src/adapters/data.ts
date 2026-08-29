/**
 * The DataProvider seam — what the model is allowed to look up.
 *
 * TEACHING NOTE — the seam nobody wants to talk about.
 *
 * `search_policy` is generic: it searches the pack handbook, and every adopter
 * gets it for free. `lookup_order` and `lookup_customer` are not. They are your
 * order table, your billing system, your CRM, behind your auth, with your
 * latency budget. No reference implementation can supply them, and pretending
 * otherwise is how a reference repo ends up demoable and unusable.
 *
 * So they are an interface, and the interface is PARTIAL on purpose. A
 * deployment that cannot look customers up says so by not implementing the
 * method, and two things follow automatically:
 *
 *   1. The tool is never offered to the model. Withholding a tool is a stronger
 *      guarantee than instructing the model not to use it — the storefront in
 *      the course arrived at the same conclusion independently.
 *   2. The control that depends on it degrades LOUDLY. `enforceAuthority`
 *      emits `control_unavailable:rolling_ceiling` and escalates, rather than
 *      quietly approving refunds it cannot check. See src/lib/authority.ts.
 *
 * The second one is the whole argument. A guardrail that silently stops running
 * when its inputs disappear is worse than no guardrail, because the summary
 * still says "0 violations" and someone will read that as safe.
 */

export interface OrderItem {
  name: string;
  qty: number;
  price_usd: number;
  final_sale?: boolean;
}

export interface OrderRecord {
  order_id: string;
  customer_email: string;
  placed_at: string;
  delivered_at: string | null;
  status: string;
  total_usd: number;
  shipping_method?: string;
  tracking?: string | null;
  items: OrderItem[];
}

export interface CustomerRecord {
  email: string;
  name?: string;
  member_tier?: string;
  member_since?: string | null;
  lifetime_value_usd?: number;
  /**
   * Refunds already issued inside the pack's rolling window. This is the field
   * `enforceAuthority` reads out of the tool trace to check the rolling
   * ceiling. If your system cannot compute it, return the field as undefined
   * rather than 0 — a wrong zero silently disables the ceiling, which is the
   * exact failure mode this file exists to prevent.
   */
  refunds_last_30d_usd?: number;
  prior_contacts_90d?: number;
}

export interface DataProvider {
  name: string;
  lookupOrder?(id: string): Promise<OrderRecord | null>;
  lookupCustomer?(email: string): Promise<CustomerRecord | null>;
}

/** Days between an ISO date and today. Used to make record ages legible. */
export function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  return Math.floor((Date.now() - then) / 86_400_000);
}
