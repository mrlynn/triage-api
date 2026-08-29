/**
 * The LLM judge, and the discipline that keeps it honest.
 *
 * Extracted from run-eval.ts so `evals/compare-models.ts` can reuse it while
 * varying the model under test — which is precisely where the rule below stops
 * being a nicety and starts being load-bearing.
 *
 * THE RULER CANNOT BE THE THING BEING MEASURED.
 *
 * `JUDGE_MODEL` is pinned to a constant and never inherits `--models`. If the
 * judge changed alongside the model under test, a difference in the score
 * would have two possible causes and you could not tell them apart. Every
 * result file records the judge id AND a hash of the judge prompt, so two runs
 * graded by different rulers can be detected rather than silently compared.
 *
 * TEACHING NOTE on judges — three rules that separate a useful judge from a
 * rubber stamp:
 *   - Give it a RUBRIC with concrete pass/fail criteria, not "rate 1-10".
 *   - Make it cite evidence BEFORE it scores. A judge that scores first
 *     rationalizes afterwards.
 *   - Never let the judge see the generating model's reasoning, and never
 *     judge with the same prompt that generated. You are measuring the output,
 *     not re-running the author.
 *
 * And the fourth rule, learned the hard way in this repo: a judge you have not
 * validated is a random number generator with good manners. Three runs of this
 * judge scored the same four cases 3/4, then 1/4, then 2/4. See Lab 6.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { harness } from "./harness.js";
import { anthropic } from "../../src/anthropic.js";
import { MAX_TOKENS, MODEL_TIERS } from "../../src/config.js";
import { summarizeUsage } from "../../src/lib/usage.js";
import type { EvalCase } from "./harness.js";

/**
 * PINNED. Never varies with the model under test. Changing it invalidates
 * every number already in evals/results/, which is why it is a constant here
 * rather than a flag with a default.
 */
export const JUDGE_MODEL: string = MODEL_TIERS.flagship;

export const JudgeSchema = z.object({
  evidence: z
    .array(z.string())
    .describe(
      "Direct quotes from the reply that bear on the rubric, gathered BEFORE scoring. Quote violations and compliant moves alike.",
    ),
  leads_with_resolution: z.boolean().describe("Rubric 1: the first sentence states what will happen, not an apology."),
  apology_count_ok: z.boolean().describe("Rubric 2: at most one apology in the entire reply."),
  no_banned_phrases: z
    .boolean()
    .describe("Rubric 3: contains none of 'unfortunately', 'as per our policy', \"I'm afraid\"."),
  no_internal_jargon: z.boolean().describe("Rubric 4: no 'RMA', 'SKU', 'P1', 'tier-2', ticket IDs, or queue names."),
  no_unauthorized_promise: z
    .boolean()
    .describe("Rubric 5: makes no promise the handbook forbids (immediate refunds, future features, unannounced fix dates)."),
  under_180_words: z.boolean().describe("Rubric 6: the reply is under 180 words."),
  verdict: z.enum(["pass", "fail"]).describe("Fail if ANY rubric item is false."),
  rationale: z.string().describe("Two sentences explaining the verdict, referencing the evidence."),
});

export const JUDGE_SYSTEM = `You are a support-quality auditor. You grade a customer-facing reply against a fixed rubric.

You are grading the TEXT ONLY. You do not know, and must not speculate about, how it was produced.

Method, in this order:
1. Collect evidence: quote the exact spans of the reply relevant to each rubric item.
2. Only then decide each rubric item.
3. The verdict is "fail" if any single rubric item is false. There is no partial credit and no rounding up for effort.

Be strict. A reply that is pleasant but breaks a rule fails. Graders who pass borderline work make the metric useless.`;

export interface JudgeResult {
  id: string;
  verdict: "pass" | "fail";
  rationale: string;
  broken_rules: string[];
  cost_usd: number;
}

export async function judgeDrafts(sample: EvalCase[]): Promise<JudgeResult[]> {
  const results: JudgeResult[] = [];

  for (const testCase of sample) {
    // Generate a reply through the real streaming route, collecting the text.
    const res = await (await harness()).app.request("/v1/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: testCase.message }),
    });

    const reply = await collectSseText(res);
    if (!reply.trim()) {
      results.push({
        id: testCase.id,
        verdict: "fail",
        rationale: "The draft route produced no text.",
        broken_rules: ["no_output"],
        cost_usd: 0,
      });
      continue;
    }

    const judged = await anthropic.messages.parse({
      model: JUDGE_MODEL,
      max_tokens: MAX_TOKENS.nonStreaming,
      system: JUDGE_SYSTEM,
      output_config: { effort: "medium", format: zodOutputFormat(JudgeSchema) },
      messages: [
        {
          role: "user",
          content: `Grade this reply.\n\n<reply>\n${reply}\n</reply>`,
        },
      ],
    });

    const verdict = judged.parsed_output;
    if (!verdict) {
      results.push({
        id: testCase.id,
        verdict: "fail",
        rationale: "Judge output failed schema validation.",
        broken_rules: ["judge_unparseable"],
        cost_usd: summarizeUsage(judged.usage, judged.model).estimated_cost_usd,
      });
      continue;
    }

    const broken = Object.entries({
      leads_with_resolution: verdict.leads_with_resolution,
      apology_count_ok: verdict.apology_count_ok,
      no_banned_phrases: verdict.no_banned_phrases,
      no_internal_jargon: verdict.no_internal_jargon,
      no_unauthorized_promise: verdict.no_unauthorized_promise,
      under_180_words: verdict.under_180_words,
    })
      .filter(([, ok]) => !ok)
      .map(([rule]) => rule);

    results.push({
      id: testCase.id,
      verdict: verdict.verdict,
      rationale: verdict.rationale,
      broken_rules: broken,
      cost_usd: summarizeUsage(judged.usage, judged.model).estimated_cost_usd,
    });
  }

  return results;
}

/** Drains an SSE response and concatenates the `text` events. */
async function collectSseText(res: Response): Promise<string> {
  if (!res.body) return "";
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (eventLine?.slice(7) === "text" && dataLine) {
        out += (JSON.parse(dataLine.slice(6)) as { text: string }).text;
      }
    }
  }
  return out;
}

/**
 * A short hash of the judge prompt, stored beside every result.
 *
 * Comparing two runs graded by different rubrics is a category error, and the
 * rubric is prose: it drifts by editing, silently, with no version number.
 * Eight hex characters is enough to notice.
 */
export function judgePromptSha(): string {
  return createHash("sha256")
    .update(JUDGE_SYSTEM)
    .update(JSON.stringify(zodOutputFormat(JudgeSchema)))
    .digest("hex")
    .slice(0, 8);
}
