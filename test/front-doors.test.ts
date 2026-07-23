import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * App-level tests for the Anthropic Messages and OpenAI Responses front
 * doors — the endpoints that let unmodified Claude Code and Codex sessions
 * fail over across providers. Provider HTTP is stubbed via global fetch.
 */

async function freshApp(env: Record<string, string> = {}) {
  vi.resetModules();
  // Neutralize upstream overrides a dev shell may have exported (e.g. after
  // a rehearsal/ run) so provider URLs are deterministic under test.
  vi.stubEnv("UNDERSTUDY_OPENAI_UPSTREAM", "");
  vi.stubEnv("UNDERSTUDY_ANTHROPIC_UPSTREAM", "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv("USAGE_LOG", `/tmp/llm-proxy-test-${Date.now()}-${Math.random()}.jsonl`);
  const { createApp } = await import("../src/app.js");
  return createApp();
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const messagesBody = (model: string, extra: object = {}) =>
  JSON.stringify({
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...extra,
  });

function anthropicMessage(content = "hello from claude") {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: content }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 5 },
  };
}

function openaiCompletion(model: string, content = "hello from fallback") {
  return {
    id: "chatcmpl-x",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
}

describe("/v1/messages — Anthropic passthrough", () => {
  it("forwards to api.anthropic.com with the server key and strips oauth betas", async () => {
    const app = await freshApp({ ANTHROPIC_API_KEY: "sk-ant-key" });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.anthropic.com/v1/messages?beta=true");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-ant-key");
      expect(headers.authorization).toBeUndefined();
      expect(headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
      const sent = JSON.parse(String(init?.body));
      expect(sent.model).toBe("claude-sonnet-4-6");
      expect(sent.fallbacks).toBeUndefined();
      return new Response(JSON.stringify(anthropicMessage()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/v1/messages?beta=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
      },
      body: messagesBody("claude-sonnet-4-6", { fallbacks: [] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content: Array<{ text: string }> };
    expect(json.content[0]?.text).toBe("hello from claude");
    expect(res.headers.get("x-understudy-provider")).toBe("anthropic");
  });

  it("forwards a client OAuth token untouched, even with no server key", async () => {
    const app = await freshApp({ GATEWAY_API_KEYS: "gw-secret" }); // no ANTHROPIC_API_KEY
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer sk-ant-oat01-token");
      expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20,claude-code-20250219");
      expect(headers["x-api-key"]).toBeUndefined();
      return new Response(JSON.stringify(anthropicMessage()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Note: the OAuth bearer also passes gateway auth — it is its own credential.
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-ant-oat01-token",
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
      },
      body: messagesBody("claude-sonnet-4-6"),
    });
    expect(res.status).toBe(200);
  });

  it("pipes streaming SSE bytes through untouched", async () => {
    const app = await freshApp({ ANTHROPIC_API_KEY: "sk-ant-key" });
    const sse = [
      `event: message_start`,
      `data: {"type":"message_start","message":{"id":"msg_01","usage":{"input_tokens":3}}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
      ``,
      `event: message_delta`,
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`,
      ``,
      `event: message_stop`,
      `data: {"type":"message_stop"}`,
      ``,
      ``,
    ].join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messagesBody("claude-sonnet-4-6", { stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toBe(sse);
  });
});

describe("/v1/messages — cross-provider failover", () => {
  it("fails over to an OpenAI-compatible provider and answers in Anthropic shape", async () => {
    const app = await freshApp({
      ANTHROPIC_API_KEY: "sk-ant-key",
      DEEPSEEK_API_KEY: "dk-test",
      FALLBACK_CHAIN: "deepseek/deepseek-chat",
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new URL(String(url)).hostname);
        if (String(url).includes("anthropic.com")) {
          return new Response(
            JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
            { status: 429, headers: { "retry-after": "30" } },
          );
        }
        // DeepSeek receives the *translated* chat-completions request.
        const sent = JSON.parse(String(init?.body));
        expect(sent.model).toBe("deepseek-chat");
        expect(sent.messages.at(-1)).toEqual({ role: "user", content: "hi" });
        return new Response(JSON.stringify(openaiCompletion("deepseek-chat", "rescued")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messagesBody("claude-sonnet-4-6"),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["api.anthropic.com", "api.deepseek.com"]);
    expect(res.headers.get("x-understudy-provider")).toBe("deepseek");
    expect(res.headers.get("x-understudy-fallback")).toBe("from anthropic/claude-sonnet-4-6");

    const json = (await res.json()) as {
      type: string;
      model: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
    };
    expect(json.type).toBe("message"); // Anthropic shape, not chat.completion
    expect(json.model).toBe("claude-sonnet-4-6"); // echoes the requested model
    expect(json.content).toEqual([{ type: "text", text: "rescued" }]);
    expect(json.stop_reason).toBe("end_turn");
  });

  it("re-dialects a fallback SSE stream as Anthropic events", async () => {
    const app = await freshApp({
      ANTHROPIC_API_KEY: "sk-ant-key",
      DEEPSEEK_API_KEY: "dk-test",
      FALLBACK_CHAIN: "deepseek/deepseek-chat",
    });
    const openaiSSE = [
      `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"res"},"finish_reason":null}]}`,
      `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"cued"},"finish_reason":null}]}`,
      `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("anthropic.com")) {
          return new Response("overloaded", { status: 529 });
        }
        return new Response(openaiSSE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messagesBody("claude-sonnet-4-6", { stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text_delta","text":"res"');
    expect(text).toContain('"text_delta","text":"cued"');
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain("event: message_stop");
    // The client asked for a Claude model and must see one in message_start.
    expect(text).toContain('"model":"claude-sonnet-4-6"');
  });
});

describe("/v1/responses — Codex front door", () => {
  const responsesBody = (model: string, extra: object = {}) =>
    JSON.stringify({
      model,
      instructions: "You are Codex.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
      tools: [],
      tool_choice: "auto",
      store: false,
      stream: false,
      ...extra,
    });

  it("translates to chat completions and back to a Responses object", async () => {
    const app = await freshApp({ OPENAI_API_KEY: "sk-test" });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
      const sent = JSON.parse(String(init?.body));
      expect(sent.messages[0]).toEqual({ role: "system", content: "You are Codex." });
      expect(sent.messages[1]).toEqual({ role: "user", content: "hi" });
      return new Response(JSON.stringify(openaiCompletion("gpt-5-mini", "hi there")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: responsesBody("gpt-5-mini"),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      object: string;
      status: string;
      output: Array<{ type: string; content: Array<{ text: string }> }>;
    };
    expect(json.object).toBe("response");
    expect(json.status).toBe("completed");
    expect(json.output[0]?.content[0]?.text).toBe("hi there");
  });

  it("serves Codex from a chat-completions-only host (synthetic.new)", async () => {
    const app = await freshApp({ SYNTHETIC_API_KEY: "syn-test" });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.synthetic.new/openai/v1/chat/completions");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer syn-test");
      const sent = JSON.parse(String(init?.body));
      expect(sent.model).toBe("syn:large:vision");
      return new Response(
        JSON.stringify(openaiCompletion("syn:large:vision", "open model here")),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: responsesBody("syn:large:vision"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-understudy-provider")).toBe("synthetic");
    const json = (await res.json()) as {
      object: string;
      output: Array<{ content: Array<{ text: string }> }>;
    };
    expect(json.object).toBe("response");
    expect(json.output[0]?.content[0]?.text).toBe("open model here");
  });

  it("streams Responses events and fails over across providers", async () => {
    const app = await freshApp({
      OPENAI_API_KEY: "sk-test",
      ANTHROPIC_API_KEY: "sk-ant-key",
      FALLBACK_CHAIN: "anthropic/claude-sonnet-4-6",
    });
    const anthropicSSE = [
      `event: message_start`,
      `data: {"type":"message_start","message":{"id":"msg_01","usage":{"input_tokens":3}}}`,
      ``,
      `event: content_block_start`,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"claude to the rescue"}}`,
      ``,
      `event: message_delta`,
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}`,
      ``,
      `event: message_stop`,
      `data: {"type":"message_stop"}`,
      ``,
      ``,
    ].join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("openai.com")) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
          });
        }
        expect(String(url)).toContain("api.anthropic.com/v1/messages");
        return new Response(anthropicSSE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: responsesBody("gpt-5-mini", { stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-understudy-provider")).toBe("anthropic");
    expect(res.headers.get("x-understudy-fallback")).toBe("from openai/gpt-5-mini");

    const text = await res.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain('"delta":"claude to the rescue"');
    expect(text).toContain("event: response.completed");
  });
});

describe("MODEL_OVERRIDES", () => {
  it("rewrites the requested model before routing", async () => {
    const app = await freshApp({
      GROQ_API_KEY: "gk-test",
      MODEL_OVERRIDES: "claude-3-5-haiku*=groq/llama-3.3-70b",
    });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.groq.com/openai/v1/chat/completions");
      const sent = JSON.parse(String(init?.body));
      expect(sent.model).toBe("llama-3.3-70b");
      return new Response(JSON.stringify(openaiCompletion("llama-3.3-70b", "overridden")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-understudy-provider")).toBe("groq");
  });

  it("applies on the Messages front door too, answering in Anthropic shape", async () => {
    const app = await freshApp({
      DEEPSEEK_API_KEY: "dk-test",
      MODEL_OVERRIDES: "claude-*=deepseek/deepseek-chat",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(openaiCompletion("deepseek-chat", "ds answer")), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messagesBody("claude-sonnet-4-6"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-understudy-provider")).toBe("deepseek");
    const json = (await res.json()) as { type: string; content: Array<{ text: string }> };
    expect(json.type).toBe("message");
    expect(json.content[0]?.text).toBe("ds answer");
  });
});

describe("/v1/messages/count_tokens", () => {
  it("estimates locally when no upstream key is configured", async () => {
    const app = await freshApp();
    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messagesBody("claude-sonnet-4-6"),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { input_tokens: number };
    expect(json.input_tokens).toBeGreaterThan(0);
  });
});
