import type { TokenUsage } from "./types.js";

/**
 * Prices in USD per million tokens: [input, output].
 * Matched by longest prefix against the bare model name, so dated variants
 * (e.g. "claude-haiku-4-5-20251001") resolve to their family entry.
 *
 * Anthropic prices verified against platform.claude.com (2026-06); others
 * checked against provider pricing pages (2026-06). Providers change rates
 * frequently — treat these as defaults and edit to match your account.
 * Unknown models record cost as null rather than a wrong number.
 */
const PRICES: Record<string, [number, number]> = {
  // Anthropic
  "claude-fable-5": [10.0, 50.0],
  "claude-opus-4": [5.0, 25.0],
  "claude-sonnet-4": [3.0, 15.0],
  "claude-haiku-4": [1.0, 5.0],
  // OpenAI
  "gpt-5.5-pro": [30.0, 180.0],
  "gpt-5.5": [5.0, 30.0],
  "gpt-5.2-pro": [10.5, 84.0],
  "gpt-5.2": [1.75, 14.0],
  "gpt-5-mini": [0.25, 2.0],
  "gpt-5-nano": [0.05, 0.4],
  // Google
  "gemini-3.5-flash": [1.5, 9.0],
  "gemini-3.1-pro": [2.0, 12.0],
  "gemini-3-flash": [0.5, 3.0],
  // xAI
  "grok-4.3": [1.25, 2.5],
  "grok-4.1-fast": [0.2, 0.5],
  // DeepSeek
  "deepseek-chat": [0.27, 1.1],
  "deepseek-reasoner": [0.55, 2.19],
};

const SORTED_PREFIXES = Object.keys(PRICES).sort(
  (a, b) => b.length - a.length,
);

export function lookupPrice(model: string): [number, number] | null {
  for (const prefix of SORTED_PREFIXES) {
    if (model.startsWith(prefix)) return PRICES[prefix]!;
  }
  return null;
}

/** Compute request cost in USD, or null if the model isn't in the table. */
export function computeCost(
  model: string,
  usage: TokenUsage | null,
): number | null {
  if (!usage) return null;
  const price = lookupPrice(model);
  if (!price) return null;
  const [input, output] = price;
  return (
    (usage.prompt_tokens / 1_000_000) * input +
    (usage.completion_tokens / 1_000_000) * output
  );
}
