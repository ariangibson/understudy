import { createHash } from "node:crypto";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChunkToolCall,
  FinishReason,
  TokenUsage,
  ToolCall,
} from "./types.js";

/**
 * Exact-match response cache. Identical requests within the TTL are served
 * from memory — instantly and at zero cost — including streaming requests,
 * which get the cached completion replayed as synthesized SSE.
 *
 * The key deliberately ignores `stream`, `stream_options`, and `fallbacks`:
 * a streamed and a non-streamed request for the same prompt share one entry,
 * and fallback preferences don't change what the primary model would say.
 */
export function cacheKey(req: ChatCompletionRequest): string {
  const {
    stream: _s,
    stream_options: _so,
    fallbacks: _f,
    ...significant
  } = req;
  return createHash("sha256")
    .update(stableStringify(significant))
    .digest("hex");
}

/** JSON.stringify with sorted object keys, so key order can't split entries. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, function replacer(_key, val) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

interface CacheEntry {
  body: ChatCompletionResponse;
  expires: number;
}

export class ResponseCache {
  private entries = new Map<string, CacheEntry>();

  constructor(
    private ttlMs: number,
    private maxEntries: number,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get(key: string): ChatCompletionResponse | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expires) {
      this.entries.delete(key);
      return null;
    }
    // Refresh LRU position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.body;
  }

  set(key: string, body: ChatCompletionResponse): void {
    if (!this.enabled) return;
    this.entries.delete(key);
    this.entries.set(key, { body, expires: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// Assembling a full completion out of streamed chunks (to populate the cache)

export class ChunkAssembler {
  private id = "";
  private model = "";
  private created = 0;
  private content = "";
  private toolCalls = new Map<number, ToolCall>();
  private finishReason: FinishReason = null;
  private usage: TokenUsage | null = null;

  feed(chunk: ChatCompletionChunk): void {
    if (chunk.id) this.id = chunk.id;
    if (chunk.model) this.model = chunk.model;
    if (chunk.created) this.created = chunk.created;
    if (chunk.usage) this.usage = chunk.usage;

    const choice = chunk.choices[0];
    if (!choice) return;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    if (choice.delta.content) this.content += choice.delta.content;
    for (const tc of choice.delta.tool_calls ?? []) {
      const existing = this.toolCalls.get(tc.index);
      if (existing) {
        existing.function.arguments += tc.function?.arguments ?? "";
      } else {
        this.toolCalls.set(tc.index, {
          id: tc.id ?? "",
          type: "function",
          function: {
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "",
          },
        });
      }
    }
  }

  /** Returns the assembled completion, or null if the stream never finished. */
  result(): ChatCompletionResponse | null {
    if (!this.finishReason) return null;
    const toolCalls = [...this.toolCalls.values()];
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created || Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: this.content || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: this.finishReason,
        },
      ],
      usage: this.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Tee an outgoing OpenAI-format SSE stream: bytes pass through untouched
 * while data lines are parsed into an assembler. When the stream completes
 * cleanly, `onComplete` fires with the assembled response.
 */
export function observeSSE(
  stream: ReadableStream<Uint8Array>,
  onComplete: (body: ChatCompletionResponse) => void,
): ReadableStream<Uint8Array> {
  const assembler = new ChunkAssembler();
  let buffer = "";

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            assembler.feed(JSON.parse(payload));
          } catch {
            // non-chunk or partial line — ignore
          }
        }
      },
      flush() {
        const body = assembler.result();
        if (body) onComplete(body);
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Replaying a cached completion as a synthesized SSE stream

export function synthesizeSSE(
  body: ChatCompletionResponse,
): ReadableStream<Uint8Array> {
  const choice = body.choices[0];
  const base = {
    id: body.id,
    object: "chat.completion.chunk" as const,
    created: body.created,
    model: body.model,
  };

  const chunks: ChatCompletionChunk[] = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
  ];

  if (choice?.message.content) {
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }],
    });
  }

  if (choice?.message.tool_calls?.length) {
    const deltas: ChunkToolCall[] = choice.message.tool_calls.map((tc, i) => ({
      index: i,
      id: tc.id,
      type: "function",
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { tool_calls: deltas }, finish_reason: null }],
    });
  }

  chunks.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason ?? "stop" }],
    usage: body.usage,
  });

  const payload =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}
