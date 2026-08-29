/**
 * Provider-neutral tool definitions.
 *
 * WHY THIS FILE EXISTS: `createTools()` used to weld several concerns into one
 * place — the name, the description, the input schema, the business function,
 * the trace side-effect, and the SDK wrapper. That is fine while there is
 * exactly one consumer. The moment there are two (the Messages API tool runner,
 * and an MCP server) you either fork the definitions or you split them, and a
 * forked tool description is a silent behaviour fork: the model behind one
 * surface is reading different instructions from the model behind the other,
 * and nothing type-checks that.
 *
 * So the descriptions live here, once. `tools/index.ts` wraps them for the
 * Anthropic SDK and adds the trace and redaction; `mcp/server.ts` wraps the
 * same array for MCP. Neither owns the text.
 *
 * TEACHING NOTE — tool design is prompt design.
 * A tool's `description` and its parameter `.describe()` strings are the only
 * documentation Claude ever sees. Most "the model called the wrong tool" bugs
 * are description bugs, not model bugs. Three rules followed here:
 *
 *   1. Say WHEN to use it, not just what it does. ("Call this before quoting
 *      any dollar figure" beats "Looks up an order.")
 *   2. Return small, structured, self-describing results. A tool that dumps
 *      50KB of JSON burns context and buries the signal.
 *   3. Make failure legible. Returning `{ found: false, ... }` teaches the
 *      model what to do next; throwing an opaque error does not.
 *
 * WHAT CHANGED FROM THE COURSE: the list is BUILT, not exported as a constant,
 * because which tools exist now depends on what your DataProvider can do. A
 * deployment with no customer lookup does not get a `lookup_customer` tool that
 * always returns nothing — it does not get the tool at all. See adapters/data.ts.
 */
import { z } from "zod";
import type { Pack } from "../pack.js";
import { type DataProvider, daysSince } from "../adapters/data.js";

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: S;
  /**
   * The business function. Unaware of Claude, MCP, the trace, or redaction —
   * every one of which is applied by a wrapper. That is what makes it portable,
   * and what makes it testable without a network.
   */
  run: (input: z.infer<S>) => unknown | Promise<unknown>;
}

/**
 * Naive keyword search over the handbook's `## ` sections.
 *
 * Deliberately not a vector index. The handbook is ~1.5K tokens and already
 * sits in the cached system prompt, so this tool is not doing retrieval — it is
 * making the model's reliance on a specific clause VISIBLE in the trace, which
 * is what `verifyCitations` and a human reviewer both need. Reaching for
 * embeddings here would add infrastructure and remove nothing.
 */
export function searchPolicy(handbook: string, query: string, limit = 3): string[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
  const sections = handbook.split(/\n(?=## )/).filter((s) => s.startsWith("## "));

  return sections
    .map((section) => {
      const haystack = section.toLowerCase();
      const score = terms.reduce((acc, term) => acc + (haystack.split(term).length - 1), 0);
      return { section, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.section.trim());
}

/**
 * Builds the tool list for this deployment.
 *
 * The conditionals are the point. `TOOL_DEFS` in the course was a constant
 * because Northwind always had orders and customers. Here, the presence of a
 * capability decides whether the model ever learns the tool exists.
 */
export function buildToolDefs(pack: Pack, data: DataProvider): ToolDef[] {
  const defs: ToolDef[] = [];
  const co = pack.companyName;

  if (data.lookupOrder) {
    const lookup = data.lookupOrder.bind(data);
    defs.push({
      name: "lookup_order",
      description:
        "Retrieve an order by its identifier. Call this before stating any fact about an order's " +
        "contents, price, status, or delivery date — never rely on what the customer claims. " +
        "Returns found: false when the identifier does not exist, which usually means the customer " +
        "mistyped it or is referring to a different account.",
      inputSchema: z.object({
        order_id: z.string().describe("The order identifier as the customer wrote it. Case-insensitive."),
      }),
      run: async (input) => {
        const { order_id } = input as { order_id: string };
        const order = await lookup(order_id);
        if (!order) return { found: false, order_id };
        return {
          found: true,
          ...order,
          days_since_delivery: order.delivered_at === null ? null : daysSince(order.delivered_at),
          days_since_order: daysSince(order.placed_at),
        };
      },
    });
  }

  if (data.lookupCustomer) {
    const lookup = data.lookupCustomer.bind(data);
    const ceiling = pack.authority.rollingCeilingUsd;
    const window = pack.authority.rollingWindowDays;
    const ref = pack.authority.clauseRefs.rollingCeiling;
    defs.push({
      name: "lookup_customer",
      description:
        `Retrieve a customer's account standing by email: membership tier, lifetime value, refunds ` +
        `issued in the last ${window} days, and how many times they have contacted us recently. Call this ` +
        `before deciding between a refund, a replacement, and an escalation — ` +
        (ref ? `policy clause ${ref} escalates ` : `policy escalates `) +
        `any account above $${ceiling} of refunds in ${window} days, and you cannot check that from the ` +
        `ticket text alone.`,
      inputSchema: z.object({
        email: z.string().describe("The customer's email address on file."),
      }),
      run: async (input) => {
        const { email } = input as { email: string };
        const customer = await lookup(email);
        return customer ? { found: true, ...customer } : { found: false, email };
      },
    });
  }

  // Always available: it searches the pack handbook, which every pack has.
  defs.push({
    name: "search_policy",
    description:
      `Search the ${co} support policy handbook and return the most relevant sections verbatim. ` +
      "Use this whenever a decision depends on a rule — refund windows, escalation triggers, " +
      "delivery timelines, agent authority limits. Cite only clause numbers that appear in text " +
      "this tool returned to you.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Keywords describing the rule you need, e.g. 'lost package replacement threshold' or 'refund authority limit'.",
        ),
    }),
    run: (input) => {
      const { query } = input as { query: string };
      const sections = searchPolicy(pack.handbookText, query);
      return sections.length > 0
        ? { matches: sections.length, sections }
        : { matches: 0, sections: [], hint: "Try broader keywords." };
    },
  });

  return defs;
}
