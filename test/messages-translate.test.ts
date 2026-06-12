import { describe, expect, it } from "vitest";
import {
  chatChunksToMessagesEvents,
  chatResponseToMessages,
  messagesToChatRequest,
  type MessagesRequest,
} from "../src/providers/messages-translate.js";
import type { ChatCompletionChunk, ChatCompletionResponse } from "../src/types.js";

describe("messagesToChatRequest", () => {
  it("translates a Claude Code-shaped request (system blocks, tools)", () => {
    const req: MessagesRequest = {
      model: "claude-sonnet-4-6",
      max_tokens: 32000,
      stream: true,
      temperature: 1,
      system: [
        { type: "text", text: "You are a coding agent." },
        { type: "text", text: "Be concise." },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        {
          name: "Bash",
          description: "Run a command",
          input_schema: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ],
    };

    const out = messagesToChatRequest(req);
    expect(out.messages[0]).toEqual({
      role: "system",
      content: "You are a coding agent.\nBe concise.",
    });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(out.max_tokens).toBe(32000);
    expect(out.stream).toBe(true);
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "Bash",
          description: "Run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      },
    ]);
  });

  it("converts tool_use/tool_result turns into tool_calls/tool messages", () => {
    const req: MessagesRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Listing now." },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "a.txt\nb.txt" },
          ],
        },
      ],
    };

    const out = messagesToChatRequest(req);
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: "Listing now.",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: { name: "Bash", arguments: '{"cmd":"ls"}' },
        },
      ],
    });
    expect(out.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "toolu_1",
      content: "a.txt\nb.txt",
    });
  });

  it("drops thinking blocks and maps tool_choice", () => {
    const req: MessagesRequest = {
      model: "claude-sonnet-4-6",
      tool_choice: { type: "any" },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "x" },
            { type: "text", text: "ok" },
          ],
        },
      ],
    };
    const out = messagesToChatRequest(req);
    expect(out.messages[0]).toEqual({ role: "assistant", content: "ok" });
    expect(out.tool_choice).toBe("required");
  });

  it("converts base64 images to data URLs", () => {
    const req: MessagesRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      ],
    };
    const out = messagesToChatRequest(req);
    expect(out.messages[0]?.content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });
});

describe("chatResponseToMessages", () => {
  const completion: ChatCompletionResponse = {
    id: "chatcmpl-abc",
    object: "chat.completion",
    created: 1,
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "hello",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Bash", arguments: '{"cmd":"ls"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  it("produces an Anthropic message with text and tool_use blocks", () => {
    const out = chatResponseToMessages(completion, "claude-sonnet-4-6") as {
      type: string;
      model: string;
      content: unknown[];
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(out.type).toBe("message");
    expect(out.model).toBe("claude-sonnet-4-6"); // echoes what the client asked for
    expect(out.content).toEqual([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "call_1", name: "Bash", input: { cmd: "ls" } },
    ]);
    expect(out.stop_reason).toBe("tool_use");
    expect(out.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });
});

describe("chatChunksToMessagesEvents", () => {
  async function* chunks(list: ChatCompletionChunk[]) {
    for (const c of list) yield c;
  }
  const chunk = (
    delta: ChatCompletionChunk["choices"][0]["delta"],
    finish: ChatCompletionChunk["choices"][0]["finish_reason"] = null,
    usage?: ChatCompletionChunk["usage"],
  ): ChatCompletionChunk => ({
    id: "chatcmpl-s1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-chat",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });

  it("emits the canonical Anthropic event sequence for text + tool call", async () => {
    const collector = { usage: null };
    const events = [];
    for await (const ev of chatChunksToMessagesEvents(
      chunks([
        chunk({ role: "assistant", content: "" }),
        chunk({ content: "Hello" }),
        chunk({
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "Bash", arguments: "" } },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] }),
        chunk({}, "tool_calls", { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }),
      ]),
      "claude-sonnet-4-6",
      collector,
    )) {
      events.push(ev);
    }

    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start", // text
      "content_block_delta",
      "content_block_stop",
      "content_block_start", // tool_use
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const start = events[1]!.data as { index: number; content_block: { type: string } };
    expect(start.index).toBe(0);
    expect(start.content_block.type).toBe("text");

    const toolStart = events[4]!.data as {
      index: number;
      content_block: { type: string; id: string; name: string };
    };
    expect(toolStart.index).toBe(1);
    expect(toolStart.content_block).toMatchObject({
      type: "tool_use",
      id: "call_1",
      name: "Bash",
    });

    const toolDelta = events[5]!.data as { delta: { type: string; partial_json: string } };
    expect(toolDelta.delta).toEqual({
      type: "input_json_delta",
      partial_json: '{"cmd":"ls"}',
    });

    const messageDelta = events[7]!.data as {
      delta: { stop_reason: string };
      usage: { output_tokens: number };
    };
    expect(messageDelta.delta.stop_reason).toBe("tool_use");
    expect(messageDelta.usage.output_tokens).toBe(3);
    expect(collector.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });
  });

  it("emits a valid empty message when the stream produces no content", async () => {
    const collector = { usage: null };
    const events = [];
    for await (const ev of chatChunksToMessagesEvents(
      chunks([chunk({}, "stop")]),
      "claude-sonnet-4-6",
      collector,
    )) {
      events.push(ev);
    }
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "message_delta",
      "message_stop",
    ]);
  });
});
