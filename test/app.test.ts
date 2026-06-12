import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * App-level tests. Provider HTTP calls are intercepted by stubbing global
 * fetch; provider keys are injected via process.env (read lazily by config).
 */

async function freshApp(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv("USAGE_LOG", `/tmp/llm-proxy-test-${Date.now()}-${Math.random()}.jsonl`);
  const { createApp } = await import("../src/app.js");
  return createApp();
}

const chatBody = (model: string, extra: object = {}) =>
  JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra });

function fakeCompletion(model: string, content = "hello") {
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

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("auth", () => {
  it("rejects requests without a valid key when GATEWAY_API_KEYS is set", async () => {
    const app = await freshApp({ GATEWAY_API_KEYS: "secret-1,secret-2" });
    const denied = await app.request("/v1/models");
    expect(denied.status).toBe(401);

    const health = await app.request("/health");
    expect(health.status).toBe(200); // health stays public
  });

  it("accepts a valid Bearer key", async () => {
    const app = await freshApp({ GATEWAY_API_KEYS: "secret-1" });
    const res = await app.request("/health"); // sanity
    expect(res.status).toBe(200);

    const usage = await app.request("/v1/usage", {
      headers: { authorization: "Bearer secret-1" },
    });
    expect(usage.status).toBe(200);
  });
});

describe("routing errors", () => {
  it("400s on an unroutable model with a helpful message", async () => {
    const app = await freshApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("mystery-model-9000"),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("provider/model");
  });

  it("503s when the provider has no API key configured", async () => {
    const app = await freshApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("gpt-5.5"),
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("OPENAI_API_KEY");
  });
});

describe("chat completions via openai-compatible provider", () => {
  it("forwards the request and returns the provider response", async () => {
    const app = await freshApp({ OPENAI_API_KEY: "sk-test" });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
      const sent = JSON.parse(String(init?.body));
      expect(sent.model).toBe("gpt-5.5"); // provider prefix stripped
      expect(sent.fallbacks).toBeUndefined(); // gateway extension stripped
      return new Response(JSON.stringify(fakeCompletion("gpt-5.5")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("openai/gpt-5.5", { fallbacks: [] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ReturnType<typeof fakeCompletion>;
    expect(json.choices[0]?.message.content).toBe("hello");
  });

  it("sends max_completion_tokens (not max_tokens) to OpenAI proper", async () => {
    const app = await freshApp({ OPENAI_API_KEY: "sk-test" });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.max_tokens).toBeUndefined();
      expect(sent.max_completion_tokens).toBe(1024);
      return new Response(JSON.stringify(fakeCompletion("gpt-5.5")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("gpt-5.5", { max_tokens: 1024 }),
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the next model on a retryable provider error", async () => {
    const app = await freshApp({ OPENAI_API_KEY: "sk-test", GROQ_API_KEY: "gk-test" });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        calls.push(String(url));
        if (String(url).includes("openai.com")) {
          return new Response(JSON.stringify({ error: { message: "overloaded" } }), {
            status: 529,
          });
        }
        return new Response(JSON.stringify(fakeCompletion("llama-4-maverick", "from groq")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("openai/gpt-5.5", { fallbacks: ["groq/llama-4-maverick"] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ReturnType<typeof fakeCompletion>;
    expect(json.choices[0]?.message.content).toBe("from groq");
    expect(calls).toHaveLength(2);
  });

  it("applies the server-configured FALLBACK_CHAIN to plain requests", async () => {
    const app = await freshApp({
      OPENAI_API_KEY: "sk-test",
      GROQ_API_KEY: "gk-test",
      FALLBACK_CHAIN: "groq/llama-4-maverick",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("openai.com")) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
          });
        }
        return new Response(JSON.stringify(fakeCompletion("llama-4-maverick", "rescued")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    // Note: no `fallbacks` field — exactly what an agent harness sends.
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("gpt-5.5"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-understudy-provider")).toBe("groq");
    expect(res.headers.get("x-understudy-fallback")).toBe("from openai/gpt-5.5");
    const json = (await res.json()) as ReturnType<typeof fakeCompletion>;
    expect(json.choices[0]?.message.content).toBe("rescued");
  });

  it("benches a rate-limited model so the next request skips it entirely", async () => {
    const app = await freshApp({
      OPENAI_API_KEY: "sk-test",
      GROQ_API_KEY: "gk-test",
      FALLBACK_CHAIN: "groq/llama-4-maverick",
      CACHE_TTL_S: "0", // isolate cooldown behavior from the cache
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        calls.push(new URL(String(url)).hostname);
        if (String(url).includes("openai.com")) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "retry-after": "60" },
          });
        }
        return new Response(JSON.stringify(fakeCompletion("llama-4-maverick", "ok")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const post = () =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("gpt-5.5"),
      });

    // First request: OpenAI 429s (benched for 60s), Groq serves.
    expect((await post()).status).toBe(200);
    // Second request: goes straight to Groq — OpenAI is not retried.
    expect((await post()).status).toBe(200);
    expect(calls).toEqual(["api.openai.com", "api.groq.com", "api.groq.com"]);

    // The bench is visible in /health.
    const health = (await (await app.request("/health")).json()) as {
      cooldowns: Record<string, number>;
    };
    expect(health.cooldowns["openai/gpt-5.5"]).toBeGreaterThan(0);
  });

  it("does not fall back on a non-retryable error (e.g. 400)", async () => {
    const app = await freshApp({ OPENAI_API_KEY: "sk-test", GROQ_API_KEY: "gk-test" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "bad schema" } }), { status: 400 }),
      ),
    );

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("openai/gpt-5.5", { fallbacks: ["groq/llama-4-maverick"] }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string; provider?: string } };
    expect(json.error.message).toBe("bad schema");
    expect(json.error.provider).toBe("openai");
  });

  it("pipes streaming SSE through and surfaces the provider header", async () => {
    const app = await freshApp({ OPENAI_API_KEY: "sk-test" });
    const sse = [
      `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}`,
      `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
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

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("gpt-5.5", { stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-understudy-provider")).toBe("openai");
    const text = await res.text();
    expect(text).toContain('"content":"hi"');
    expect(text).toContain("data: [DONE]");
  });
});

describe("response cache", () => {
  it("serves an identical request from cache without a second provider call", async () => {
    const app = await freshApp({ OPENAI_API_KEY: "sk-test" });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(fakeCompletion("gpt-5.5")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const post = () =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("gpt-5.5"),
      });

    const first = await post();
    expect(first.headers.get("x-understudy-cache")).toBe("miss");
    await first.json();

    const second = await post();
    expect(second.headers.get("x-understudy-cache")).toBe("hit");
    const json = (await second.json()) as ReturnType<typeof fakeCompletion>;
    expect(json.choices[0]?.message.content).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("replays a cached completion as a synthesized SSE stream", async () => {
    const app = await freshApp({ OPENAI_API_KEY: "sk-test" });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(fakeCompletion("gpt-5.5", "cached text")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Populate via a non-stream request, then hit with stream: true.
    await (
      await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("gpt-5.5"),
      })
    ).json();

    const streamed = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("gpt-5.5", { stream: true }),
    });
    expect(streamed.headers.get("x-understudy-cache")).toBe("hit");
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const text = await streamed.text();
    expect(text).toContain('"cached text"');
    expect(text).toContain("data: [DONE]");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors the x-understudy-cache: bypass header", async () => {
    const app = await freshApp({ OPENAI_API_KEY: "sk-test" });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(fakeCompletion("gpt-5.5")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const post = (headers: Record<string, string> = {}) =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: chatBody("gpt-5.5"),
      });

    await (await post()).json();
    const bypassed = await post({ "x-understudy-cache": "bypass" });
    expect(bypassed.headers.get("x-understudy-cache")).not.toBe("hit");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("can be disabled entirely with CACHE_TTL_S=0", async () => {
    const app = await freshApp({ OPENAI_API_KEY: "sk-test", CACHE_TTL_S: "0" });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(fakeCompletion("gpt-5.5")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const post = () =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("gpt-5.5"),
      });

    await (await post()).json();
    await (await post()).json();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
