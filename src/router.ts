import { config, PROVIDERS, type ProviderConfig } from "./config.js";

export interface Route {
  provider: ProviderConfig;
  /** Model name with any provider prefix stripped. */
  model: string;
}

/**
 * Resolve a model string to a provider + bare model name.
 *
 * Explicit form:  "anthropic/claude-sonnet-4-6"  → anthropic
 * Inferred form:  "gpt-5.5"                       → openai (by prefix pattern)
 */
export function resolveModel(modelString: string): Route | null {
  const slash = modelString.indexOf("/");
  if (slash > 0) {
    const providerName = modelString.slice(0, slash);
    const provider = PROVIDERS[providerName];
    if (!provider) return null;
    return { provider, model: modelString.slice(slash + 1) };
  }

  for (const provider of Object.values(PROVIDERS)) {
    if (provider.modelPrefixes.some((p) => modelString.startsWith(p))) {
      return { provider, model: modelString };
    }
  }
  return null;
}

export function routeKey(route: Route): string {
  return `${route.provider.name}/${route.model}`;
}

/**
 * Apply the MODEL_OVERRIDES rewrite map to a requested model name. First
 * matching entry wins; a trailing `*` in the pattern matches by prefix.
 * This is how fixed-model harnesses (Claude Code always asks for claude-*)
 * get redirected to a different provider entirely.
 */
export function applyModelOverride(model: string): string {
  for (const { pattern, target } of config.modelOverrides) {
    const matches = pattern.endsWith("*")
      ? model.startsWith(pattern.slice(0, -1))
      : model === pattern;
    if (matches) return target;
  }
  return model;
}

/**
 * Build the ordered, deduplicated list of routes to attempt: primary first,
 * then fallbacks. Duplicates matter because the server-wide FALLBACK_CHAIN
 * may contain the model a request already asked for.
 */
export function resolveChain(
  model: string,
  fallbacks: string[] | undefined,
): { routes: Route[]; unresolved: string[] } {
  const routes: Route[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const m of [applyModelOverride(model), ...(fallbacks ?? [])]) {
    const route = resolveModel(m);
    if (!route) {
      unresolved.push(m);
      continue;
    }
    const key = routeKey(route);
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push(route);
  }
  return { routes, unresolved };
}
