import { describe, expect, it } from "vitest";
import {
  claudeDisable,
  claudeEnable,
  claudeIsEnabled,
  codexDisable,
  codexEnable,
  codexIsEnabled,
  hermesRead,
  openclawDisable,
  openclawEnable,
  opencodeDisable,
  opencodeEnable,
} from "../src/harnesses.js";
import { upsertEnvFile } from "../src/setup.js";

const BASE = "http://localhost:3001";

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

describe("claude enable/disable", () => {
  it("round-trips: enable sets the env var, disable removes it", () => {
    const original = { env: { FOO: "bar" }, model: "opus" };
    const enabled = claudeEnable(original, BASE);
    expect(enabled.env).toEqual({ FOO: "bar", ANTHROPIC_BASE_URL: BASE });
    expect(claudeIsEnabled(enabled)).toBe(true);

    const { settings, changed } = claudeDisable(enabled);
    expect(changed).toBe(true);
    expect(settings).toEqual(original);
    expect(claudeIsEnabled(settings)).toBe(false);
  });

  it("refuses to delete a base URL that is not a local gateway", () => {
    const custom = { env: { ANTHROPIC_BASE_URL: "https://my-corp-proxy.example.com" } };
    const { settings, changed } = claudeDisable(custom);
    expect(changed).toBe(false);
    expect(settings.env).toEqual(custom.env);
  });
});

describe("codex enable/disable", () => {
  it("captures the previous default provider and restores it", () => {
    const { toml, prevProvider } = codexEnable('model_provider = "openai"\nmodel = "gpt-5.5"\n', BASE);
    expect(prevProvider).toBe("openai");
    expect(toml).toContain('model_provider = "understudy"');
    expect(toml).toContain("[model_providers.understudy]");
    expect(codexIsEnabled(toml)).toBe(true);

    const { toml: restored, changed } = codexDisable(toml, prevProvider);
    expect(changed).toBe(true);
    expect(restored).toContain('model_provider = "openai"');
    expect(restored).toContain("[model_providers.understudy]"); // block stays, inert
    expect(codexIsEnabled(restored)).toBe(false);
  });

  it("removes the line entirely when there was no previous provider", () => {
    const { toml } = codexEnable("", BASE);
    const { toml: restored, changed } = codexDisable(toml, null);
    expect(changed).toBe(true);
    expect(restored).not.toMatch(/^model_provider/m);
  });

  it("is idempotent: enabling twice adds one block, disabling twice is a no-op", () => {
    const once = codexEnable("", BASE).toml;
    const twice = codexEnable(once, BASE).toml;
    expect(twice.match(/\[model_providers\.understudy\]/g)).toHaveLength(1);
    const off = codexDisable(twice, null).toml;
    expect(codexDisable(off, null).changed).toBe(false);
  });
});

describe("opencode enable/disable", () => {
  it("adds the provider without clobbering others, and removes it cleanly", () => {
    const original = { provider: { other: { name: "keep me" } }, model: "other/m" };
    const enabled = opencodeEnable(original, BASE, "gw-key") as {
      provider: Record<string, { options?: { baseURL: string } }>;
      model: string;
    };
    expect(enabled.provider.other).toEqual({ name: "keep me" });
    expect(enabled.provider.understudy?.options?.baseURL).toBe(`${BASE}/v1`);
    expect(enabled.model).toBe("other/m"); // default model untouched

    const { config, changed } = opencodeDisable(enabled);
    expect(changed).toBe(true);
    expect(config).toEqual(original);
  });

  it("clears a default model that points at the removed provider", () => {
    const enabled = { provider: {}, model: "understudy/claude-sonnet-4-6" };
    const { config } = opencodeDisable(enabled);
    expect(config.model).toBeUndefined();
  });
});

describe("openclaw enable/disable", () => {
  it("round-trips under models.providers and clears understudy defaults", () => {
    const enabled = openclawEnable(null, BASE, "") as {
      models: { providers: Record<string, { baseUrl: string; apiKey: string }> };
    };
    expect(enabled.models.providers.understudy?.baseUrl).toBe(`${BASE}/v1`);
    expect(enabled.models.providers.understudy?.apiKey).toBe("none"); // OpenClaw requires one

    const withDefault = {
      ...enabled,
      agents: { defaults: { model: { primary: "understudy/claude-sonnet-4-6" } } },
    };
    const { config, changed } = openclawDisable(withDefault);
    expect(changed).toBe(true);
    const models = config.models as { providers: Record<string, unknown> };
    expect(models.providers.understudy).toBeUndefined();
    const agents = config.agents as { defaults: { model: { primary?: string } } };
    expect(agents.defaults.model.primary).toBeUndefined();
  });
});

describe("hermesRead", () => {
  it("extracts base_url and provider from the model block", () => {
    const yaml = [
      "model:",
      "  default: gpt-5.5",
      "  provider: openai-codex",
      "  base_url: ''",
      "providers:",
      "  something: else",
      "",
    ].join("\n");
    expect(hermesRead(yaml)).toEqual({ base_url: "", provider: "openai-codex" });
  });

  it("reads a gateway-routed config", () => {
    const yaml = "model:\n  provider: custom\n  base_url: http://localhost:3001/v1\n";
    expect(hermesRead(yaml)).toEqual({
      base_url: "http://localhost:3001/v1",
      provider: "custom",
    });
  });

  it("returns null when there is no model block", () => {
    expect(hermesRead("toolsets:\n  default: []\n")).toBeNull();
  });
});
