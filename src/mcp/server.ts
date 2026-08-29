/**
 * The same back office, over MCP. `npm run mcp`
 *
 * The Model Context Protocol is how a tool surface is published to clients you
 * did not write — Claude Desktop, Claude Code, an IDE, someone else's agent.
 * The Messages API tool loop in `/v1/resolve` is a tool surface for ONE
 * program: ours. This is the same tools exposed so that any MCP client can
 * use them.
 *
 * THE POINT OF THE EXERCISE, and the reason `tools/definitions.ts` exists:
 * this file adds no descriptions, no schemas, and no business logic. It maps
 * over the built tool list and adapts it to a second protocol. If the two
 * surfaces had their own copies of the tool text, the model behind one would be
 * reading different instructions from the model behind the other, and nothing
 * would type-check that.
 *
 * TOOLS VERSUS RESOURCES — the distinction MCP forces you to make, and a
 * genuinely useful one:
 *
 *   `search_policy` is a TOOL. It takes a query, does retrieval, and returns a
 *   computed answer. The client cannot produce it without calling us.
 *
 *   The handbook itself is a RESOURCE. It is content, it has a stable URI, and
 *   a client can simply read it. Publishing it as a tool would mean a model had
 *   to guess a search query to reach text it could have read directly.
 *
 * The rule that transfers: if the client would be equally well served by
 * reading the thing, it is a resource. Tools are for work.
 *
 * NOTE that this server never calls Claude — it needs no credential, which is
 * worth noticing, because "MCP server" and "AI service" get conflated
 * constantly. It DOES need the same trust boundary, because an MCP client is if
 * anything less trusted: we did not write it and cannot see what it does with
 * the result.
 *
 * COURSE REF: Lab 9
 */
import "../lib/env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { z } from "zod";
import { buildRuntime } from "../runtime.js";
import { redactPII, sanitizeToolOutput } from "../lib/untrusted.js";

const rt = await buildRuntime();
const scheme = rt.pack.id.replace(/[^a-z0-9]/g, "");

const server = new McpServer({ name: `${rt.pack.id}-support`, version: "0.1.0" });

for (const def of rt.toolDefs) {
  server.registerTool(
    def.name,
    {
      description: def.description,
      inputSchema: (def.inputSchema as z.ZodObject<z.ZodRawShape>).shape,
    },
    async (args: unknown) => {
      const output = await def.run(args as never);
      // The same treatment `record()` applies on the Messages API side. The
      // trust boundary does not become optional because the caller changed
      // protocol.
      const { text } = redactPII(JSON.stringify(output, null, 2), rt.redactions);
      return { content: [{ type: "text" as const, text: sanitizeToolOutput(text) }] };
    },
  );
}

/**
 * The handbook, whole and by section.
 *
 * Two URI shapes on purpose. A client that wants the policy can read the whole
 * document; a client that knows it needs section 5 can read just that and spend
 * a fraction of the context. Offering only the first would make every consumer
 * pay for all of it.
 */
const handbookUri = `${scheme}://policy/handbook`;

server.registerResource(
  "policy-handbook",
  handbookUri,
  {
    title: `${rt.pack.companyName} support policy handbook`,
    description:
      "The complete customer-support policy. The normative source for refund windows, " +
      "escalation triggers, agent authority limits, and category definitions.",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [{ uri: handbookUri, mimeType: "text/markdown", text: rt.pack.handbookText }],
  }),
);

/**
 * `## 5. Escalation` -> section 5. Same headings `searchPolicy` splits on.
 *
 * Note the filter. Splitting on `## ` also yields the document preamble, which
 * has no section number — an earlier version defaulted it to "0" and published
 * a resource that exists, reads fine, and corresponds to nothing anyone would
 * cite. Numbering a thing that has no number is how a URI space acquires
 * entries nobody can explain.
 */
function handbookSections(): { number: string; title: string; body: string }[] {
  return rt.pack.handbookText.split(/^## /m)
    .filter((part) => part.trim().length > 0)
    .map((part) => {
      const firstLine = part.split("\n")[0] ?? "";
      const number = firstLine.match(/^(\d+)\./)?.[1] ?? null;
      return number === null ? null : { number, title: firstLine.trim(), body: `## ${part}`.trimEnd() };
    })
    .filter((s): s is { number: string; title: string; body: string } => s !== null);
}

for (const section of handbookSections()) {
  const uri = `${scheme}://policy/section/${section.number}`;
  server.registerResource(
    `policy-section-${section.number}`,
    uri,
    { title: section.title, description: `Handbook ${section.title}`, mimeType: "text/markdown" },
    async () => ({ contents: [{ uri, mimeType: "text/markdown", text: section.body }] }),
  );
}

await server.connect(new StdioServerTransport());
console.error(`[mcp] ${rt.pack.id} — ${rt.toolDefs.length} tools, ${handbookSections().length + 1} resources`);
