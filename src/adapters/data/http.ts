/**
 * HTTP DataProvider — points the lookup tools at services you already run.
 *
 * The realistic production shape: your order service already has an endpoint,
 * and this service should call it rather than reach into your database.
 *
 * Two things worth copying if you write your own:
 *
 * 1. **A timeout.** An agentic loop makes several tool calls per ticket. One
 *    slow lookup does not cost you one slow request; it costs you the whole
 *    loop, and the loop is already the slowest thing in the system.
 *
 * 2. **404 means "not found", not "error".** A tool that throws teaches the
 *    model nothing. Returning null becomes `{found: false}`, which the model
 *    handles correctly — usually by telling the customer their order number
 *    looks wrong, which is very often the truth.
 */
import type { DataProvider, OrderRecord, CustomerRecord } from "../data.js";

export interface HttpDataOptions {
  orderUrl?: string;    // {id} is substituted
  customerUrl?: string; // {email} is substituted
  headers: Record<string, string>;
  timeoutMs: number;
}

async function get<T>(url: string, headers: Record<string, string>, timeoutMs: number): Promise<T | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`lookup failed: ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function httpProvider(opts: HttpDataOptions): DataProvider {
  const provider: DataProvider = { name: "http" };

  if (opts.orderUrl) {
    const tpl = opts.orderUrl;
    provider.lookupOrder = (id) =>
      get<OrderRecord>(tpl.replace("{id}", encodeURIComponent(id)), opts.headers, opts.timeoutMs);
  }
  if (opts.customerUrl) {
    const tpl = opts.customerUrl;
    provider.lookupCustomer = (email) =>
      get<CustomerRecord>(tpl.replace("{email}", encodeURIComponent(email)), opts.headers, opts.timeoutMs);
  }

  return provider;
}
