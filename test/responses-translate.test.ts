import { describe, expect, it } from "vitest";
import {
  chatChunksToResponsesEvents,
  chatRequestToResponses,
  chatResponseToResponses,
  responsesEventsToChatChunks,
  responsesToChatRequest,
  type ResponsesRequest,
  type ResponsesStreamEvent,
} from "../src/providers/responses-translate.js";
import type { ChatCompletionChunk, ChatCompletionResponse } from "../src/types.js";

describe("responsesToChatRequest", () => {
  it("translates a Codex-shaped request (instructions, items, flat tools)", () => {
    // Mirrors real captured codex_exec/0.130.0 traffic.
    const req: ResponsesRequest = {
      model: "gpt-5-mini",
      instructions: "You are a coding agent running in the Codex CLI.",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<permissions instructions>" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Reply with exactly: hi" }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Runs a command",
          strict: false,
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: null,
      store: false,
      stream: true,
    };

    const out = responsesToChatRequest(req);
    expect(out.model).toBe("gpt-5-mini");
    expect(out.stream).toBe(true);
    expect(out.messages).toEqual([
      { role: "system", content: "You are a coding agent running in the Codex CLI." },
      { role: "system", content: "<permissions instructions>" },
      { role: "user", content: "Reply with exactly: hi" },
    ]);
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "exec_command",
          description: "Runs a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      },
    ]);
    expect(out.tool_choice).toBe("auto");
  });

  it("threads function_call / function_call_output through tool messages", () => {
    const req: ResponsesRequest = {
      model: "gpt-5-mini",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
        { type: "reasoning", summary: [], encrypted_content: null },
        {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"echo hi"}',
          call_id: "call_abc",
        },
        { type: "function_call_output", call_id: "call_abc", output: "hi\n" },
      ],
    };

    const out = responsesToChatRequest(req);
    expect(out.messages).toEqual([
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "exec_command", arguments: '{"cmd":"echo hi"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc", content: "hi\n" },
    ]);
  });

  it("accepts a bare string input", () => {
    const out = responsesToChatRequest({ model: "gpt-5-mini", input: "hello" });
    expect(out.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("chatResponseToResponses", () => {
  it("builds a completed response with message and function_call items", () => {
    const completion: ChatCompletionResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "claude-sonnet-4-6",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Running it.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "exec_command", arguments: '{"cmd":"ls"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    };

    const out = chatResponseToResponses(completion, "gpt-5-mini") as {
      object: string;
      status: string;
      model: string;
      output: Array<Record<string, unknown>>;
      usage: { input_tokens: number; output_tokens: number; total_tokens: number };
    };
    expect(out.object).toBe("response");
    expect(out.status).toBe("completed");
    expect(out.model).toBe("gpt-5-mini");
    expect(out.output).toHaveLength(2);
    expect(out.output[0]).toMatchObject({
      type: "message",
      status: "completed",
      content: [{ type: "output_text", text: "Running it." }],
    });
    expect(out.output[1]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "exec_command",
      arguments: '{"cmd":"ls"}',
    });
    expect(out.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
    });
  });
});

describe("chatChunksToResponsesEvents", () => {
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
    model: "claude-sonnet-4-6",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });

  it("emits the Responses event family for text then a function call", async () => {
    const collector = { usage: null };
    const events = [];
    for await (const ev of chatChunksToResponsesEvents(
      chunks([
        chunk({ role: "assistant", content: "" }),
        chunk({ content: "I'll run it." }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "exec_command", arguments: "" },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] }),
        chunk({}, "tool_calls", { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59 }),
      ]),
      "gpt-5-mini",
      collector,
    )) {
      events.push(ev);
    }

    expect(events.map((e) => e.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added", // message
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added", // function_call
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);

    // sequence numbers strictly increase from 0
    const seqs = events.map((e) => (e.data as { sequence_number: number }).sequence_number);
    expect(seqs).toEqual([...Array(events.length).keys()]);

    const fcAdded = events[8]!.data as { item: Record<string, unknown> };
    expect(fcAdded.item).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "exec_command",
    });

    const completed = events.at(-1)!.data as {
      response: {
        status: string;
        output: Array<Record<string, unknown>>;
        usage: { input_tokens: number; output_tokens: number };
      };
    };
    expect(completed.response.status).toBe("completed");
    expect(completed.response.output).toHaveLength(2);
    expect(completed.response.output[1]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      arguments: '{"cmd":"ls"}',
    });
    expect(completed.response.usage).toMatchObject({
      input_tokens: 50,
      output_tokens: 9,
    });
    expect(collector.usage).toEqual({
      prompt_tokens: 50,
      completion_tokens: 9,
      total_tokens: 59,
    });
  });
});

describe("chatRequestToResponses (outbound, ChatGPT backend)", () => {
  it("maps system to instructions and tool turns to call items", () => {
    const body = chatRequestToResponses("gpt-5.5", {
      model: "chatgpt/gpt-5.5",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Bash", arguments: '{"cmd":"ls"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "a.txt" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "Bash", description: "run", parameters: { type: "object" } },
        },
      ],
    }) as {
      model: string;
      store: boolean;
      stream: boolean;
      instructions: string;
      input: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };

    expect(body.model).toBe("gpt-5.5");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true); // backend is stream-only
    expect(body.instructions).toBe("Be terse.");
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
      { type: "function_call", call_id: "call_1", name: "Bash", arguments: '{"cmd":"ls"}' },
      { type: "function_call_output", call_id: "call_1", output: "a.txt" },
    ]);
    expect(body.tools[0]).toMatchObject({ type: "function", name: "Bash" });
  });

  it("defaults instructions when no system message exists", () => {
    const body = chatRequestToResponses("gpt-5.5", {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    }) as { instructions: string };
    expect(body.instructions).toBeTruthy();
  });
});

describe("responsesEventsToChatChunks (outbound, ChatGPT backend)", () => {
  async function* events(list: ResponsesStreamEvent[]) {
    for (const e of list) yield e;
  }

  it("re-dialects text and a function call into chat chunks", async () => {
    const collector = { usage: null };
    const chunks: ChatCompletionChunk[] = [];
    for await (const c of responsesEventsToChatChunks(
      events([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_text.delta", delta: "On it." },
        {
          type: "response.output_item.added",
          item: { id: "fc_1", type: "function_call", call_id: "call_9", name: "Bash" },
        },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"cmd":' },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"ls"}' },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            status: "completed",
            usage: { input_tokens: 40, output_tokens: 11, total_tokens: 51 },
          },
        },
      ]),
      "chatgpt/gpt-5.5",
      collector,
    )) {
      chunks.push(c);
    }

    expect(chunks[0]?.choices[0]?.delta.role).toBe("assistant");
    expect(chunks[1]?.choices[0]?.delta.content).toBe("On it.");
    expect(chunks[2]?.choices[0]?.delta.tool_calls?.[0]).toMatchObject({
      index: 0,
      id: "call_9",
      function: { name: "Bash" },
    });
    const args = chunks
      .flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
      .map((tc) => tc.function?.arguments ?? "")
      .join("");
    expect(args).toBe('{"cmd":"ls"}');

    const last = chunks.at(-1)!;
    expect(last.choices[0]?.finish_reason).toBe("tool_calls");
    expect(last.usage).toEqual({ prompt_tokens: 40, completion_tokens: 11, total_tokens: 51 });
    expect(collector.usage).toEqual(last.usage);
  });

  it("throws on response.failed so the stream errors visibly", async () => {
    const collector = { usage: null };
    const gen = responsesEventsToChatChunks(
      events([
        { type: "response.created", response: { id: "r" } },
        { type: "response.failed", response: { error: { message: "usage limit" } } },
      ]),
      "gpt-5.5",
      collector,
    );
    await expect(async () => {
      for await (const _ of gen) {
        // drain
      }
    }).rejects.toThrow("usage limit");
  });
});
