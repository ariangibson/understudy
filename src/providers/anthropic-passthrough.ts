/**
 * Passthrough adapter for the Anthropic Messages front door. When a Messages
 * request routes to Anthropic itself there is nothing to translate — the body
 * is forwarded nearly verbatim, which preserves prompt caching, thinking
 * blocks, and beta features that a round-trip through the OpenAI dialect
 * would destroy.
 *
 * Auth: a client that presents an Anthropic OAuth token (Claude Code logged
 * in with a Pro/Max subscription sends `Bearer sk-ant-oat...`) keeps using
 * it — the request is theirs, billed to their subscription. Everything else
 * is signed with the server's ANTHROPIC_API_KEY, with OAuth-only beta flags
 * scrubbed so the API doesn't reject the key-auth request.
 */

import { getApiKey, type ProviderConfig } from "../config.js";
import { oauthApiKey } from "../oauth.js";
import type { TokenUsage } from "../types.js";
import type { MessagesRequest } from "./messages-translate.js";

/** Overridable for tests and Anthropic-compatible upstream proxies (bare
 * host, no /v1). `||` so an empty-but-set var means "default". */
const ANTHROPIC_API =
  process.env.UNDERSTUDY_ANTHROPIC_UPSTREAM || "https://api.anthropic.com";

export interface ClientAuth {
  /** Raw Authorization header from the client, if any. */
  authorization?: string;
  /** Raw anthropic-beta header from the client, if any. */
  beta?: string;
  /** anthropic-version header (defaulted if the client omits it). */
  version?: string;
  /** Whether the client requested ?beta=true. */
  betaQuery?: boolean;
}

export type MessagesResult =
  | { type: "json"; body: unknown; usage: TokenUsage | null }
  | {
      type: "stream";
      /** SSE bytes in Anthropic event format, passed through untouched. */
      body: ReadableStream<Uint8Array>;
      usage: Promise<TokenUsage | null>;
    }
  | {
      type: "error";
      status: number;
      retryable: boolean;
      body: unknown;
      retryAfterS?: number;
    };

export function isOAuthBearer(authorization: string | undefined): boolean {
  return /^Bearer sk-ant-oat/i.test(authorization ?? "");
}

export async function anthropicMessagesPassthrough(
  provider: ProviderConfig,
  model: string,
  req: MessagesRequest,
  auth: ClientAuth,
): Promise<MessagesResult> {
  const { fallbacks: _fallbacks, ...rest } = req;
  const body = { ...rest, model };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": auth.version ?? "2023-06-01",
  };

  if (isOAuthBearer(auth.authorization)) {
    headers.authorization = auth.authorization!;
    if (auth.beta) headers["anthropic-beta"] = auth.beta;
  } else {
    const apiKey = getApiKey(provider);
    const betas = (auth.beta ?? "")
      .split(",")
      .map((b) => b.trim())
      .filter((b) => b && !b.startsWith("oauth-"));

    if (apiKey) {
      headers["x-api-key"] = apiKey;
      // OAuth-only markers would 401 a key-auth request.
      if (betas.length) headers["anthropic-beta"] = betas.join(",");
    } else {
      // Server-side subscription OAuth (`understudy login anthropic`).
      const token = await oauthApiKey(provider.name).catch(() => null);
      if (!token) {
        return {
          type: "error",
          status: 503,
          retryable: false,
          body: anthropicError("api_error", `No ${provider.apiKeyEnv} configured`),
        };
      }
      headers.authorization = `Bearer ${token}`;
      headers["anthropic-beta"] = ["oauth-2025-04-20", ...betas].join(",");
    }
  }

  const url = `${ANTHROPIC_API}/v1/messages${auth.betaQuery ? "?beta=true" : ""}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      type: "error",
      status: 502,
      retryable: true,
      body: anthropicError(
        "api_error",
        `Could not reach anthropic: ${err instanceof Error ? err.message : err}`,
      ),
    };
  }

  if (!res.ok) {
    let errBody: unknown;
    try {
      errBody = await res.json();
    } catch {
      errBody = anthropicError("api_error", await res.text().catch(() => res.statusText));
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    return {
      type: "error",
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
      body: errBody,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterS: retryAfter } : {}),
    };
  }

  if (!req.stream) {
    const json = (await res.json()) as {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      };
    };
    return { type: "json", body: json, usage: usageFrom(json.usage) };
  }

  // Streaming: pipe Anthropic SSE bytes through untouched, scanning events
  // for token counts (message_start carries input, message_delta output).
  let resolveUsage!: (u: TokenUsage | null) => void;
  const usage = new Promise<TokenUsage | null>((r) => (resolveUsage = r));
  let promptTokens = 0;
  let completionTokens = 0;
  let sawUsage = false;
  let buffer = "";
  const decoder = new TextDecoder();

  const scanner = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        try {
          const event = JSON.parse(line.slice(5).trim()) as {
            type?: string;
            message?: { usage?: Record<string, number | null> };
            usage?: Record<string, number | null>;
          };
          if (event.type === "message_start" && event.message?.usage) {
            const u = event.message.usage;
            promptTokens =
              (u.input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0);
            sawUsage = true;
          } else if (event.type === "message_delta" && event.usage?.output_tokens != null) {
            completionTokens = event.usage.output_tokens;
            sawUsage = true;
          }
        } catch {
          // partial or non-JSON line — ignore
        }
      }
    },
    flush() {
      resolveUsage(
        sawUsage
          ? {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            }
          : null,
      );
    },
  });

  const stream = res.body
    ? res.body.pipeThrough(scanner)
    : new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
          resolveUsage(null);
        },
      });

  return { type: "stream", body: stream, usage };
}

/** Forward a count_tokens request verbatim (same auth policy as messages). */
export async function anthropicCountTokensPassthrough(
  provider: ProviderConfig,
  body: Record<string, unknown>,
  auth: ClientAuth,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": auth.version ?? "2023-06-01",
  };
  if (isOAuthBearer(auth.authorization)) {
    headers.authorization = auth.authorization!;
    if (auth.beta) headers["anthropic-beta"] = auth.beta;
  } else {
    const apiKey = getApiKey(provider);
    if (!apiKey) {
      // No upstream available — estimate so clients keep working.
      const chars = JSON.stringify(body).length;
      return { status: 200, body: { input_tokens: Math.ceil(chars / 4) } };
    }
    headers["x-api-key"] = apiKey;
  }

  try {
    const res = await fetch(`${ANTHROPIC_API}/v1/messages/count_tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    const chars = JSON.stringify(body).length;
    return { status: 200, body: { input_tokens: Math.ceil(chars / 4) } };
  }
}

function usageFrom(u: Record<string, number | null | undefined> | undefined): TokenUsage | null {
  if (!u) return null;
  const prompt =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  const completion = u.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

export function anthropicError(type: string, message: string): unknown {
  return { type: "error", error: { type, message } };
}
