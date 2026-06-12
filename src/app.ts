import { Hono, type Context } from "hono";
import { cacheKey, observeSSE, ResponseCache, synthesizeSSE } from "./cache.js";
import { runChain, understudyHeaders, type DispatchError } from "./chain.js";
import { config, configuredProviders, getApiKey, isConfigured, PROVIDERS } from "./config.js";
import { CooldownTracker } from "./cooldown.js";
import { computeCost } from "./pricing.js";
import { resolveChain, resolveModel, routeKey, type Route } from "./router.js";
import { parseSSEData, namedEventStream } from "./sse.js";
import { anthropicChat } from "./providers/anthropic.js";
import { chatgptChat } from "./providers/chatgpt.js";
import {
  anthropicCountTokensPassthrough,
  anthropicError,
  anthropicMessagesPassthrough,
  isOAuthBearer,
  type ClientAuth,
  type MessagesResult,
} from "./providers/anthropic-passthrough.js";
import {
  chatChunksToMessagesEvents,
  chatResponseToMessages,
  messagesToChatRequest,
  type MessagesRequest,
} from "./providers/messages-translate.js";
import { openaiCompatChat } from "./providers/openai-compat.js";
import {
  chatChunksToResponsesEvents,
  chatResponseToResponses,
  responsesError,
  responsesToChatRequest,
  type ResponsesRequest,
} from "./providers/responses-translate.js";
import { recordUsage, summarizeUsage } from "./usage.js";
import type {
  ChatCompletionChunk,
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
    // An Anthropic OAuth bearer is its own credential: the Messages front
    // door forwards it upstream, so the caller is spending their own
    // subscription, not the gateway's keys.
    if (c.req.path.startsWith("/v1/messages") && isOAuthBearer(header)) {
      return next();
    }
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

  // --- chat completions (OpenAI dialect: OpenCode, Hermes, OpenClaw, ...) --
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

    const resolved = resolveRoutes(c, req, (status, message) =>
      openaiError(c, status, message),
    );
    if (resolved.response) return resolved.response;

    const outcome = await runChain(
      resolved.routes,
      cooldowns,
      (route) => dispatch(route, req),
      (route, started) => record(route, null, started, req.stream === true, "error"),
    );

    if (!outcome.ok) {
      if (outcome.reason === "no_keys") {
        return openaiError(
          c,
          503,
          `No API key configured for the requested provider(s). Set ${outcome.neededEnv.join(" or ")}.`,
        );
      }
      return c.json(outcome.body as object, outcome.status as 400);
    }

    const { route, primary, started, result } = outcome;
    const failoverHeaders = understudyHeaders(route, primary);

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
  });

  // --- messages (Anthropic dialect: Claude Code, OpenClaw, ...) ----------
  app.post("/v1/messages", async (c) => {
    let req: MessagesRequest;
    try {
      req = await c.req.json();
    } catch {
      return messagesErrorResponse(c, 400, "Request body must be valid JSON");
    }
    if (!req.model || typeof req.model !== "string") {
      return messagesErrorResponse(c, 400, "Missing required field: model");
    }
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      return messagesErrorResponse(c, 400, "messages must be a non-empty array");
    }

    const auth: ClientAuth = {
      authorization: c.req.header("authorization"),
      beta: c.req.header("anthropic-beta"),
      version: c.req.header("anthropic-version"),
      betaQuery: c.req.query("beta") === "true",
    };
    // An OAuth bearer makes the anthropic route usable without a server key.
    const oauthUsable = (route: Route) =>
      isConfigured(route.provider) ||
      (route.provider.kind === "anthropic" && isOAuthBearer(auth.authorization));

    const resolved = resolveRoutes(c, req, (status, message) =>
      messagesErrorResponse(c, status, message),
    );
    if (resolved.response) return resolved.response;

    let translated: ChatCompletionRequest | null = null;
    const chatReq = () => (translated ??= messagesToChatRequest(req));

    const outcome = await runChain(
      resolved.routes,
      cooldowns,
      async (route): Promise<MessagesResult | DispatchError> => {
        if (route.provider.kind === "anthropic") {
          return anthropicMessagesPassthrough(route.provider, route.model, req, auth);
        }
        const result = await dispatch(route, chatReq());
        if (result.type === "error") return result;
        if (result.type === "completion") {
          return {
            type: "json",
            body: chatResponseToMessages(result.body, req.model),
            usage: result.usage,
          };
        }
        const collector = { usage: null };
        const events = chatChunksToMessagesEvents(
          parseSSEData<ChatCompletionChunk>(result.body),
          req.model,
          collector,
        );
        return { type: "stream", body: namedEventStream(events), usage: result.usage };
      },
      (route, started) => record(route, null, started, req.stream === true, "error"),
      oauthUsable,
    );

    if (!outcome.ok) {
      if (outcome.reason === "no_keys") {
        return messagesErrorResponse(
          c,
          503,
          `No API key configured for the requested provider(s). Set ${outcome.neededEnv.join(" or ")}.`,
        );
      }
      return c.json(toAnthropicErrorBody(outcome.body) as object, outcome.status as 400);
    }

    const { route, primary, started, result } = outcome;
    const failoverHeaders = understudyHeaders(route, primary);

    if (result.type === "json") {
      record(route, result.usage, started, false, "ok");
      for (const [h, v] of Object.entries(failoverHeaders)) c.header(h, v);
      return c.json(result.body as object);
    }

    result.usage.then((u) => record(route, u, started, true, "ok"));
    return new Response(result.body, {
      status: 200,
      headers: { ...SSE_HEADERS, ...failoverHeaders },
    });
  });

  app.post("/v1/messages/count_tokens", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return messagesErrorResponse(c, 400, "Request body must be valid JSON");
    }
    const auth: ClientAuth = {
      authorization: c.req.header("authorization"),
      beta: c.req.header("anthropic-beta"),
      version: c.req.header("anthropic-version"),
    };
    const result = await anthropicCountTokensPassthrough(PROVIDERS.anthropic!, body, auth);
    return c.json(result.body as object, result.status as 200);
  });

  // --- responses (OpenAI Responses dialect: Codex) -----------------------
  app.post("/v1/responses", async (c) => {
    let req: ResponsesRequest;
    try {
      req = await c.req.json();
    } catch {
      return c.json(responsesError("Request body must be valid JSON") as object, 400);
    }
    if (!req.model || typeof req.model !== "string") {
      return c.json(responsesError("Missing required field: model") as object, 400);
    }

    const resolved = resolveRoutes(c, req, (status, message) =>
      c.json(responsesError(message) as object, status),
    );
    if (resolved.response) return resolved.response;

    const chatReq = responsesToChatRequest(req);

    const outcome = await runChain(
      resolved.routes,
      cooldowns,
      (route) => dispatch(route, chatReq),
      (route, started) => record(route, null, started, req.stream === true, "error"),
    );

    if (!outcome.ok) {
      if (outcome.reason === "no_keys") {
        return c.json(
          responsesError(
            `No API key configured for the requested provider(s). Set ${outcome.neededEnv.join(" or ")}.`,
            "server_error",
          ) as object,
          503,
        );
      }
      return c.json(outcome.body as object, outcome.status as 400);
    }

    const { route, primary, started, result } = outcome;
    const failoverHeaders = understudyHeaders(route, primary);

    if (result.type === "completion") {
      record(route, result.usage, started, false, "ok");
      for (const [h, v] of Object.entries(failoverHeaders)) c.header(h, v);
      return c.json(chatResponseToResponses(result.body, req.model) as object);
    }

    result.usage.then((u) => record(route, u, started, true, "ok"));
    const collector = { usage: null };
    const events = chatChunksToResponsesEvents(
      parseSSEData<ChatCompletionChunk>(result.body),
      req.model,
      collector,
    );
    return new Response(namedEventStream(events), {
      status: 200,
      headers: { ...SSE_HEADERS, ...failoverHeaders },
    });
  });

  app.notFound((c) =>
    c.json({ error: { message: `Not found: ${c.req.method} ${c.req.path}`, type: "invalid_request_error" } }, 404),
  );

  return app;

  /**
   * Shared front-door preamble: pick the fallback chain, resolve routes,
   * and shape early validation errors in the caller's dialect.
   */
  function resolveRoutes(
    c: Context,
    req: { model: string; fallbacks?: string[] },
    err: (status: 400, message: string) => Response,
  ): { routes: Route[]; response?: Response } {
    const usingRequestFallbacks = req.fallbacks != null;
    const fallbacks = usingRequestFallbacks
      ? req.fallbacks
      : config.fallbackChain.length
        ? config.fallbackChain
        : undefined;

    const { routes, unresolved } = resolveChain(req.model, fallbacks);
    if (routes.length === 0) {
      return {
        routes,
        response: err(
          400,
          `Could not route model "${req.model}". Use "provider/model" (providers: ${Object.keys(PROVIDERS).join(", ")}) or a recognizable model name like gpt-5.5 or claude-sonnet-4-6.`,
        ),
      };
    }
    if (unresolved.length > 0) {
      if (usingRequestFallbacks) {
        return {
          routes,
          response: err(400, `Unroutable fallback model(s): ${unresolved.join(", ")}`),
        };
      }
      // A bad FALLBACK_CHAIN entry shouldn't fail user requests.
      console.warn(`Ignoring unroutable FALLBACK_CHAIN entries: ${unresolved.join(", ")}`);
    }
    return { routes };
  }
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
  switch (route.provider.kind) {
    case "anthropic":
      return anthropicChat(route.provider, route.model, req);
    case "chatgpt":
      return chatgptChat(route.provider, route.model, req);
    default:
      return openaiCompatChat(route.provider, route.model, req);
  }
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

function messagesErrorResponse(c: Context, status: 400 | 401 | 404 | 503, message: string) {
  return c.json(
    anthropicError(status === 400 ? "invalid_request_error" : "api_error", message) as object,
    status,
  );
}

/** Errors from OpenAI-compat fallbacks need re-dressing in Anthropic shape. */
function toAnthropicErrorBody(body: unknown): unknown {
  if (body && typeof body === "object" && (body as { type?: string }).type === "error") {
    return body;
  }
  const message =
    (body as { error?: { message?: string } })?.error?.message ?? "Provider error";
  return anthropicError("api_error", message);
}
