import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheKey,
  ChunkAssembler,
  observeSSE,
  ResponseCache,
  synthesizeSSE,
} from "../src/cache.js";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../src/types.js";

const req: ChatCompletionRequest = {
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "hi" }],
};

const completion: ChatCompletionResponse = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "claude-sonnet-4-6",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hello there" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
};

describe("cacheKey", () => {
  it("ignores stream, stream_options, and fallbacks", () => {
    const base = cacheKey(req);
    expect(cacheKey({ ...req, stream: true })).toBe(base);
    expect(cacheKey({ ...req, stream_options: { include_usage: true } })).toBe(base);
    expect(cacheKey({ ...req, fallbacks: ["openai/gpt-5.5"] })).toBe(base);
  });

  it("is sensitive to model, messages, and sampling params", () => {
    const base = cacheKey(req);
    expect(cacheKey({ ...req, model: "gpt-5.5" })).not.toBe(base);
    expect(cacheKey({ ...req, messages: [{ role: "user", content: "yo" }] })).not.toBe(base);
    expect(cacheKey({ ...req, temperature: 0.9 })).not.toBe(base);
  });

  it("does not depend on object key order", () => {
    const a = cacheKey({ model: "m", messages: [{ role: "user", content: "x" }], temperature: 1 });
    const b = cacheKey({ temperature: 1, messages: [{ role: "user", content: "x" }], model: "m" } as ChatCompletionRequest);
    expect(a).toBe(b);
  });
});

describe("ResponseCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns entries until the TTL expires", () => {
    const cache = new ResponseCache(1000, 10);
    cache.set("k", completion);
    expect(cache.get("k")).toEqual(completion);
    vi.advanceTimersByTime(1001);
    expect(cache.get("k")).toBeNull();
  });

  it("evicts the least recently used entry at capacity", () => {
    const cache = new ResponseCache(60_000, 2);
    cache.set("a", completion);
    cache.set("b", completion);
    cache.get("a"); // refresh a → b becomes LRU
    cache.set("c", completion);
    expect(cache.get("a")).not.toBeNull();
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).not.toBeNull();
  });

  it("is disabled when ttl is 0", () => {
    const cache = new ResponseCache(0, 10);
    expect(cache.enabled).toBe(false);
    cache.set("k", completion);
    expect(cache.get("k")).toBeNull();
  });
});

describe("ChunkAssembler", () => {
  it("reassembles content, tool calls, finish reason, and usage from chunks", () => {
    const chunks: ChatCompletionChunk[] = [
      mk({ role: "assistant", content: "" }),
      mk({ content: "Hel" }),
      mk({ content: "lo" }),
      mk({
        tool_calls: [
          { index: 0, id: "t1", type: "function", function: { name: "f", arguments: '{"a"' } },
        ],
      }),
      mk({ tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }),
      {
        ...mk({}),
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
      },
    ];
    const assembler = new ChunkAssembler();
    chunks.forEach((c) => assembler.feed(c));
    const result = assembler.result();
    expect(result?.choices[0]?.message.content).toBe("Hello");
    expect(result?.choices[0]?.message.tool_calls).toEqual([
      { id: "t1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
    ]);
    expect(result?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(result?.usage).toEqual({ prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 });
  });

  it("returns null when the stream never reached a finish_reason", () => {
    const assembler = new ChunkAssembler();
    assembler.feed(mk({ content: "partial" }));
    expect(assembler.result()).toBeNull();
  });
});

describe("observeSSE / synthesizeSSE round trip", () => {
  it("a synthesized stream reassembles into the original completion", async () => {
    let assembled: ChatCompletionResponse | null = null;
    const observed = observeSSE(synthesizeSSE(completion), (b) => (assembled = b));

    const text = await new Response(observed).text();
    expect(text).toContain('"hello there"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

    expect(assembled).not.toBeNull();
    expect(assembled!.choices[0]?.message.content).toBe("hello there");
    expect(assembled!.usage).toEqual(completion.usage);
    expect(assembled!.choices[0]?.finish_reason).toBe("stop");
  });
});

function mk(delta: ChatCompletionChunk["choices"][0]["delta"]): ChatCompletionChunk {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "claude-sonnet-4-6",
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}
