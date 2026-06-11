import { Hono, type Context } from "hono";
import { cacheKey, observeSSE, ResponseCache, synthesizeSSE } from "./cache.js";
import { config, configuredProviders, getApiKey, isConfigured, PROVIDERS } from "./config.js";
import { CooldownTracker } from "./cooldown.js";
import { computeCost } from "./pricing.js";
import { resolveChain, resolveModel, routeKey, type Route } from "./router.js";
import { anthropicChat } from "./providers/anthropic.js";
import { openaiCompatChat } from "./providers/openai-compat.js";
import { recordUsage, summarizeUsage } from "./usage.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderResult,
  TokenUsage,
} from "./types.js";

export function createApp(): Hono {
  const app = new Hono();
  const cache = new ResponseCache(config.cacheTtlMs, config.cacheMaxEntries);
  const cooldowns = new CooldownTracker();

  // --- auth -----------------------------------------------------------
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    if (config.gatewayKeys.length === 0) return next();

    const header = c.req.header("authorization") ?? "";
    const key = header.startsWith("Bearer ")
      ? header.slice(7)
      : c.req.header("x-api-key") ?? "";
    if (!config.gatewayKeys.includes(key)) {
      return c.json(
        { error: { message: "Invalid or missing API key", type: "authentication_error" } },
        401,
      );
    }
    return next();
  });

  // --- health ---------------------------------------------------------
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      providers: configuredProviders().map((p) => p.name),
      /** Models currently benched by the circuit breaker → seconds remaining. */
      cooldowns: cooldowns.active(),
      uptime_s: Math.floor(process.uptime()),
    }),
  );

  // --- models (aggregated live, cached 5 min) --------------------------
  let modelCache: { at: number; data: unknown[] } | null = null;

  app.get("/v1/models", async (c) => {
    if (modelCache && Date.now() - modelCache.at < 5 * 60_000) {
      return c.json({ object: "list", data: modelCache.data });
    }

    const results = await Promise.allSettled(
      configuredProviders().map(async (p) => {
        const url =
          p.kind === "anthropic"
            ? "https://api.anthropic.com/v1/models"
            : `${p.baseUrl}/models`;
        const headers: Record<string, string> =
          p.kind === "anthropic"
            ? { "x-api-key": getApiKey(p) ?? "", "anthropic-version": "2023-06-01" }
            : getApiKey(p)
              ? { authorization: `Bearer ${getApiKey(p)}` }
              : {};
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`${p.name}: ${res.status}`);
        const json = (await res.json()) as { data: Array<{ id: string }> };
        return json.data.map((m) => ({
          id: `${p.name}/${m.id}`,
          object: "model",
          owned_by: p.name,
        }));
      }),
    );

    const data = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    modelCache = { at: Date.now(), data };
    return c.json({ object: "list", data });
  });

  // --- usage ------------------------------------------------------------
  app.get("/v1/usage", async (c) => {
    const since = c.req.query("since");
    return c.json(await summarizeUsage(since));
  });

  // --- chat completions -------------------------------------------------
  app.post("/v1/chat/completions", async (c) => {
    let req: ChatCompletionRequest;
    try {
      req = await c.req.json();
    } catch {
      return openaiError(c, 400, "Request body must be valid JSON");
    }
    if (!req.model || typeof req.model !== "string") {
      return openaiError(c, 400, "Missing required field: model");
    }
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      return openaiError(c, 400, "messages must be a non-empty array");
    }

    // --- response cache ------------------------------------------------
    const cacheBypass =
      !cache.enabled || c.req.header("x-understudy-cache") === "bypass";
    const key = cacheBypass ? null : cacheKey(req);

    if (key) {
      const hit = cache.get(key);
      if (hit) {
        recordCacheHit(req, hit);
        if (req.stream) {
          return new Response(synthesizeSSE(hit), {
            status: 200,
            headers: { ...SSE_HEADERS, "x-understudy-cache": "hit" },
          });
        }
        c.header("x-understudy-cache", "hit");
        return c.json(hit);
      }
    }

    // Server-wide FALLBACK_CHAIN applies when the request doesn't bring its
    // own fallbacks — this is what gives unmodified agents automatic failover.
    const usingRequestFallbacks = req.fallbacks != null;
    const fallbacks = usingRequestFallbacks
      ? req.fallbacks
      : config.fallbackChain.length
        ? config.fallbackChain
        : undefined;

    const { routes, unresolved } = resolveChain(req.model, fallbacks);
    if (routes.length === 0) {
      return openaiError(
        c,
        400,
        `Could not route model "${req.model}". Use "provider/model" (providers: ${Object.keys(PROVIDERS).join(", ")}) or a recognizable model name like gpt-5.5 or claude-sonnet-4-6.`,
      );
    }
    if (unresolved.length > 0) {
      if (usingRequestFallbacks) {
        return openaiError(c, 400, `Unroutable fallback model(s): ${unresolved.join(", ")}`);
      }
      // A bad FALLBACK_CHAIN entry shouldn't fail user requests.
      console.warn(`Ignoring unroutable FALLBACK_CHAIN entries: ${unresolved.join(", ")}`);
    }

    const usable = routes.filter((r) => isConfigured(r.provider));
    if (usable.length === 0) {
      const needed = [...new Set(routes.map((r) => r.provider.apiKeyEnv))];
      return openaiError(
        c,
        503,
        `No API key configured for the requested provider(s). Set ${needed.join(" or ")}.`,
      );
    }

    // Skip models the circuit breaker has benched — unless that would leave
    // nothing to try, in which case attempting a benched model beats failing.
    const ready = usable.filter((r) => !cooldowns.isBenched(routeKey(r)));
    const attempts = ready.length > 0 ? ready : usable;
    const primary = usable[0]!;

    let lastError: Extract<ProviderResult, { type: "error" }> | null = null;

    for (let i = 0; i < attempts.length; i++) {
      const route = attempts[i]!;
      const started = Date.now();
      const result = await dispatch(route, req);

      if (result.type === "error") {
        lastError = result;
        record(route, null, started, req.stream === true, "error");
        if (result.retryable) {
          cooldowns.bench(routeKey(route), result.retryAfterS ?? config.cooldownS);
          if (i < attempts.length - 1) {
            console.warn(
              `${routeKey(route)} failed (${result.status}); benched ${result.retryAfterS ?? config.cooldownS}s, failing over`,
            );
            continue;
          }
        }
        return c.json(result.body as object, result.status as 400);
      }

      const failoverHeaders: Record<string, string> = {
        "x-understudy-provider": route.provider.name,
        "x-understudy-model": route.model,
        ...(routeKey(route) !== routeKey(primary)
          ? { "x-understudy-fallback": `from ${routeKey(primary)}` }
          : {}),
      };

      if (result.type === "completion") {
        record(route, result.usage, started, false, "ok");
        if (key) cache.set(key, result.body);
        c.header("x-understudy-cache", "miss");
        for (const [h, v] of Object.entries(failoverHeaders)) c.header(h, v);
        return c.json(result.body);
      }

      // stream — record usage once the stream finishes, and tee the SSE
      // bytes through an assembler so completed streams populate the cache
      result.usage.then((u) => record(route, u, started, true, "ok"));
      const body = key
        ? observeSSE(result.body, (assembled) => cache.set(key, assembled))
        : result.body;
      return new Response(body, {
        status: 200,
        headers: {
          ...SSE_HEADERS,
          "x-understudy-cache": "miss",
          ...failoverHeaders,
        },
      });
    }

    return c.json((lastError?.body ?? { error: { message: "All providers failed" } }) as object, (lastError?.status ?? 502) as 502);
  });

  app.notFound((c) =>
    c.json({ error: { message: `Not found: ${c.req.method} ${c.req.path}`, type: "invalid_request_error" } }, 404),
  );

  return app;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

function recordCacheHit(req: ChatCompletionRequest, hit: ChatCompletionResponse): void {
  const route = resolveModel(req.model);
  const model = route?.model ?? req.model;
  void recordUsage({
    ts: new Date().toISOString(),
    provider: route?.provider.name ?? "unknown",
    model,
    prompt_tokens: hit.usage.prompt_tokens,
    completion_tokens: hit.usage.completion_tokens,
    cost_usd: 0,
    latency_ms: 0,
    stream: req.stream === true,
    status: "ok",
    cached: true,
    saved_usd: computeCost(model, hit.usage) ?? 0,
  });
}

function dispatch(route: Route, req: ChatCompletionRequest): Promise<ProviderResult> {
  return route.provider.kind === "anthropic"
    ? anthropicChat(route.provider, route.model, req)
    : openaiCompatChat(route.provider, route.model, req);
}

function record(
  route: Route,
  usage: TokenUsage | null,
  started: number,
  stream: boolean,
  status: "ok" | "error",
): void {
  void recordUsage({
    ts: new Date().toISOString(),
    provider: route.provider.name,
    model: route.model,
    prompt_tokens: usage?.prompt_tokens ?? 0,
    completion_tokens: usage?.completion_tokens ?? 0,
    cost_usd: status === "ok" ? computeCost(route.model, usage) : null,
    latency_ms: Date.now() - started,
    stream,
    status,
  });
}

function openaiError(c: Context, status: 400 | 401 | 404 | 503, message: string) {
  return c.json({ error: { message, type: "invalid_request_error" } }, status);
}
