/**
 * SSE plumbing shared by the protocol front doors. The chat-completions
 * adapters move SSE as opaque bytes; the Anthropic and Responses front
 * doors need to re-dialect streams, which means parsing chunk objects out
 * of one byte stream and encoding named events into another.
 */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Parse an OpenAI-format SSE byte stream into its `data:` JSON payloads.
 * Stops cleanly at `data: [DONE]`; unparseable lines are skipped.
 */
export async function* parseSSEData<T>(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  let buffer = "";
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload) as T;
        } catch {
          // partial or non-JSON line — ignore
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface NamedEvent {
  event: string;
  data: unknown;
}

/**
 * Encode named events (`event: x\ndata: {...}\n\n`) as an SSE byte stream —
 * the framing both the Anthropic Messages API and the Responses API use.
 */
export function namedEventStream(
  events: AsyncGenerator<NamedEvent>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(`event: ${value.event}\ndata: ${JSON.stringify(value.data)}\n\n`),
        );
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });
}
