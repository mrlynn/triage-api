/**
 * JSON-file DataProvider. The zero-infrastructure default.
 *
 * Reads `fixtures/orders.json` and `fixtures/customers.json` from the active
 * pack. This is what makes `npm run dev` work with nothing but an API key, and
 * it is what the eval suite runs against — a deterministic backing store is a
 * precondition for a meaningful eval, not a shortcut.
 *
 * It is not a database. Linear scan, whole file in memory, loaded once.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Pack } from "../../pack.js";
import type { DataProvider, OrderRecord, CustomerRecord } from "../data.js";

function loadJson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as T[];
}

export function fixturesProvider(pack: Pack): DataProvider {
  const orders = loadJson<OrderRecord>(join(pack.dir, "fixtures", "orders.json"));
  const customers = loadJson<CustomerRecord>(join(pack.dir, "fixtures", "customers.json"));

  if (orders.length === 0 && customers.length === 0) {
    console.warn(
      `[data:fixtures] pack "${pack.id}" has no fixtures/orders.json or fixtures/customers.json. ` +
        `lookup_order and lookup_customer will be withheld from the model, and refund decisions ` +
        `will escalate as unverifiable. Add fixtures or configure a real DataProvider.`,
    );
  }

  const provider: DataProvider = { name: "fixtures" };

  // Conditional assignment, not a method that returns null. The presence of
  // the method is the signal that decides whether the tool is registered.
  if (orders.length > 0) {
    provider.lookupOrder = async (id) =>
      orders.find((o) => o.order_id.toLowerCase() === id.trim().toLowerCase()) ?? null;
  }
  if (customers.length > 0) {
    provider.lookupCustomer = async (email) =>
      customers.find((c) => c.email.toLowerCase() === email.trim().toLowerCase()) ?? null;
  }

  return provider;
}
