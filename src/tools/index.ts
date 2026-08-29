/**
 * Wrapping tool definitions for the Anthropic SDK.
 *
 * Everything company-specific is in `definitions.ts` and `adapters/data.ts`.
 * This file adds the two things every tool needs and no tool should implement
 * itself: the trace, and the trust boundary for tool OUTPUT.
 */
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { ToolDef } from "./definitions.js";
import {
  redactPII,
  sanitizeToolOutput,
  type ExtraRedaction,
  type Redaction,
} from "../lib/untrusted.js";

/** Every tool call is recorded so routes can show their work to the caller. */
export interface ToolCallRecord {
  tool: string;
  input: unknown;
  /**
   * The RAW result object, before redaction or escaping. Kept structured so
   * `enforceAuthority` and `verifyCitations` can read facts out of it rather
   * than out of the model's prose about it.
   */
  output: unknown;
  /** What was stripped before the text reached the model. Counts, not values. */
  redactions: Redaction[];
  ms: number;
}

export function createTools(
  defs: ToolDef[],
  trace: ToolCallRecord[],
  extraRedactions: ExtraRedaction[] = [],
) {
  /**
   * Wraps a plain function so that it (a) lands in the trace and (b) returns a
   * STRING, which is what the tool runner requires.
   *
   * TEACHING NOTE: `run` must resolve to a string or an array of content
   * blocks — returning a bare object is a TypeScript error, and stringifying
   * it yourself is the point. Claude reads tool results as text, so the shape
   * you serialize is a prompt-engineering decision: stable key order, no
   * nulls-as-empty-strings, and no 50KB dumps.
   *
   * THIS IS ALSO THE TRUST BOUNDARY FOR TOOL OUTPUT, and that is why the
   * redaction lives here rather than in every call site. Every tool result in
   * this service passes through this one closure, so one function buys three
   * properties at once:
   *
   *   1. PII never reaches the prompt. Asking the model nicely to ignore card
   *      numbers still puts them in your request logs and your traces.
   *   2. Instruction-shaped text in tool output is escaped. Tool results are
   *      not trusted input either — `lookup_customer` returns fields a
   *      customer supplied, and a note field containing markup would otherwise
   *      arrive wearing the authority of a system-provided fact. That is the
   *      second-order injection people forget after they have carefully
   *      escaped the user's message.
   *   3. The trace keeps the RAW object while the model sees the cleaned text,
   *      so deterministic checks read real numbers and the model does not read
   *      real card numbers.
   *
   * Ordering matters: redact first, escape second. Escaping first would turn
   * a separator into an entity and hide a card number from the Luhn check.
   */
  const record = (tool: string, fn: ToolDef["run"]) => {
    return async (input: unknown): Promise<string> => {
      const started = Date.now();
      const output = await fn(input);
      const { text, redactions } = redactPII(JSON.stringify(output, null, 2), extraRedactions);
      trace.push({ tool, input, output, redactions, ms: Date.now() - started });
      return sanitizeToolOutput(text);
    };
  };

  return defs.map((def) =>
    betaZodTool({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema as z.ZodObject<z.ZodRawShape>,
      run: record(def.name, def.run),
    }),
  );
}
