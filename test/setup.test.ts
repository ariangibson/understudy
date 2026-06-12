import { describe, expect, it } from "vitest";
import {
  ensureCodexProvider,
  mergeClaudeSettings,
  mergeOpenClawConfig,
  mergeOpenCodeConfig,
  upsertEnvFile,
} from "../src/setup.js";

describe("upsertEnvFile", () => {
  it("updates existing keys and appends new ones", () => {
    const out = upsertEnvFile("PORT=3001\nOPENAI_API_KEY=\n", {
      OPENAI_API_KEY: "sk-new",
      FALLBACK_CHAIN: "openai/gpt-5.5",
    });
    expect(out).toContain("OPENAI_API_KEY=sk-new");
    expect(out).toContain("FALLBACK_CHAIN=openai/gpt-5.5");
    expect(out).toContain("PORT=3001");
    expect(out.match(/OPENAI_API_KEY=/g)).toHaveLength(1);
  });

  it("starts cleanly from an empty file", () => {
    expect(upsertEnvFile("", { PORT: "3001" })).toBe("PORT=3001\n");
  });
});

describe("ensureCodexProvider", () => {
  it("appends the provider block once and can set the default", () => {
    const first = ensureCodexProvider('model = "gpt-5.5"\n', "http://localhost:3001", true);
    expect(first).toContain("[model_providers.understudy]");
    expect(first).toContain('base_url = "http://localhost:3001/v1"');
    expect(first).toContain('model_provider = "understudy"');

    const second = ensureCodexProvider(first, "http://localhost:3001", true);
    expect(second.match(/\[model_providers\.understudy\]/g)).toHaveLength(1);
    expect(second.match(/^model_provider = /gm)).toHaveLength(1);
  });

  it("replaces an existing model_provider line rather than duplicating it", () => {
    const out = ensureCodexProvider('model_provider = "openai"\n', "http://localhost:3001", true);
    expect(out).toContain('model_provider = "understudy"');
    expect(out).not.toContain('model_provider = "openai"');
  });
});

describe("config merges", () => {
  it("adds the understudy provider to OpenCode without clobbering others", () => {
    const merged = mergeOpenCodeConfig(
      { provider: { other: { name: "keep me" } }, model: "other/m" },
      "http://localhost:3001",
      "gw-key",
    ) as { provider: Record<string, { options?: { baseURL: string } }>; model: string };
    expect(merged.provider.other).toEqual({ name: "keep me" });
    expect(merged.provider.understudy?.options?.baseURL).toBe("http://localhost:3001/v1");
    expect(merged.model).toBe("other/m"); // default model untouched
  });

  it("adds the understudy provider to OpenClaw under models.providers", () => {
    const merged = mergeOpenClawConfig(null, "http://localhost:3001", "") as {
      models: { providers: Record<string, { baseUrl: string; apiKey: string }> };
    };
    expect(merged.models.providers.understudy?.baseUrl).toBe("http://localhost:3001/v1");
    expect(merged.models.providers.understudy?.apiKey).toBe("none"); // OpenClaw requires one
  });

  it("sets ANTHROPIC_BASE_URL in Claude settings, preserving other env vars", () => {
    const merged = mergeClaudeSettings(
      { env: { FOO: "bar" }, model: "opus" },
      "http://localhost:3001",
    ) as { env: Record<string, string>; model: string };
    expect(merged.env).toEqual({ FOO: "bar", ANTHROPIC_BASE_URL: "http://localhost:3001" });
    expect(merged.model).toBe("opus");
  });
});
