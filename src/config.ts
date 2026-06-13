import { hasOAuth } from "./oauth.js";

/**
 * Provider registry. Every provider except Anthropic exposes an
 * OpenAI-compatible endpoint, so they all share one passthrough adapter —
 * only the base URL and key differ. Anthropic speaks the Messages API and
 * gets a real translation adapter.
 */

export interface ProviderConfig {
  name: string;
  kind: "openai-compat" | "anthropic" | "chatgpt";
  baseUrl?: string;
  apiKeyEnv: string;
  /** Whether the provider honors `stream_options: {include_usage: true}`. */
  streamUsage: boolean;
  /** Model-name prefixes used to infer the provider when none is given. */
  modelPrefixes: string[];
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    name: "anthropic",
    kind: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    streamUsage: true,
    modelPrefixes: ["claude-"],
  },
  openai: {
    name: "openai",
    kind: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    streamUsage: true,
    modelPrefixes: ["gpt-", "o1", "o3", "o4", "chatgpt-"],
  },
  google: {
    name: "google",
    kind: "openai-compat",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GOOGLE_API_KEY",
    streamUsage: true,
    modelPrefixes: ["gemini-"],
  },
  xai: {
    name: "xai",
    kind: "openai-compat",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    streamUsage: true,
    modelPrefixes: ["grok-"],
  },
  groq: {
    name: "groq",
    kind: "openai-compat",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    streamUsage: true,
    modelPrefixes: [],
  },
  deepseek: {
    name: "deepseek",
    kind: "openai-compat",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    streamUsage: true,
    modelPrefixes: ["deepseek-"],
  },
  mistral: {
    name: "mistral",
    kind: "openai-compat",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    streamUsage: false,
    modelPrefixes: ["mistral-", "magistral-", "codestral-"],
  },
  ollama: {
    name: "ollama",
    kind: "openai-compat",
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY", // unused by default; Ollama needs no key
    streamUsage: false,
    modelPrefixes: ["llama", "qwen", "phi", "gemma"],
  },
  synthetic: {
    name: "synthetic",
    kind: "openai-compat",
    // Open-weights hosting (Kimi, GLM, Qwen, DeepSeek...). Prefer the
    // syn: aliases (syn:large:vision) - they survive model rotations;
    // pinned hf:org/model ids get deprecated when newer models land.
    baseUrl: "https://api.synthetic.new/openai/v1",
    apiKeyEnv: "SYNTHETIC_API_KEY",
    streamUsage: true,
    modelPrefixes: ["hf:", "syn:"],
  },
  chatgpt: {
    name: "chatgpt",
    kind: "chatgpt",
    // The ChatGPT Codex backend: accepts Plus/Pro subscription OAuth tokens
    // (`npm run login -- chatgpt`), speaks the Responses dialect, stream-only.
    baseUrl: "https://chatgpt.com/backend-api",
    apiKeyEnv: "CHATGPT_ACCESS_TOKEN", // manual override; normally OAuth
    streamUsage: true,
    modelPrefixes: [],
  },
  copilot: {
    name: "copilot",
    kind: "openai-compat",
    // The real host is embedded in each short-lived OAuth token; this is
    // the individual-plan default (see oauth.ts copilotBaseUrl).
    baseUrl: "https://api.individual.githubcopilot.com",
    apiKeyEnv: "COPILOT_API_KEY",
    streamUsage: false,
    modelPrefixes: [],
  },
};

export function getApiKey(provider: ProviderConfig): string | undefined {
  return process.env[provider.apiKeyEnv] || undefined;
}

export function isConfigured(provider: ProviderConfig): boolean {
  // Ollama is local and keyless — configured if explicitly enabled.
  if (provider.name === "ollama") return process.env.OLLAMA_ENABLED === "true";
  return Boolean(getApiKey(provider)) || hasOAuth(provider.name);
}

export function configuredProviders(): ProviderConfig[] {
  return Object.values(PROVIDERS).filter(isConfigured);
}

export const config = {
  port: Number(process.env.PORT ?? 42986),
  /** Comma-separated keys clients must present as `Authorization: Bearer <key>`. */
  gatewayKeys: (process.env.GATEWAY_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
  usageLogPath: process.env.USAGE_LOG ?? "data/usage.jsonl",
  /** Default max_tokens when the client omits it (Anthropic requires one). */
  defaultMaxTokens: Number(process.env.DEFAULT_MAX_TOKENS ?? 4096),
  /** Response cache TTL in seconds; 0 disables caching. */
  cacheTtlMs: Number(process.env.CACHE_TTL_S ?? 300) * 1000,
  cacheMaxEntries: Number(process.env.CACHE_MAX_ENTRIES ?? 500),
  /**
   * Server-side failover chain applied to every request that doesn't carry
   * its own `fallbacks` — this is what gives unmodified agent harnesses
   * automatic failover. Comma-separated model names.
   */
  fallbackChain: (process.env.FALLBACK_CHAIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Seconds a model stays benched after a retryable failure (circuit breaker). */
  cooldownS: Number(process.env.COOLDOWN_S ?? 30),
  /**
   * Model rewrite map applied to the requested model before routing, for
   * harnesses that only emit fixed model names. Comma-separated
   * `pattern=target` entries; a trailing `*` makes the pattern a prefix.
   * Example: MODEL_OVERRIDES="claude-haiku-*=groq/llama-4-maverick"
   */
  modelOverrides: (process.env.MODEL_OVERRIDES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const eq = entry.indexOf("=");
      if (eq <= 0 || eq === entry.length - 1) {
        console.warn(`Ignoring malformed MODEL_OVERRIDES entry: "${entry}"`);
        return [];
      }
      return [{ pattern: entry.slice(0, eq).trim(), target: entry.slice(eq + 1).trim() }];
    }),
};
