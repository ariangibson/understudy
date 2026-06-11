import { describe, expect, it } from "vitest";
import { resolveChain, resolveModel } from "../src/router.js";

describe("resolveModel", () => {
  it("resolves explicit provider/model form", () => {
    const route = resolveModel("anthropic/claude-sonnet-4-6");
    expect(route?.provider.name).toBe("anthropic");
    expect(route?.model).toBe("claude-sonnet-4-6");
  });

  it("infers provider from model-name patterns", () => {
    expect(resolveModel("gpt-5.5")?.provider.name).toBe("openai");
    expect(resolveModel("claude-haiku-4-5")?.provider.name).toBe("anthropic");
    expect(resolveModel("gemini-3.5-flash")?.provider.name).toBe("google");
    expect(resolveModel("grok-4.3")?.provider.name).toBe("xai");
    expect(resolveModel("deepseek-chat")?.provider.name).toBe("deepseek");
  });

  it("returns null for unknown models and unknown providers", () => {
    expect(resolveModel("totally-made-up")).toBeNull();
    expect(resolveModel("nonexistent/gpt-5.5")).toBeNull();
  });
});

describe("resolveChain", () => {
  it("orders primary then fallbacks and reports unroutable entries", () => {
    const { routes, unresolved } = resolveChain("claude-sonnet-4-6", [
      "openai/gpt-5-mini",
      "garbage-model",
    ]);
    expect(routes.map((r) => `${r.provider.name}/${r.model}`)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5-mini",
    ]);
    expect(unresolved).toEqual(["garbage-model"]);
  });

  it("dedupes when the chain repeats the primary model", () => {
    const { routes } = resolveChain("claude-sonnet-4-6", [
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5-mini",
      "gpt-5-mini",
    ]);
    expect(routes.map((r) => `${r.provider.name}/${r.model}`)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5-mini",
    ]);
  });
});
