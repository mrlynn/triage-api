/**
 * Minimal Server-Sent Events writer.
 *
 * TEACHING NOTE: streaming does NOT require the edge runtime, a websocket, or
 * any special infrastructure. It is an HTTP response with
 * `Content-Type: text/event-stream` that you never close until you're done.
 * The mandatory bits are the header set below — especially
 * `X-Accel-Buffering: no`, without which an nginx in front of you will buffer
 * the whole stream and deliver it as one chunk, making your streaming feature
 * work perfectly in dev and not at all in production.
 */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
