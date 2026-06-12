import { getApiKey, type ProviderConfig } from "../config.js";
import { COPILOT_HEADERS, copilotBaseUrl, oauthApiKey } from "../oauth.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderResult,
  TokenUsage,
} from "../types.js";

/**
 * Passthrough adapter for any provider exposing an OpenAI-compatible
 * /chat/completions endpoint (OpenAI, Gemini, xAI, Groq, DeepSeek, Mistral,
 * Ollama, ...). Requests are forwarded nearly verbatim; streams are piped
 * through a light SSE scanner so usage can be captured for cost tracking
 * without buffering the response.
 */
export async function openaiCompatChat(
  provider: ProviderConfig,
  model: string,
  req: ChatCompletionRequest,
): Promise<ProviderResult> {
  // Strip gateway extensions; rewrite model to the bare provider name.
  const { fallbacks: _fallbacks, ...rest } = req;
  const body: Record<string, unknown> = { ...rest, model };
  if (req.stream && provider.streamUsage) {
    body.stream_options = { ...(req.stream_options ?? {}), include_usage: true };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  let baseUrl = provider.baseUrl;
  let apiKey = getApiKey(provider);
  if (!apiKey) {
    // OAuth subscription fallback (e.g. GitHub Copilot via `understudy login`).
    const oauthKey = await oauthApiKey(provider.name).catch(() => null);
    if (oauthKey) {
      apiKey = oauthKey;
      if (provider.name === "copilot") {
        baseUrl = copilotBaseUrl(oauthKey);
        Object.assign(headers, COPILOT_HEADERS);
      }
    }
  }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      type: "error",
      status: 502,
      retryable: true,
      body: {
        error: {
          message: `Could not reach ${provider.name}: ${err instanceof Error ? err.message : err}`,
          type: "provider_error",
          provider: provider.name,
        },
      },
    };
  }

  if (!res.ok) {
    let errBody: unknown;
    try {
      errBody = await res.json();
    } catch {
      errBody = { error: { message: await res.text().catch(() => res.statusText) } };
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    return {
      type: "error",
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
      body: annotate(errBody, provider.name),
      ...(Number.isFinite(retryAfter) && retryAfter > 0
        ? { retryAfterS: retryAfter }
        : {}),
    };
  }

  if (!req.stream) {
    const json = (await res.json()) as ChatCompletionResponse;
    return { type: "completion", body: json, usage: json.usage ?? null };
  }

  // Streaming: pipe bytes through, scanning SSE data lines for the usage
  // chunk most providers emit last when include_usage is set.
  let resolveUsage!: (u: TokenUsage | null) => void;
  const usage = new Promise<TokenUsage | null>((r) => (resolveUsage = r));
  let captured: TokenUsage | null = null;
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
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          if (obj.usage) captured = obj.usage;
        } catch {
          // partial or non-JSON line — ignore
        }
      }
    },
    flush() {
      resolveUsage(captured);
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

function annotate(errBody: unknown, providerName: string): unknown {
  if (errBody && typeof errBody === "object" && "error" in errBody) {
    const e = errBody as { error: Record<string, unknown> };
    if (e.error && typeof e.error === "object") {
      return { error: { ...e.error, provider: providerName } };
    }
  }
  return errBody;
}
