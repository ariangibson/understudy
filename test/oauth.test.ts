import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OAuth credential tests. Stored tokens with a future expiry are used as-is
 * (pi-ai only refreshes when expired), so no network is involved here.
 */

function tempAuthFile(creds: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "understudy-oauth-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(creds));
  return path;
}

const freshAnthropicCreds = {
  anthropic: {
    refresh: "rt-1",
    access: "sk-ant-oat01-stored-token",
    expires: Date.now() + 60 * 60_000,
  },
};

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("oauth module", () => {
  it("resolves a stored, unexpired token without refreshing", async () => {
    vi.stubEnv("UNDERSTUDY_AUTH", tempAuthFile(freshAnthropicCreds));
    const { hasOAuth, oauthApiKey } = await import("../src/oauth.js");
    expect(hasOAuth("anthropic")).toBe(true);
    expect(hasOAuth("copilot")).toBe(false);
    expect(await oauthApiKey("anthropic")).toBe("sk-ant-oat01-stored-token");
  });

  it("reports nothing configured when there is no auth file", async () => {
    vi.stubEnv("UNDERSTUDY_AUTH", "/nonexistent/auth.json");
    const { hasOAuth, oauthApiKey } = await import("../src/oauth.js");
    expect(hasOAuth("anthropic")).toBe(false);
    expect(await oauthApiKey("anthropic")).toBeNull();
  });

  it("writes credentials with owner-only permissions", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "understudy-oauth-")), "auth.json");
    vi.stubEnv("UNDERSTUDY_AUTH", path);
    const { saveCredentials } = await import("../src/oauth.js");
    saveCredentials("anthropic", { refresh: "r", access: "a", expires: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).anthropic.access).toBe("a");
  });

  it("derives the Copilot API host from the token's proxy-ep", async () => {
    const { copilotBaseUrl } = await import("../src/oauth.js");
    expect(copilotBaseUrl("tid=x;exp=1;proxy-ep=proxy.individual.githubcopilot.com;sku=y")).toBe(
      "https://api.individual.githubcopilot.com",
    );
    expect(copilotBaseUrl("no-proxy-marker")).toBe(
      "https://api.individual.githubcopilot.com",
    );
  });
});

describe("gateway with OAuth credentials", () => {
  it("treats anthropic as configured and signs passthrough with the stored token", async () => {
    vi.stubEnv("UNDERSTUDY_AUTH", tempAuthFile(freshAnthropicCreds));
    vi.stubEnv("USAGE_LOG", `/tmp/llm-proxy-test-${Date.now()}-${Math.random()}.jsonl`);
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer sk-ant-oat01-stored-token");
      expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
      expect(headers["x-api-key"]).toBeUndefined();
      return new Response(
        JSON.stringify({
          id: "msg_01",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "via subscription" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content: Array<{ text: string }> };
    expect(json.content[0]?.text).toBe("via subscription");
  });

  it("drives the ChatGPT Codex backend with a stored subscription token", async () => {
    // The access token is a JWT whose claims carry the chatgpt account id.
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-42" } }),
    ).toString("base64url");
    const jwt = `header.${claims}.sig`;
    vi.stubEnv(
      "UNDERSTUDY_AUTH",
      tempAuthFile({
        "openai-codex": { refresh: "rt", access: jwt, expires: Date.now() + 60 * 60_000 },
      }),
    );
    vi.stubEnv("USAGE_LOG", `/tmp/llm-proxy-test-${Date.now()}-${Math.random()}.jsonl`);
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const backendSSE = [
      `event: response.created`,
      `data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`,
      ``,
      `event: response.output_text.delta`,
      `data: {"type":"response.output_text.delta","delta":"subscribed hello"}`,
      ``,
      `event: response.completed`,
      `data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}`,
      ``,
      ``,
    ].join("\n");

    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${jwt}`);
      expect(headers["chatgpt-account-id"]).toBe("acc-42");
      expect(headers["OpenAI-Beta"]).toBe("responses=experimental");
      const sent = JSON.parse(String(init?.body));
      expect(sent.stream).toBe(true); // backend is stream-only
      expect(sent.store).toBe(false);
      expect(sent.instructions).toBeTruthy();
      return new Response(backendSSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Non-streaming client request: the adapter assembles the stream.
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt/gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number };
    };
    expect(json.choices[0]?.message.content).toBe("subscribed hello");
    expect(json.usage.prompt_tokens).toBe(7);
  });

  it("rescues a rate-limited /v1/messages request with the ChatGPT subscription", async () => {
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-42" } }),
    ).toString("base64url");
    const jwt = `header.${claims}.sig`;
    vi.stubEnv(
      "UNDERSTUDY_AUTH",
      tempAuthFile({
        "openai-codex": { refresh: "rt", access: jwt, expires: Date.now() + 60 * 60_000 },
      }),
    );
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-key");
    vi.stubEnv("FALLBACK_CHAIN", "chatgpt/gpt-5.5");
    vi.stubEnv("USAGE_LOG", `/tmp/llm-proxy-test-${Date.now()}-${Math.random()}.jsonl`);
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const backendSSE = [
      `data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`,
      `data: {"type":"response.output_text.delta","delta":"the show goes on"}`,
      `data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":5,"output_tokens":4,"total_tokens":9}}}`,
      ``,
      ``,
    ].join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes("anthropic.com")) {
          return new Response("rate limited", { status: 429 });
        }
        expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
        return new Response(backendSSE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-understudy-provider")).toBe("chatgpt");
    expect(res.headers.get("x-understudy-fallback")).toBe("from anthropic/claude-sonnet-4-6");
    const json = (await res.json()) as {
      type: string;
      model: string;
      content: Array<{ type: string; text: string }>;
    };
    expect(json.type).toBe("message"); // Anthropic shape for the Anthropic client
    expect(json.model).toBe("claude-sonnet-4-6");
    expect(json.content[0]?.text).toBe("the show goes on");
  });

  it("uses a stored Copilot token with the required headers and derived host", async () => {
    vi.stubEnv(
      "UNDERSTUDY_AUTH",
      tempAuthFile({
        "github-copilot": {
          refresh: "gh-rt",
          access: "tid=x;exp=1;proxy-ep=proxy.individual.githubcopilot.com;sku=pro",
          expires: Date.now() + 60 * 60_000,
        },
      }),
    );
    vi.stubEnv("USAGE_LOG", `/tmp/llm-proxy-test-${Date.now()}-${Math.random()}.jsonl`);
    const { createApp } = await import("../src/app.js");
    const app = createApp();

    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://api.individual.githubcopilot.com/chat/completions",
      );
      const headers = init?.headers as Record<string, string>;
      expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
      expect(headers.authorization).toContain("Bearer tid=x");
      return new Response(
        JSON.stringify({
          id: "chatcmpl-c",
          object: "chat.completion",
          created: 1,
          model: "gpt-4.1",
          choices: [
            { index: 0, message: { role: "assistant", content: "copilot says hi" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "copilot/gpt-4.1",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]?.message.content).toBe("copilot says hi");
  });
});
