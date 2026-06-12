import Anthropic from "@anthropic-ai/sdk";
import { config, getApiKey, type ProviderConfig } from "../config.js";
import { oauthApiKey } from "../oauth.js";
import type { ChatCompletionRequest, ProviderResult, TokenUsage } from "../types.js";
import {
  fromAnthropicResponse,
  toAnthropicParams,
  translateStream,
  type AnthropicResponse,
  type AnthropicStreamEvent,
  type StreamCollector,
} from "./anthropic-translate.js";

let client: Anthropic | null = null;
let oauthClient: { token: string; client: Anthropic } | null = null;

async function getClient(provider: ProviderConfig): Promise<Anthropic> {
  const apiKey = getApiKey(provider);
  if (apiKey) return (client ??= new Anthropic({ apiKey }));

  // Subscription OAuth (`understudy login anthropic`): bearer auth plus the
  // oauth beta marker. Tokens rotate on refresh, so rebuild on change.
  const token = await oauthApiKey(provider.name).catch(() => null);
  if (token) {
    if (oauthClient?.token !== token) {
      oauthClient = {
        token,
        client: new Anthropic({
          apiKey: null,
          authToken: token,
          defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
        }),
      };
    }
    return oauthClient.client;
  }

  return (client ??= new Anthropic({ apiKey }));
}

const encoder = new TextEncoder();

export async function anthropicChat(
  provider: ProviderConfig,
  model: string,
  req: ChatCompletionRequest,
): Promise<ProviderResult> {
  const params = toAnthropicParams(model, req, config.defaultMaxTokens);
  const anthropic = await getClient(provider);

  try {
    if (!req.stream) {
      const message = await anthropic.messages.create(
        params as unknown as Anthropic.MessageCreateParamsNonStreaming,
      );
      const body = fromAnthropicResponse(
        message as unknown as AnthropicResponse,
        req.model,
      );
      return { type: "completion", body, usage: body.usage };
    }

    const events = await anthropic.messages.create({
      ...(params as unknown as Anthropic.MessageCreateParamsNonStreaming),
      stream: true,
    });

    const collector: StreamCollector = { usage: null };
    let resolveUsage!: (u: TokenUsage | null) => void;
    const usage = new Promise<TokenUsage | null>((r) => (resolveUsage = r));

    const chunks = translateStream(
      events as AsyncIterable<AnthropicStreamEvent>,
      req.model,
      collector,
    );

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
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      const status = err.status ?? 500;
      const retryAfter = Number(
        (err.headers as Headers | undefined)?.get?.("retry-after"),
      );
      return {
        type: "error",
        status,
        retryable: status === 429 || status >= 500,
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { retryAfterS: retryAfter }
          : {}),
        body: {
          error: {
            message: err.message,
            type: "provider_error",
            provider: provider.name,
            code: status,
          },
        },
      };
    }
    return {
      type: "error",
      status: 502,
      retryable: true,
      body: {
        error: {
          message: err instanceof Error ? err.message : "Unknown provider error",
          type: "provider_error",
          provider: provider.name,
        },
      },
    };
  }
}
