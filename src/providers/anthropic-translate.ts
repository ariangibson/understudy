/**
 * Pure translation layer between the OpenAI Chat Completions dialect and
 * the Anthropic Messages API — both request/response shapes and the
 * streaming event protocol. No I/O here; the adapter in anthropic.ts wires
 * these functions to the SDK.
 */

import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  FinishReason,
  TokenUsage,
  ToolCall,
} from "../types.js";

// ---------------------------------------------------------------------------
// Request: OpenAI → Anthropic

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source:
        | { type: "url"; url: string }
        | { type: "base64"; media_type: string; data: string };
    }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
    };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: { type: "auto" | "any" | "none" } | { type: "tool"; name: string };
  thinking?: { type: "adaptive" };
  output_config?: { effort: "low" | "medium" | "high" };
}

/**
 * Models on which sampling parameters are rejected (400) and thinking is
 * adaptive-or-always-on: Opus 4.7+, Fable/Mythos 5.
 */
export function isStrictSamplingModel(model: string): boolean {
  return /fable|mythos|opus-4-[789]/.test(model);
}

/** Fable/Mythos: thinking is always on; the `thinking` param must be omitted. */
function isAlwaysThinkingModel(model: string): boolean {
  return /fable|mythos/.test(model);
}

function contentToText(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function userContentToBlocks(
  content: ChatMessage["content"],
): string | AnthropicContentBlock[] {
  if (content == null) return "";
  if (typeof content === "string") return content;

  return content.map((part): AnthropicContentBlock => {
    if (part.type === "text") return { type: "text", text: part.text };
    const url = part.image_url.url;
    const dataUrl = url.match(/^data:(image\/[a-z+.-]+);base64,(.+)$/s);
    if (dataUrl) {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: dataUrl[1]!,
          data: dataUrl[2]!,
        },
      };
    }
    return { type: "image", source: { type: "url", url } };
  });
}

export function toAnthropicParams(
  model: string,
  req: ChatCompletionRequest,
  defaultMaxTokens: number,
): AnthropicParams {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const msg of req.messages) {
    switch (msg.role) {
      case "system":
        systemParts.push(contentToText(msg.content));
        break;

      case "user":
        messages.push({ role: "user", content: userContentToBlocks(msg.content) });
        break;

      case "assistant": {
        const blocks: AnthropicContentBlock[] = [];
        const text = contentToText(msg.content);
        if (text) blocks.push({ type: "text", text });
        for (const call of msg.tool_calls ?? []) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: safeJsonParse(call.function.arguments),
          });
        }
        // The API rejects empty content; skip degenerate assistant turns.
        if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
        break;
      }

      case "tool":
        // OpenAI tool results become user-turn tool_result blocks.
        // Consecutive same-role messages are combined by the API.
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id ?? "",
              content: contentToText(msg.content),
            },
          ],
        });
        break;
    }
  }

  const params: AnthropicParams = {
    model,
    max_tokens: req.max_completion_tokens ?? req.max_tokens ?? defaultMaxTokens,
    messages,
  };

  const system = systemParts.filter(Boolean).join("\n\n");
  if (system) params.system = system;

  if (!isStrictSamplingModel(model)) {
    // Claude 4+ accepts temperature or top_p, not both — prefer temperature.
    if (req.temperature != null) params.temperature = req.temperature;
    else if (req.top_p != null) params.top_p = req.top_p;
  }

  if (req.stop) {
    params.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }

  if (req.tools?.length) {
    params.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));
  }

  if (req.tool_choice) {
    if (req.tool_choice === "auto") params.tool_choice = { type: "auto" };
    else if (req.tool_choice === "required") params.tool_choice = { type: "any" };
    else if (req.tool_choice === "none") params.tool_choice = { type: "none" };
    else params.tool_choice = { type: "tool", name: req.tool_choice.function.name };
  }

  if (req.reasoning_effort) {
    params.output_config = { effort: req.reasoning_effort };
    if (!isAlwaysThinkingModel(model)) params.thinking = { type: "adaptive" };
  }

  return params;
}

function safeJsonParse(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Response: Anthropic → OpenAI

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface AnthropicResponse {
  id: string;
  model: string;
  stop_reason: string | null;
  content: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  usage: AnthropicUsage;
}

function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

function mapUsage(u: AnthropicUsage | undefined): TokenUsage {
  // OpenAI prompt_tokens covers the whole input, so fold cache tokens in.
  const prompt =
    (u?.input_tokens ?? 0) +
    (u?.cache_creation_input_tokens ?? 0) +
    (u?.cache_read_input_tokens ?? 0);
  const completion = u?.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

export function fromAnthropicResponse(
  resp: AnthropicResponse,
  requestedModel: string,
): ChatCompletionResponse {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of resp.content) {
    if (block.type === "text" && block.text) textParts.push(block.text);
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        type: "function",
        function: {
          name: block.name ?? "",
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  return {
    id: `chatcmpl-${resp.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textParts.length ? textParts.join("") : null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapStopReason(resp.stop_reason),
      },
    ],
    usage: mapUsage(resp.usage),
  };
}

// ---------------------------------------------------------------------------
// Streaming: Anthropic SSE events → OpenAI chunk objects

/** Structural subset of the SDK's RawMessageStreamEvent — keeps this module pure. */
export interface AnthropicStreamEvent {
  type: string;
  message?: { id?: string; usage?: AnthropicUsage };
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: AnthropicUsage;
}

export interface StreamCollector {
  usage: TokenUsage | null;
}

/**
 * Translate an Anthropic event stream into OpenAI chat.completion.chunk
 * objects. The final chunk carries finish_reason and usage (OpenAI's
 * `include_usage` convention). `collector.usage` is populated by the time
 * the generator completes.
 */
export async function* translateStream(
  events: AsyncIterable<AnthropicStreamEvent>,
  requestedModel: string,
  collector: StreamCollector,
): AsyncGenerator<ChatCompletionChunk> {
  const created = Math.floor(Date.now() / 1000);
  let id = `chatcmpl-${Date.now().toString(36)}`;
  let promptTokens = 0;
  let completionTokens = 0;
  let finishReason: FinishReason = "stop";
  // Anthropic block index → OpenAI tool_calls index
  const toolIndex = new Map<number, number>();

  const chunk = (
    delta: ChatCompletionChunk["choices"][0]["delta"],
    finish: FinishReason = null,
    usage?: TokenUsage,
  ): ChatCompletionChunk => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: requestedModel,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });

  for await (const event of events) {
    switch (event.type) {
      case "message_start": {
        if (event.message?.id) id = `chatcmpl-${event.message.id}`;
        const u = event.message?.usage;
        promptTokens =
          (u?.input_tokens ?? 0) +
          (u?.cache_creation_input_tokens ?? 0) +
          (u?.cache_read_input_tokens ?? 0);
        yield chunk({ role: "assistant", content: "" });
        break;
      }

      case "content_block_start": {
        if (event.content_block?.type === "tool_use") {
          const idx = toolIndex.size;
          toolIndex.set(event.index ?? 0, idx);
          yield chunk({
            tool_calls: [
              {
                index: idx,
                id: event.content_block.id,
                type: "function",
                function: { name: event.content_block.name, arguments: "" },
              },
            ],
          });
        }
        break;
      }

      case "content_block_delta": {
        const d = event.delta;
        if (d?.type === "text_delta" && d.text) {
          yield chunk({ content: d.text });
        } else if (d?.type === "input_json_delta" && d.partial_json) {
          const idx = toolIndex.get(event.index ?? 0) ?? 0;
          yield chunk({
            tool_calls: [{ index: idx, function: { arguments: d.partial_json } }],
          });
        }
        // thinking_delta is intentionally not forwarded — OpenAI clients
        // have no slot for it and Fable-class models omit text anyway.
        break;
      }

      case "message_delta": {
        if (event.delta?.stop_reason) {
          finishReason = mapStopReason(event.delta.stop_reason);
        }
        if (event.usage?.output_tokens != null) {
          completionTokens = event.usage.output_tokens;
        }
        break;
      }

      case "message_stop": {
        const usage: TokenUsage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        };
        collector.usage = usage;
        yield chunk({}, finishReason, usage);
        break;
      }
    }
  }
}
