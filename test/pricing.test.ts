import { describe, expect, it } from "vitest";
import { computeCost, lookupPrice } from "../src/pricing.js";

describe("lookupPrice", () => {
  it("matches by longest prefix so dated variants resolve correctly", () => {
    expect(lookupPrice("claude-haiku-4-5-20251001")).toEqual([1.0, 5.0]);
    expect(lookupPrice("gpt-5-mini-2025-08-07")).toEqual([0.25, 2.0]);
    expect(lookupPrice("gpt-5.5")).toEqual([5.0, 30.0]);
    // longer prefixes win: gpt-5.5 must not swallow gpt-5.5-pro
    expect(lookupPrice("gpt-5.5-pro")).toEqual([30.0, 180.0]);
    expect(lookupPrice("gemini-3.5-flash")).toEqual([1.5, 9.0]);
  });

  it("returns null for unknown models", () => {
    expect(lookupPrice("some-local-model")).toBeNull();
  });
});

describe("computeCost", () => {
  it("computes per-token cost in USD", () => {
    // claude-sonnet-4-6: $3 in / $15 out per MTok
    const cost = computeCost("claude-sonnet-4-6", {
      prompt_tokens: 1_000_000,
      completion_tokens: 200_000,
      total_tokens: 1_200_000,
    });
    expect(cost).toBeCloseTo(3 + 0.2 * 15, 10);
  });

  it("returns null instead of guessing for unknown models or missing usage", () => {
    expect(computeCost("mystery-model", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })).toBeNull();
    expect(computeCost("gpt-5.5", null)).toBeNull();
  });
});
