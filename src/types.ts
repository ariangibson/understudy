/**
 * OpenAI-compatible wire types. The gateway speaks this dialect on the
 * outside regardless of which provider serves the request.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string; detail?: string };
}

export type ContentPart = TextContentPart | ImageContentPart;

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  reasoning_effort?: "low" | "medium" | "high";
  /** Gateway extension: models to try in order if the primary fails. */
  fallbacks?: string[];
  [key: string]: unknown;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | null;

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: FinishReason;
  }>;
  usage: TokenUsage;
}

export interface ChunkToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
      tool_calls?: ChunkToolCall[];
    };
    finish_reason: FinishReason;
  }>;
  usage?: TokenUsage;
}

/** What a provider adapter returns to the request handler. */
export type ProviderResult =
  | {
      type: "completion";
      body: ChatCompletionResponse;
      usage: TokenUsage | null;
    }
  | {
      type: "stream";
      /** SSE bytes in OpenAI chunk format, ending with `data: [DONE]`. */
      body: ReadableStream<Uint8Array>;
      /** Resolves after the stream finishes (null if the provider sent no usage). */
      usage: Promise<TokenUsage | null>;
    }
  | {
      type: "error";
      status: number;
      retryable: boolean;
      body: unknown;
      /** Provider-suggested cooldown (Retry-After header), in seconds. */
      retryAfterS?: number;
    };

export interface UsageRecord {
  ts: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number | null;
  latency_ms: number;
  stream: boolean;
  status: "ok" | "error";
  /** True when served from the response cache (cost_usd is 0). */
  cached?: boolean;
  /** What the request would have cost without the cache. */
  saved_usd?: number;
}
