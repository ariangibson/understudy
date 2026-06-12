/**
 * Adapter for the ChatGPT Codex backend — the surface that accepts ChatGPT
 * Plus/Pro subscription OAuth tokens (`npm run login -- chatgpt`). It speaks
 * the Responses dialect outbound and is stream-only; non-streaming requests
 * are assembled from the stream.
 *
 * Wire details follow pi-ai's reference implementation: bearer token plus a
 * chatgpt-account-id header extracted from the token's JWT claims, and the
 * `responses=experimental` beta marker.
 */

import { ChunkAssembler } from "../cache.js";
import { getApiKey, type ProviderConfig } from "../config.js";
import { oauthApiKey } from "../oauth.js";
import { parseSSEData } from "../sse.js";
import type { ChatCompletionRequest, ProviderResult, TokenUsage } from "../types.js";
import {
  chatRequestToResponses,
  responsesEventsToChatChunks,
  type ResponsesStreamEvent,
} from "./responses-translate.js";

const encoder = new TextEncoder();

export function extractAccountId(token: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf8"),
    ) as Record<string, { chatgpt_account_id?: string } | undefined>;
    return payload["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
  } catch {
    return null;
  }
}

export async function chatgptChat(
  provider: ProviderConfig,
  model: string,
  req: ChatCompletionRequest,
): Promise<ProviderResult> {
  const token = getApiKey(provider) ?? (await oauthApiKey(provider.name).catch(() => null));
  if (!token) {
    return providerError(provider, 503, false, `No ${provider.apiKeyEnv} or stored login`);
  }
  const accountId = extractAccountId(token);
  if (!accountId) {
    return providerError(provider, 503, false, "Could not read account id from token");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${token}`,
    "chatgpt-account-id": accountId,
    originator: "understudy",
    "OpenAI-Beta": "responses=experimental",
  };

  let res: Response;
  try {
    res = await fetch(`${provider.baseUrl}/codex/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(chatRequestToResponses(model, req)),
    });
  } catch (err) {
    return providerError(
      provider,
      502,
      true,
      `Could not reach ${provider.name}: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let message = text;
    let retryAfterS: number | undefined;
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string; resets_at?: number };
        detail?: string;
      };
      message = parsed.error?.message ?? parsed.detail ?? text;
      // Usage-limit errors carry an epoch-seconds reset time.
      if (parsed.error?.resets_at) {
        retryAfterS = Math.max(1, Math.round(parsed.error.resets_at - Date.now() / 1000));
      }
    } catch {
      // non-JSON error body — use the raw text
    }
    const headerRetry = Number(res.headers.get("retry-after"));
    if (retryAfterS == null && Number.isFinite(headerRetry) && headerRetry > 0) {
      retryAfterS = headerRetry;
    }
    return {
      type: "error",
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
      body: { error: { message, type: "provider_error", provider: provider.name } },
      ...(retryAfterS != null ? { retryAfterS } : {}),
    };
  }

  if (!res.body) {
    return providerError(provider, 502, true, "Empty response body");
  }

  const collector = { usage: null as TokenUsage | null };
  const chunks = responsesEventsToChatChunks(
    parseSSEData<ResponsesStreamEvent>(res.body),
    req.model,
    collector,
  );

  // Non-streaming clients: drain the stream and assemble one completion.
  if (!req.stream) {
    const assembler = new ChunkAssembler();
    try {
      for await (const chunk of chunks) assembler.feed(chunk);
    } catch (err) {
      return providerError(provider, 502, true, err instanceof Error ? err.message : String(err));
    }
    const body = assembler.result();
    if (!body) return providerError(provider, 502, true, "Stream ended without completing");
    return { type: "completion", body: { ...body, model: req.model }, usage: collector.usage };
  }

  // Streaming clients: re-emit as OpenAI chunk SSE, like every other adapter.
  let resolveUsage!: (u: TokenUsage | null) => void;
  const usage = new Promise<TokenUsage | null>((r) => (resolveUsage = r));

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          resolveUsage(collector.usage);
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      } catch (err) {
        controller.error(err);
        resolveUsage(collector.usage);
      }
    },
    cancel() {
      resolveUsage(collector.usage);
    },
  });

  return { type: "stream", body, usage };
}

function providerError(
  provider: ProviderConfig,
  status: number,
  retryable: boolean,
  message: string,
): ProviderResult {
  return {
    type: "error",
    status,
    retryable,
    body: { error: { message, type: "provider_error", provider: provider.name } },
  };
}
