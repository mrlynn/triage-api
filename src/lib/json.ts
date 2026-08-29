/**
 * Parsing model output that is supposed to be JSON.
 *
 * Lifted out of `routes/resolve.ts` because the Batches API needs exactly the
 * same treatment, and for the same underlying reason: `parsed_output` is a
 * convenience of `messages.parse()`, and neither the beta tool runner nor a
 * batch result has it. Both hand you text that the API guaranteed would be
 * schema-conformant, and both leave the parse and the validation to you.
 *
 * TEACHING NOTE: this returns `null` rather than throwing, so the caller is
 * forced to write the branch. `JSON.parse` in a bare `try/catch` that swallows
 * the error is the pattern this whole repo argues against — the failure is
 * real and it deserves a code path, not a shrug.
 */
export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
