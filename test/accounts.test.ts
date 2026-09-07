import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Several subscription seats on one provider: the credential store keeps
 * them all, sessions are dealt across them and stick, and the circuit
 * breaker benches one seat at a time.
 */

function codexJwt(accountId: string, email?: string): string {
  const claims = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      ...(email ? { "https://api.openai.com/profile": { email } } : {}),
    }),
  ).toString("base64url");
  return `header.${claims}.sig`;
}

function tempAuthFile(creds: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "understudy-accounts-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(creds));
  return path;
}

const fresh = (access: string) => ({ refresh: "rt", access, expires: Date.now() + 3_600_000 });

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("credential store", () => {
  it("reads the original single-object format and the list format", async () => {
    vi.stubEnv(
      "UNDERSTUDY_AUTH",
      tempAuthFile({
        "openai-codex": fresh(codexJwt("acc-1", "one@example.com")),
        anthropic: [fresh("sk-ant-oat01-a"), fresh("sk-ant-oat01-b")],
      }),
    );
    const { oauthAccounts, oauthAccountSummary } = await import("../src/oauth.js");
    expect(oauthAccounts("chatgpt").map((a) => a.id)).toEqual(["one@example.com"]);
    expect(oauthAccounts("anthropic")).toHaveLength(2);
    expect(oauthAccountSummary().anthropic).toHaveLength(2);
    expect(oauthAccountSummary().copilot).toBeUndefined();
  });

  it("appends a second seat on login and replaces a re-login of the same seat", async () => {
    const path = tempAuthFile({});
    vi.stubEnv("UNDERSTUDY_AUTH", path);
    const { saveCredentials, oauthAccounts, clearCredentials } = await import("../src/oauth.js");

    saveCredentials("openai-codex", fresh(codexJwt("acc-1")));
    saveCredentials("openai-codex", fresh(codexJwt("acc-2")));
    expect(oauthAccounts("chatgpt").map((a) => a.id)).toEqual(["acc-1", "acc-2"]);

    // Same account again: refreshed in place, not duplicated, order kept.
    saveCredentials("openai-codex", { ...fresh(codexJwt("acc-1")), refresh: "rt-new" });
    const seats = oauthAccounts("chatgpt");
    expect(seats.map((a) => a.id)).toEqual(["acc-1", "acc-2"]);
    expect(seats[0]?.refresh).toBe("rt-new");

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(Array.isArray(onDisk["openai-codex"])).toBe(true);

    clearCredentials("openai-codex");
    expect(oauthAccounts("chatgpt")).toEqual([]);
  });

  it("resolves a token for a specific seat, defaulting to the first", async () => {
    vi.stubEnv(
      "UNDERSTUDY_AUTH",
      tempAuthFile({
        "openai-codex": [fresh(codexJwt("acc-1")), fresh(codexJwt("acc-2"))],
      }),
    );
    const { oauthApiKey } = await import("../src/oauth.js");
    expect(await oauthApiKey("chatgpt")).toBe(codexJwt("acc-1"));
    expect(await oauthApiKey("chatgpt", "acc-2")).toBe(codexJwt("acc-2"));
    expect(await oauthApiKey("chatgpt", "acc-nope")).toBeNull();
  });
});

describe("AccountRotation", () => {
  it("deals new sessions round-robin and keeps each session on its seat", async () => {
    const { AccountRotation } = await import("../src/accounts.js");
    const r = new AccountRotation();
    const ids = ["a", "b", "c"];
    expect(r.order("chatgpt", ids, "s1")).toEqual(["a", "b", "c"]);
    expect(r.order("chatgpt", ids, "s2")).toEqual(["b", "c", "a"]);
    expect(r.order("chatgpt", ids, "s3")).toEqual(["c", "a", "b"]);
    expect(r.order("chatgpt", ids, "s4")).toEqual(["a", "b", "c"]);
    // Later turns of s2 stay on b; the ring counter is untouched.
    expect(r.order("chatgpt", ids, "s2")).toEqual(["b", "c", "a"]);
    expect(r.order("chatgpt", ids, "s5")).toEqual(["b", "c", "a"]);
  });

  it("re-pins a session to whichever seat actually served it", async () => {
    const { AccountRotation } = await import("../src/accounts.js");
    const r = new AccountRotation();
    const ids = ["a", "b"];
    expect(r.order("chatgpt", ids, "s1")).toEqual(["a", "b"]);
    r.remember("chatgpt", "s1", "b"); // a was benched; b served
    expect(r.order("chatgpt", ids, "s1")).toEqual(["b", "a"]);
  });

  it("falls back to the ring when a pinned seat has been logged out", async () => {
    const { AccountRotation } = await import("../src/accounts.js");
    const r = new AccountRotation();
    r.remember("chatgpt", "s1", "gone");
    expect(r.order("chatgpt", ["a", "b"], "s1")).toEqual(["a", "b"]);
  });
});

describe("sessionKey", () => {
  it("believes an explicit label and otherwise hashes the conversation opening", async () => {
    const { sessionKey } = await import("../src/accounts.js");
    expect(sessionKey("codex-conv-1", "ignored")).toBe("codex-conv-1");
    const a = sessionKey(undefined, "system", { role: "user", content: "first" });
    const b = sessionKey(undefined, "system", { role: "user", content: "first" });
    const c = sessionKey(undefined, "system", { role: "user", content: "other" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("gateway with several ChatGPT seats", () => {
  const backendSSE = (text: string) =>
    [
      `data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`,
      `data: {"type":"response.output_text.delta","delta":"${text}"}`,
      `data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":5,"output_tokens":4,"total_tokens":9}}}`,
      ``,
      ``,
    ].join("\n");

  async function twoSeatApp(env: Record<string, string> = {}) {
    vi.stubEnv(
      "UNDERSTUDY_AUTH",
      tempAuthFile({
        "openai-codex": [fresh(codexJwt("acc-1")), fresh(codexJwt("acc-2"))],
      }),
    );
    vi.stubEnv("CACHE_TTL_S", "0");
    vi.stubEnv("USAGE_LOG", `/tmp/llm-proxy-test-${Date.now()}-${Math.random()}.jsonl`);
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const { createApp } = await import("../src/app.js");
    return createApp();
  }

  const chat = (app: { request: (p: string, i: RequestInit) => Promise<Response> }, opening: string, turn = 1) =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt/gpt-5.5",
        messages: [
          { role: "user", content: opening },
          ...Array.from({ length: turn - 1 }, (_, i) => ({
            role: "assistant",
            content: `reply ${i}`,
          })),
        ],
      }),
    });

  it("deals sessions across seats and keeps every turn of a session on one seat", async () => {
    const app = await twoSeatApp();
    const served: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        served.push((init?.headers as Record<string, string>)["chatgpt-account-id"]!);
        return new Response(backendSSE("ok"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    // Session A, three turns; session B, one turn; session A again.
    let res = await chat(app, "session A", 1);
    expect(res.headers.get("x-understudy-account")).toBe("acc-1");
    expect(res.headers.get("x-understudy-fallback")).toBeNull();
    await chat(app, "session A", 2);
    await chat(app, "session A", 3);
    res = await chat(app, "session B", 1);
    expect(res.headers.get("x-understudy-account")).toBe("acc-2");
    await chat(app, "session A", 4);
    expect(served).toEqual(["acc-1", "acc-1", "acc-1", "acc-2", "acc-1"]);

    const health = (await (await app.request("/health", {})).json()) as {
      accounts: Record<string, string[]>;
    };
    expect(health.accounts.chatgpt).toEqual(["acc-1", "acc-2"]);
  });

  it("benches only the seat that 429s, moves the session over, and keeps it there", async () => {
    const app = await twoSeatApp();
    const served: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const seat = (init?.headers as Record<string, string>)["chatgpt-account-id"]!;
        served.push(seat);
        if (seat === "acc-1") {
          return new Response(
            JSON.stringify({ error: { message: "usage limit", resets_at: Date.now() / 1000 + 600 } }),
            { status: 429 },
          );
        }
        return new Response(backendSSE("second seat"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    let res = await chat(app, "session A", 1);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-understudy-account")).toBe("acc-2");
    expect(res.headers.get("x-understudy-fallback")).toBe("from chatgpt/gpt-5.5@acc-1");
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]?.message.content).toBe("second seat");

    // Next turn: acc-1 is benched and the session is pinned to acc-2, so no
    // wasted attempt on acc-1.
    res = await chat(app, "session A", 2);
    expect(res.status).toBe(200);
    expect(served).toEqual(["acc-1", "acc-2", "acc-2"]);

    const health = (await (await app.request("/health", {})).json()) as {
      cooldowns: Record<string, number>;
    };
    expect(health.cooldowns["chatgpt/gpt-5.5@acc-1"]).toBeGreaterThan(0);
    expect(health.cooldowns["chatgpt/gpt-5.5@acc-2"]).toBeUndefined();
  });

  it("walks every seat before giving up, then fails over to the next provider", async () => {
    const app = await twoSeatApp({ GROQ_API_KEY: "gk", FALLBACK_CHAIN: "groq/llama-4-maverick" });
    const hosts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const seat = (init?.headers as Record<string, string>)["chatgpt-account-id"];
        hosts.push(seat ?? new URL(String(url)).hostname);
        if (seat) return new Response("limit", { status: 429 });
        return new Response(
          JSON.stringify({
            id: "c",
            object: "chat.completion",
            created: 1,
            model: "llama-4-maverick",
            choices: [{ index: 0, message: { role: "assistant", content: "groq" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const res = await chat(app, "session A");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-understudy-provider")).toBe("groq");
    expect(hosts).toEqual(["acc-1", "acc-2", "api.groq.com"]);
  });

  it("leaves single-seat and API-key providers untouched", async () => {
    vi.stubEnv("UNDERSTUDY_AUTH", tempAuthFile({ "openai-codex": fresh(codexJwt("acc-1")) }));
    vi.stubEnv("USAGE_LOG", `/tmp/llm-proxy-test-${Date.now()}-${Math.random()}.jsonl`);
    const { createApp } = await import("../src/app.js");
    const app = createApp();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(backendSSE("solo"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );
    const res = await chat(app, "hi");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-understudy-account")).toBeNull();
  });
});
