/**
 * Provider registry. Every provider except Anthropic exposes an
 * OpenAI-compatible endpoint, so they all share one passthrough adapter —
 * only the base URL and key differ. Anthropic speaks the Messages API and
 * gets a real translation adapter.
 */

export interface ProviderConfig {
  name: string;
  kind: "openai-compat" | "anthropic";
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
};

export function getApiKey(provider: ProviderConfig): string | undefined {
  return process.env[provider.apiKeyEnv] || undefined;
}

export function isConfigured(provider: ProviderConfig): boolean {
  // Ollama is local and keyless — configured if explicitly enabled.
  if (provider.name === "ollama") return process.env.OLLAMA_ENABLED === "true";
  return Boolean(getApiKey(provider));
}

export function configuredProviders(): ProviderConfig[] {
  return Object.values(PROVIDERS).filter(isConfigured);
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
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
};
