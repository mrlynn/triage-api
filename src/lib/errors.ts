/**
 * Mapping Anthropic SDK errors onto HTTP responses.
 *
 * TEACHING NOTE: catch a CHAIN, most-specific first — never one broad class,
 * and never string-match on `error.message`. The distinction that matters to
 * your caller is retryable (429, 5xx, connection) vs. not (400, 401, 404).
 * Collapsing them into `catch (e) { 500 }` means your clients cannot back off
 * correctly and your on-call cannot tell an outage from a bad request.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface ApiErrorBody {
  error: string;
  detail: string;
  /** Whether the caller should retry this exact request. */
  retryable: boolean;
}

export function toHttpError(err: unknown): { status: number; body: ApiErrorBody } {
  if (err instanceof Anthropic.AuthenticationError) {
    return {
      status: 500, // the caller's key isn't the problem — ours is
      body: {
        error: "upstream_auth_failed",
        detail: "The service's Anthropic credentials were rejected. Check ANTHROPIC_API_KEY.",
        retryable: false,
      },
    };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return {
      status: 429,
      body: {
        error: "rate_limited",
        detail: "Upstream rate limit reached. Retry with exponential backoff.",
        retryable: true,
      },
    };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return {
      status: 400,
      body: {
        error: "invalid_request",
        detail: err.message,
        retryable: false,
      },
    };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return {
      status: 503,
      body: {
        error: "upstream_unreachable",
        detail: "Could not reach the Anthropic API.",
        retryable: true,
      },
    };
  }
  if (err instanceof Anthropic.APIError) {
    return {
      status: err.status && err.status >= 500 ? 502 : 400,
      body: {
        error: "upstream_error",
        detail: `Anthropic API error ${err.status ?? "unknown"}: ${err.message}`,
        retryable: (err.status ?? 500) >= 500,
      },
    };
  }
  return {
    status: 500,
    body: {
      error: "internal_error",
      detail: err instanceof Error ? err.message : String(err),
      retryable: false,
    },
  };
}
