/**
 * Pure translation layer for the inbound OpenAI Responses front door.
 * Codex (0.130+) speaks only the Responses dialect; internally everything
 * runs as chat completions, so requests are flattened into messages and
 * results are re-staged as Responses output items and SSE events.
 *
 * Shapes follow real captured Codex traffic: input items of type message /
 * function_call / function_call_output / reasoning, flat function tools, and
 * the response.* event family.
 */

import type { NamedEvent } from "../sse.js";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  FinishReason,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "../types.js";

// ---------------------------------------------------------------------------
// Inbound request shape (structural subset)

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input?: string | Array<Record<string, unknown>>;
  tools?: Array<{
    type?: string;
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  tool_choice?: string | { type: string; name?: string };
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  parallel_tool_calls?: boolean;
  stream?: boolean;
  /** Gateway extension, mirroring chat completions. */
  fallbacks?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Request: Responses → chat completions

function itemText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p): p is { type: string; text: string } =>
        typeof p?.text === "string" &&
        ["input_text", "output_text", "text"].includes(p?.type),
    )
    .map((p) => p.text)
    .join("\n");
}

export function responsesToChatRequest(req: ResponsesRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  if (req.instructions) messages.push({ role: "system", content: req.instructions });

  const items =
    typeof req.input === "string"
      ? [{ type: "message", role: "user", content: req.input }]
      : (req.input ?? []);

  for (const item of items) {
    const type = item.type ?? "message";
    switch (type) {
      case "message": {
        const role = item.role === "developer" || item.role === "system"
          ? "system"
          : item.role === "assistant"
            ? "assistant"
            : "user";
        const text = itemText(item.content);
        if (text) messages.push({ role, content: text });
        break;
      }
      case "function_call": {
        const call: ToolCall = {
          id: String(item.call_id ?? item.id ?? ""),
          type: "function",
          function: {
            name: String(item.name ?? ""),
            arguments: typeof item.arguments === "string" ? item.arguments : "{}",
          },
        };
        // Merge into a preceding assistant turn when one exists, so
        // text-then-call turns stay one message like the model produced.
        const prev = messages[messages.length - 1];
        if (prev?.role === "assistant" && prev.tool_calls) prev.tool_calls.push(call);
        else messages.push({ role: "assistant", content: null, tool_calls: [call] });
        break;
      }
      case "function_call_output":
        messages.push({
          role: "tool",
          tool_call_id: String(item.call_id ?? ""),
          content: itemText(item.output) || String(item.output ?? ""),
        });
        break;
      // reasoning items carry no portable state — drop.
    }
  }

  const out: ChatCompletionRequest = { model: req.model, messages };

  if (req.max_output_tokens != null) out.max_tokens = req.max_output_tokens;
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  if (req.stream != null) out.stream = req.stream;

  const tools = (req.tools ?? []).filter((t) => (t.type ?? "function") === "function" && t.name);
  if (tools.length) {
    out.tools = tools.map(
      (t): ToolDefinition => ({
        type: "function",
        function: {
          name: t.name!,
          ...(t.description ? { description: t.description } : {}),
          parameters: t.parameters ?? { type: "object", properties: {} },
        },
      }),
    );
  }

  if (req.tool_choice) {
    if (typeof req.tool_choice === "string") {
      if (["auto", "none", "required"].includes(req.tool_choice)) {
        out.tool_choice = req.tool_choice as "auto" | "none" | "required";
      }
    } else if (req.tool_choice.type === "function" && req.tool_choice.name) {
      out.tool_choice = { type: "function", function: { name: req.tool_choice.name } };
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Response: chat completions → Responses

function responsesUsage(usage: TokenUsage | null | undefined) {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: usage?.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: usage?.total_tokens ?? 0,
  };
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

interface OutputItem {
  id: string;
  type: "message" | "function_call";
  status: "completed";
  [key: string]: unknown;
}

function outputItems(resp: ChatCompletionResponse): OutputItem[] {
  const choice = resp.choices[0];
  const items: OutputItem[] = [];
  if (choice?.message.content) {
    items.push({
      id: newId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        { type: "output_text", annotations: [], logprobs: [], text: choice.message.content },
      ],
    });
  }
  for (const call of choice?.message.tool_calls ?? []) {
    items.push({
      id: newId("fc"),
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }
  return items;
}

function responseEnvelope(
  id: string,
  model: string,
  status: "in_progress" | "completed" | "incomplete",
  output: OutputItem[],
  usage: TokenUsage | null,
  finishReason: FinishReason = null,
): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    background: false,
    error: null,
    incomplete_details:
      status === "incomplete" && finishReason === "length"
        ? { reason: "max_output_tokens" }
        : null,
    model,
    output,
    parallel_tool_calls: false,
    usage: status === "completed" || status === "incomplete" ? responsesUsage(usage) : null,
  };
}

export function chatResponseToResponses(
  resp: ChatCompletionResponse,
  requestedModel: string,
): Record<string, unknown> {
  const status = resp.choices[0]?.finish_reason === "length" ? "incomplete" : "completed";
  return responseEnvelope(
    newId("resp"),
    requestedModel,
    status,
    outputItems(resp),
    resp.usage,
    resp.choices[0]?.finish_reason ?? null,
  );
}

// ---------------------------------------------------------------------------
// Streaming: chat.completion.chunk objects → Responses SSE events

export interface ResponsesStreamCollector {
  usage: TokenUsage | null;
}

export async function* chatChunksToResponsesEvents(
  chunks: AsyncIterable<ChatCompletionChunk>,
  requestedModel: string,
  collector: ResponsesStreamCollector,
): AsyncGenerator<NamedEvent> {
  const responseId = newId("resp");
  let seq = 0;
  const ev = (event: string, data: Record<string, unknown>): NamedEvent => ({
    event,
    data: { type: event, sequence_number: seq++, ...data },
  });

  let outputIndex = -1;
  const done: OutputItem[] = [];
  let usage: TokenUsage | null = null;
  let finishReason: FinishReason = "stop";

  // Open text item, if any
  let textItem: { id: string; text: string } | null = null;
  // chat tool index → open function_call item
  const toolItems = new Map<number, { id: string; callId: string; name: string; args: string; outputIndex: number }>();
  let openTool: number | null = null;

  yield ev("response.created", {
    response: responseEnvelope(responseId, requestedModel, "in_progress", [], null),
  });
  yield ev("response.in_progress", {
    response: responseEnvelope(responseId, requestedModel, "in_progress", [], null),
  });

  function* closeText(): Generator<NamedEvent> {
    if (!textItem) return;
    const item: OutputItem = {
      id: textItem.id,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        { type: "output_text", annotations: [], logprobs: [], text: textItem.text },
      ],
    };
    yield ev("response.output_text.done", {
      item_id: textItem.id,
      output_index: outputIndex,
      content_index: 0,
      logprobs: [],
      text: textItem.text,
    });
    yield ev("response.content_part.done", {
      item_id: textItem.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", annotations: [], logprobs: [], text: textItem.text },
    });
    yield ev("response.output_item.done", { output_index: outputIndex, item });
    done.push(item);
    textItem = null;
  }

  function* closeTool(index: number): Generator<NamedEvent> {
    const tool = toolItems.get(index);
    if (!tool) return;
    const item: OutputItem = {
      id: tool.id,
      type: "function_call",
      status: "completed",
      call_id: tool.callId,
      name: tool.name,
      arguments: tool.args,
    };
    yield ev("response.function_call_arguments.done", {
      item_id: tool.id,
      output_index: tool.outputIndex,
      arguments: tool.args,
    });
    yield ev("response.output_item.done", { output_index: tool.outputIndex, item });
    done.push(item);
    toolItems.delete(index);
  }

  for await (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    if (choice.delta.content) {
      if (!textItem) {
        if (openTool !== null) {
          yield* closeTool(openTool);
          openTool = null;
        }
        outputIndex++;
        textItem = { id: newId("msg"), text: "" };
        yield ev("response.output_item.added", {
          output_index: outputIndex,
          item: {
            id: textItem.id,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        });
        yield ev("response.content_part.added", {
          item_id: textItem.id,
          output_index: outputIndex,
          content_index: 0,
          part: { type: "output_text", annotations: [], logprobs: [], text: "" },
        });
      }
      textItem.text += choice.delta.content;
      yield ev("response.output_text.delta", {
        item_id: textItem.id,
        output_index: outputIndex,
        content_index: 0,
        logprobs: [],
        delta: choice.delta.content,
      });
    }

    for (const tc of choice.delta.tool_calls ?? []) {
      let tool = toolItems.get(tc.index);
      if (!tool) {
        yield* closeText();
        if (openTool !== null && openTool !== tc.index) {
          yield* closeTool(openTool);
        }
        outputIndex++;
        tool = {
          id: newId("fc"),
          callId: tc.id ?? newId("call"),
          name: tc.function?.name ?? "",
          args: "",
          outputIndex,
        };
        toolItems.set(tc.index, tool);
        openTool = tc.index;
        yield ev("response.output_item.added", {
          output_index: outputIndex,
          item: {
            id: tool.id,
            type: "function_call",
            status: "in_progress",
            call_id: tool.callId,
            name: tool.name,
            arguments: "",
          },
        });
      }
      if (tc.function?.arguments) {
        tool.args += tc.function.arguments;
        yield ev("response.function_call_arguments.delta", {
          item_id: tool.id,
          output_index: tool.outputIndex,
          delta: tc.function.arguments,
        });
      }
    }
  }

  yield* closeText();
  for (const index of [...toolItems.keys()]) yield* closeTool(index);

  collector.usage = usage;
  const status = finishReason === "length" ? "incomplete" : "completed";
  yield ev("response.completed", {
    response: responseEnvelope(responseId, requestedModel, status, done, usage, finishReason),
  });
}

export function responsesError(message: string, type = "invalid_request_error"): unknown {
  return { error: { message, type, param: null, code: null } };
}

// ---------------------------------------------------------------------------
// Outbound direction: internal chat completions → Responses dialect.
// Used by the chatgpt adapter, which talks to the ChatGPT Codex backend —
// the surface that accepts ChatGPT Plus/Pro subscription OAuth tokens.

/**
 * Flatten an internal request into a Responses-dialect body. System messages
 * become `instructions` (the backend requires it); assistant tool_calls and
 * tool results become function_call / function_call_output items.
 */
export function chatRequestToResponses(
  model: string,
  req: ChatCompletionRequest,
): Record<string, unknown> {
  const systemParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const msg of req.messages) {
    switch (msg.role) {
      case "system":
        systemParts.push(flattenContent(msg.content));
        break;
      case "user":
        input.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: flattenContent(msg.content) }],
        });
        break;
      case "assistant": {
        const text = flattenContent(msg.content);
        if (text) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          });
        }
        for (const call of msg.tool_calls ?? []) {
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        break;
      }
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: msg.tool_call_id ?? "",
          output: flattenContent(msg.content),
        });
        break;
    }
  }

  const body: Record<string, unknown> = {
    model,
    store: false,
    stream: true, // the Codex backend is stream-only; non-stream is assembled
    instructions: systemParts.filter(Boolean).join("\n\n") || "You are a helpful assistant.",
    input,
    tool_choice:
      req.tool_choice == null
        ? "auto"
        : typeof req.tool_choice === "string"
          ? req.tool_choice
          : { type: "function", name: req.tool_choice.function.name },
    parallel_tool_calls: true,
  };

  // gpt-5.x / o-series reasoning models on this backend reject sampling
  // params; forward temperature only for models that accept it.
  if (req.temperature != null && !isReasoningModel(model)) {
    body.temperature = req.temperature;
  }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      parameters: t.function.parameters ?? { type: "object", properties: {} },
      strict: false,
    }));
  }
  if (req.reasoning_effort) {
    body.reasoning = { effort: req.reasoning_effort, summary: "auto" };
  }

  return body;
}

/** gpt-5.x and o-series reject temperature/top_p on the Responses backend. */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[1-9])/.test(model);
}

function flattenContent(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** Structural subset of the Responses SSE event payloads we consume. */
export interface ResponsesStreamEvent {
  type: string;
  delta?: string;
  item_id?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
  };
  response?: {
    id?: string;
    status?: string;
    incomplete_details?: { reason?: string } | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    } | null;
    error?: { message?: string } | null;
  };
}

/**
 * Re-dialect a Responses event stream as chat.completion.chunk objects —
 * the mirror of chatChunksToResponsesEvents. The final chunk carries
 * finish_reason and usage.
 */
export async function* responsesEventsToChatChunks(
  events: AsyncIterable<ResponsesStreamEvent>,
  requestedModel: string,
  collector: ResponsesStreamCollector,
): AsyncGenerator<ChatCompletionChunk> {
  const created = Math.floor(Date.now() / 1000);
  let id = `chatcmpl-${Date.now().toString(36)}`;
  let started = false;
  // function_call item_id → chat tool_calls index
  const toolIndex = new Map<string, number>();
  let sawToolCalls = false;

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
      case "response.created": {
        if (event.response?.id) id = `chatcmpl-${event.response.id}`;
        started = true;
        yield chunk({ role: "assistant", content: "" });
        break;
      }

      case "response.output_text.delta": {
        if (event.delta) yield chunk({ content: event.delta });
        break;
      }

      case "response.output_item.added": {
        if (event.item?.type === "function_call" && event.item.id) {
          const idx = toolIndex.size;
          toolIndex.set(event.item.id, idx);
          sawToolCalls = true;
          yield chunk({
            tool_calls: [
              {
                index: idx,
                id: event.item.call_id ?? event.item.id,
                type: "function",
                function: { name: event.item.name ?? "", arguments: "" },
              },
            ],
          });
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        if (event.delta && event.item_id != null) {
          const idx = toolIndex.get(event.item_id) ?? 0;
          yield chunk({
            tool_calls: [{ index: idx, function: { arguments: event.delta } }],
          });
        }
        break;
      }

      case "response.completed":
      case "response.incomplete": {
        if (!started) yield chunk({ role: "assistant", content: "" });
        const u = event.response?.usage;
        const usage: TokenUsage = {
          prompt_tokens: u?.input_tokens ?? 0,
          completion_tokens: u?.output_tokens ?? 0,
          total_tokens: u?.total_tokens ?? (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0),
        };
        collector.usage = usage;
        const finish: FinishReason =
          event.response?.incomplete_details?.reason === "max_output_tokens"
            ? "length"
            : sawToolCalls
              ? "tool_calls"
              : "stop";
        yield chunk({}, finish, usage);
        break;
      }

      case "response.failed":
        throw new Error(
          event.response?.error?.message ?? "ChatGPT backend reported a failed response",
        );
    }
  }
}
