import { describe, expect, it } from "vitest";
import {
  fromAnthropicResponse,
  isStrictSamplingModel,
  toAnthropicParams,
  translateStream,
  type AnthropicStreamEvent,
  type StreamCollector,
} from "../src/providers/anthropic-translate.js";
import type { ChatCompletionRequest } from "../src/types.js";

const base: ChatCompletionRequest = {
  model: "anthropic/claude-sonnet-4-6",
  messages: [{ role: "user", content: "hi" }],
};

describe("toAnthropicParams", () => {
  it("hoists system messages into the system param", () => {
    const params = toAnthropicParams(
      "claude-sonnet-4-6",
      {
        ...base,
        messages: [
          { role: "system", content: "Be terse." },
          { role: "system", content: "Use French." },
          { role: "user", content: "hi" },
        ],
      },
      4096,
    );
    expect(params.system).toBe("Be terse.\n\nUse French.");
    expect(params.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("applies max_completion_tokens over max_tokens over default", () => {
    expect(toAnthropicParams("m", base, 4096).max_tokens).toBe(4096);
    expect(toAnthropicParams("m", { ...base, max_tokens: 100 }, 4096).max_tokens).toBe(100);
    expect(
      toAnthropicParams("m", { ...base, max_tokens: 100, max_completion_tokens: 7 }, 4096)
        .max_tokens,
    ).toBe(7);
  });

  it("keeps temperature on Sonnet 4.6 but strips it on Opus 4.8 and Fable 5", () => {
    const req = { ...base, temperature: 0.5, top_p: 0.9 };
    const sonnet = toAnthropicParams("claude-sonnet-4-6", req, 4096);
    expect(sonnet.temperature).toBe(0.5);
    expect(sonnet.top_p).toBeUndefined(); // never both on Claude 4+

    for (const model of ["claude-opus-4-8", "claude-fable-5"]) {
      const params = toAnthropicParams(model, req, 4096);
      expect(params.temperature).toBeUndefined();
      expect(params.top_p).toBeUndefined();
    }
  });

  it("translates OpenAI tool definitions and tool history", () => {
    const params = toAnthropicParams(
      "claude-sonnet-4-6",
      {
        ...base,
        messages: [
          { role: "user", content: "weather in Paris?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "18°C, sunny" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
        tool_choice: "required",
      },
      4096,
    );

    expect(params.tools).toEqual([
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
    expect(params.tool_choice).toEqual({ type: "any" });
    expect(params.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
      ],
    });
    expect(params.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "18°C, sunny" }],
    });
  });

  it("converts data-URL images to base64 blocks and https to url blocks", () => {
    const params = toAnthropicParams(
      "claude-sonnet-4-6",
      {
        ...base,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
              { type: "image_url", image_url: { url: "https://x.test/cat.jpg" } },
            ],
          },
        ],
      },
      4096,
    );
    expect(params.messages[0]?.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "image", source: { type: "url", url: "https://x.test/cat.jpg" } },
    ]);
  });

  it("maps reasoning_effort to adaptive thinking + effort, omitting thinking on Fable", () => {
    const req = { ...base, reasoning_effort: "high" as const };
    const opus = toAnthropicParams("claude-opus-4-8", req, 4096);
    expect(opus.thinking).toEqual({ type: "adaptive" });
    expect(opus.output_config).toEqual({ effort: "high" });

    const fable = toAnthropicParams("claude-fable-5", req, 4096);
    expect(fable.thinking).toBeUndefined(); // always-on; param must be omitted
    expect(fable.output_config).toEqual({ effort: "high" });
  });
});

describe("isStrictSamplingModel", () => {
  it("classifies model families correctly", () => {
    expect(isStrictSamplingModel("claude-fable-5")).toBe(true);
    expect(isStrictSamplingModel("claude-opus-4-8")).toBe(true);
    expect(isStrictSamplingModel("claude-opus-4-7")).toBe(true);
    expect(isStrictSamplingModel("claude-opus-4-6")).toBe(false);
    expect(isStrictSamplingModel("claude-sonnet-4-6")).toBe(false);
    expect(isStrictSamplingModel("claude-haiku-4-5")).toBe(false);
  });
});

describe("fromAnthropicResponse", () => {
  it("maps text, tool calls, stop reasons, and usage", () => {
    const out = fromAnthropicResponse(
      {
        id: "msg_123",
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Checking..." },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 90,
        },
      },
      "anthropic/claude-sonnet-4-6",
    );

    expect(out.id).toBe("chatcmpl-msg_123");
    expect(out.model).toBe("anthropic/claude-sonnet-4-6");
    expect(out.choices[0]?.finish_reason).toBe("tool_calls");
    expect(out.choices[0]?.message.content).toBe("Checking...");
    expect(out.choices[0]?.message.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ]);
    // cache tokens fold into prompt_tokens
    expect(out.usage).toEqual({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 });
  });

  it("maps refusal to content_filter and empty content to null", () => {
    const out = fromAnthropicResponse(
      { id: "msg_r", model: "claude-fable-5", stop_reason: "refusal", content: [], usage: {} },
      "claude-fable-5",
    );
    expect(out.choices[0]?.finish_reason).toBe("content_filter");
    expect(out.choices[0]?.message.content).toBeNull();
  });
});

describe("translateStream", () => {
  async function* fake(events: AnthropicStreamEvent[]) {
    yield* events;
  }

  async function collect(events: AnthropicStreamEvent[]) {
    const collector: StreamCollector = { usage: null };
    const chunks = [];
    for await (const chunk of translateStream(fake(events), "claude-sonnet-4-6", collector)) {
      chunks.push(chunk);
    }
    return { chunks, collector };
  }

  it("translates a text stream into OpenAI chunks with final usage", async () => {
    const { chunks, collector } = await collect([
      { type: "message_start", message: { id: "msg_s", usage: { input_tokens: 12 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]);

    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant", content: "" });
    expect(chunks[1]?.choices[0]?.delta.content).toBe("Hel");
    expect(chunks[2]?.choices[0]?.delta.content).toBe("lo");

    const last = chunks.at(-1)!;
    expect(last.choices[0]?.finish_reason).toBe("stop");
    expect(last.usage).toEqual({ prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 });
    expect(collector.usage).toEqual(last.usage);
    expect(chunks.every((ch) => ch.id === "chatcmpl-msg_s")).toBe(true);
  });

  it("translates tool_use blocks into incremental tool_calls deltas", async () => {
    const { chunks } = await collect([
      { type: "message_start", message: { id: "msg_t", usage: { input_tokens: 1 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_9", name: "get_weather" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city":' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"Paris"}' },
      },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ]);

    const start = chunks[1]?.choices[0]?.delta.tool_calls?.[0];
    expect(start).toMatchObject({
      index: 0,
      id: "toolu_9",
      type: "function",
      function: { name: "get_weather", arguments: "" },
    });
    const args = chunks
      .slice(2, 4)
      .map((ch) => ch.choices[0]?.delta.tool_calls?.[0]?.function?.arguments)
      .join("");
    expect(args).toBe('{"city":"Paris"}');
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
  });
});
