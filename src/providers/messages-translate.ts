/**
 * Pure translation layer for the inbound Anthropic Messages front door —
 * the mirror image of anthropic-translate.ts. Clients like Claude Code speak
 * the Messages dialect; when a request fails over to an OpenAI-compatible
 * provider, these functions carry it across and dress the answer back up so
 * the client never notices the cast change.
 */

import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ContentPart,
  FinishReason,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "../types.js";

// ---------------------------------------------------------------------------
// Inbound request shape (structural subset — unknown fields pass through to
// the Anthropic passthrough adapter and are dropped on translation)

export interface MessagesTextBlock {
  type: "text";
  text: string;
}

export interface MessagesRequest {
  model: string;
  max_tokens?: number;
  system?: string | MessagesTextBlock[];
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
  }>;
  tools?: Array<{
    name?: string;
    description?: string;
    input_schema?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  tool_choice?: { type: string; name?: string };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  /** Gateway extension, mirroring chat completions. */
  fallbacks?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Request: Anthropic Messages → OpenAI chat completions

function blockText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => b?.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function imageToPart(block: Record<string, unknown>): ContentPart | null {
  const source = block.source as
    | { type: string; url?: string; media_type?: string; data?: string }
    | undefined;
  if (!source) return null;
  if (source.type === "url" && source.url) {
    return { type: "image_url", image_url: { url: source.url } };
  }
  if (source.type === "base64" && source.data) {
    return {
      type: "image_url",
      image_url: { url: `data:${source.media_type ?? "image/png"};base64,${source.data}` },
    };
  }
  return null;
}

export function messagesToChatRequest(req: MessagesRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  const system =
    typeof req.system === "string" ? req.system : blockText(req.system ?? []);
  if (system) messages.push({ role: "system", content: system });

  for (const msg of req.messages) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: ToolCall[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: String(block.id ?? ""),
            type: "function",
            function: {
              name: String(block.name ?? ""),
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
        // thinking / redacted_thinking have no chat-completions slot — drop.
      }
      const content = textParts.length ? textParts.join("") : null;
      if (content !== null || toolCalls.length) {
        messages.push({
          role: "assistant",
          content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
      }
      continue;
    }

    // User turn: tool_result blocks become role:"tool" messages (they must
    // directly follow the assistant tool_calls turn); the rest stays user.
    const parts: ContentPart[] = [];
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: String(block.tool_use_id ?? ""),
          content: blockText(block.content),
        });
      } else if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const part = imageToPart(block);
        if (part) parts.push(part);
      }
      // documents and other rich blocks have no portable equivalent — drop.
    }
    if (parts.length) {
      messages.push({
        role: "user",
        content: parts.every((p) => p.type === "text")
          ? parts.map((p) => (p as { text: string }).text).join("\n")
          : parts,
      });
    }
  }

  const out: ChatCompletionRequest = { model: req.model, messages };

  if (req.max_tokens != null) out.max_tokens = req.max_tokens;
  if (req.temperature != null) out.temperature = req.temperature;
  else if (req.top_p != null) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.stream != null) out.stream = req.stream;

  const tools = (req.tools ?? []).filter((t) => t.name);
  if (tools.length) {
    out.tools = tools.map(
      (t): ToolDefinition => ({
        type: "function",
        function: {
          name: t.name!,
          ...(t.description ? { description: t.description } : {}),
          parameters: t.input_schema ?? { type: "object", properties: {} },
        },
      }),
    );
  }

  if (req.tool_choice) {
    switch (req.tool_choice.type) {
      case "auto":
        out.tool_choice = "auto";
        break;
      case "any":
        out.tool_choice = "required";
        break;
      case "none":
        out.tool_choice = "none";
        break;
      case "tool":
        if (req.tool_choice.name) {
          out.tool_choice = {
            type: "function",
            function: { name: req.tool_choice.name },
          };
        }
        break;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Response: OpenAI chat completions → Anthropic Messages

type MessagesStopReason = "end_turn" | "max_tokens" | "tool_use" | "refusal";

function mapFinishReason(reason: FinishReason): MessagesStopReason {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

function messagesUsage(usage: TokenUsage | null | undefined) {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function safeJsonParse(s: string): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

export function chatResponseToMessages(
  resp: ChatCompletionResponse,
  requestedModel: string,
): Record<string, unknown> {
  const choice = resp.choices[0];
  const content: Array<Record<string, unknown>> = [];

  if (choice?.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  for (const call of choice?.message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: safeJsonParse(call.function.arguments),
    });
  }

  return {
    id: resp.id.replace(/^chatcmpl-/, "msg_"),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason ?? "stop"),
    stop_sequence: null,
    usage: messagesUsage(resp.usage),
  };
}

// ---------------------------------------------------------------------------
// Streaming: OpenAI chat.completion.chunk objects → Anthropic SSE events

import type { NamedEvent } from "../sse.js";

export interface MessagesStreamCollector {
  usage: TokenUsage | null;
}

/**
 * Re-dialect a chat-completions chunk stream as Anthropic Messages events:
 * message_start, content_block_start/delta/stop per text or tool_use block,
 * then message_delta (stop_reason + usage) and message_stop.
 */
export async function* chatChunksToMessagesEvents(
  chunks: AsyncIterable<ChatCompletionChunk>,
  requestedModel: string,
  collector: MessagesStreamCollector,
): AsyncGenerator<NamedEvent> {
  let started = false;
  let id = `msg_${Date.now().toString(36)}`;
  let blockIndex = -1;
  let openBlock: "text" | "tool" | null = null;
  // chat-completions tool index → anthropic block index
  const toolBlocks = new Map<number, number>();
  let finishReason: FinishReason = "stop";
  let usage: TokenUsage | null = null;

  const start = (): NamedEvent => ({
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: messagesUsage(null),
      },
    },
  });

  const stopBlock = (): NamedEvent => {
    openBlock = null;
    return {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: blockIndex },
    };
  };

  for await (const chunk of chunks) {
    if (!started) {
      if (chunk.id) id = chunk.id.replace(/^chatcmpl-/, "msg_");
      started = true;
      yield start();
    }
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    if (choice.delta.content) {
      if (openBlock !== "text") {
        if (openBlock) yield stopBlock();
        blockIndex++;
        openBlock = "text";
        yield {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "text", text: "" },
          },
        };
      }
      yield {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: choice.delta.content },
        },
      };
    }

    for (const tc of choice.delta.tool_calls ?? []) {
      let anthropicIndex = toolBlocks.get(tc.index);
      if (anthropicIndex === undefined) {
        if (openBlock) yield stopBlock();
        blockIndex++;
        anthropicIndex = blockIndex;
        toolBlocks.set(tc.index, anthropicIndex);
        openBlock = "tool";
        yield {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: anthropicIndex,
            content_block: {
              type: "tool_use",
              id: tc.id ?? `toolu_${Date.now().toString(36)}_${tc.index}`,
              name: tc.function?.name ?? "",
              input: {},
            },
          },
        };
      }
      if (tc.function?.arguments) {
        yield {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: anthropicIndex,
            delta: { type: "input_json_delta", partial_json: tc.function.arguments },
          },
        };
      }
    }
  }

  if (!started) yield start();
  if (openBlock) yield stopBlock();

  collector.usage = usage;
  yield {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
      usage: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
      },
    },
  };
  yield { event: "message_stop", data: { type: "message_stop" } };
}
