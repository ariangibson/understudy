/**
 * spotlight — tracing proxy that sits in front of Understudy.
 *
 * Every agent (Claude Code, Codex, OpenCode, Hermes, n8n HTTP nodes...)
 * points its base URL here instead of at Understudy directly.
 * Spotlight forwards everything to the gateway untouched and, on the way
 * through, records one "span" per LLM request:
 *
 *   - full request body (messages, system, tools) + stable hashes of the
 *     system prompt / tool list to spot non-deterministic prompt drift
 *   - the response, reassembled from the SSE stream into a final message
 *   - tool calls the model made (name + input) and tool results the agent
 *     sent back — the whole agentic loop is reconstructable from spans
 *   - routing truth from Understudy's own x-understudy-* headers: which
 *     provider actually served it, and whether it was a failover
 *   - latency (total + time-to-first-byte), token usage, and cost
 *     (Understudy's pricing table, overridable via prices.local.json)
 *
 * Spans go to traces/spans.jsonl (full bodies) and an in-memory ring serves
 * the viewer UI at http://127.0.0.1:42900/__ui, which also gets a chaos
 * toggle proxied through to gremlin so the whole test drives from one page.
 *
 * Run from the repo root (it imports Understudy's own pricing table):
 *   npx tsx rehearsal/spotlight.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCost } from "../src/pricing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SPOTLIGHT_PORT ?? 42900);
const UNDERSTUDY = process.env.SPOTLIGHT_UPSTREAM ?? "http://127.0.0.1:42986";
const GREMLIN = process.env.GREMLIN_CONTROL ?? "http://127.0.0.1:42901";
const GREMLIN_OPENAI = process.env.GREMLIN_OPENAI_CONTROL ?? "http://127.0.0.1:42902";
const SPANS_FILE = join(HERE, "traces", "spans.jsonl");
const MAX_CAPTURE = 4 * 1024 * 1024; // stop buffering response bodies past 4MB
const RING_SIZE = 500;

mkdirSync(dirname(SPANS_FILE), { recursive: true });

// Optional local price overrides for models Understudy's table doesn't know
// (e.g. syn: aliases on a flat subscription — set [0,0] to show $0 instead
// of "unpriced"). Format: {"syn:large": [inputPerMTok, outputPerMTok]}
let localPrices: Record<string, [number, number]> = {};
const pricesPath = join(HERE, "prices.local.json");
if (existsSync(pricesPath)) {
  try {
    localPrices = JSON.parse(readFileSync(pricesPath, "utf8"));
    console.log(`[spotlight] loaded ${Object.keys(localPrices).length} local price entries`);
  } catch (e) {
    console.warn(`[spotlight] ignoring malformed prices.local.json: ${e}`);
  }
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface Span {
  kind: "span";
  id: string;
  ts: string;
  agent: string;
  ua: string | null;
  session: string | null;
  dialect: "messages" | "chat" | "responses" | "other";
  method: string;
  path: string;
  status: number;
  model_requested: string | null;
  provider: string | null;
  model_served: string | null;
  fallback: string | null;
  cache: string | null;
  stream: boolean;
  latency_ms: number;
  ttfb_ms: number | null;
  usage: Usage | null;
  cost_usd: number | null;
  stop_reason: string | null;
  n_messages: number | null;
  tools_offered: string[] | null;
  tool_results_in: number;
  tool_calls: Array<{ id?: string; name: string; input_preview: string }>;
  text_preview: string | null;
  system_sha: string | null;
  tools_sha: string | null;
  request_sha: string | null;
  error: unknown;
  request_body: unknown;
  response_body: unknown;
  truncated: boolean;
}

const ring: Span[] = [];
let spanCounter = 0;

// Survive restarts: reload the tail of spans.jsonl into the ring so the
// viewer keeps showing history, and keep span ids monotonic.
if (existsSync(SPANS_FILE)) {
  try {
    const lines = readFileSync(SPANS_FILE, "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines.slice(-RING_SIZE)) {
      try {
        ring.push(JSON.parse(line) as Span);
      } catch {}
    }
    const last = ring[ring.length - 1];
    const m = last?.id.match(/^sp_(\d+)_/);
    if (m) spanCounter = Number(m[1]);
    console.log(`[spotlight] reloaded ${ring.length} spans from ${SPANS_FILE}`);
  } catch (e) {
    console.warn(`[spotlight] could not reload spans: ${e}`);
  }
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function preview(v: unknown, n = 200): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function costFor(model: string | null, usage: Usage | null): number | null {
  if (!model || !usage) return null;
  const fromTable = computeCost(model, usage);
  if (fromTable != null) return fromTable;
  for (const [prefix, [inp, out]] of Object.entries(localPrices)) {
    if (model.startsWith(prefix)) {
      return (usage.prompt_tokens / 1e6) * inp + (usage.completion_tokens / 1e6) * out;
    }
  }
  return null;
}

/** Map a User-Agent header to a friendly agent name. */
function agentName(req: IncomingMessage): string {
  const explicit = req.headers["x-trace-agent"];
  if (typeof explicit === "string" && explicit) return explicit;
  const ua = String(req.headers["user-agent"] ?? "").toLowerCase();
  if (ua.includes("claude-cli") || ua.includes("claude-code")) return "claude-code";
  if (ua.includes("codex")) return "codex";
  if (ua.includes("opencode")) return "opencode";
  if (ua.includes("openclaw")) return "openclaw";
  if (ua.includes("hermes")) return "hermes";
  if (ua.includes("n8n") || ua.includes("axios")) return "n8n";
  // Hermes drives the stock OpenAI python SDK; nothing else here does.
  if (ua.startsWith("openai-python") || ua.startsWith("openai/python")) return "hermes";
  return ua.split(/[\s/]/)[0] || "unknown";
}

// ---------------------------------------------------------------------------
// SSE reassembly — turn a captured event stream back into a final response
// object per dialect, so spans hold something readable instead of 400 chunks.
//
// This deliberately re-implements parsing that src/ already has (sse.ts,
// cache.ts) rather than importing it. Spotlight is the independent witness in
// the drill: if it shared the gateway's stream-assembly code, a bug in that
// code would corrupt the trace and the evidence identically, and the harness
// could never catch it. An honest observer doesn't run on the code it observes.
// ---------------------------------------------------------------------------

function sseDataLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload));
    } catch {}
  }
  return out;
}

/** Anthropic Messages SSE → {content, stop_reason, usage, model} */
function assembleMessages(text: string) {
  const blocks: Array<Record<string, unknown>> = [];
  let stop_reason: string | null = null;
  let model: string | null = null;
  let inTok = 0,
    outTok = 0;
  const partialJson: Record<number, string> = {};

  for (const ev of sseDataLines(text) as Array<Record<string, any>>) {
    switch (ev.type) {
      case "message_start": {
        model = ev.message?.model ?? null;
        const u = ev.message?.usage ?? {};
        inTok =
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        break;
      }
      case "content_block_start":
        blocks[ev.index] = { ...ev.content_block };
        if (ev.content_block?.type === "tool_use") partialJson[ev.index] = "";
        break;
      case "content_block_delta": {
        const b = blocks[ev.index];
        if (!b) break;
        const d = ev.delta ?? {};
        if (d.type === "text_delta") b.text = ((b.text as string) ?? "") + d.text;
        else if (d.type === "thinking_delta")
          b.thinking = ((b.thinking as string) ?? "") + d.thinking;
        else if (d.type === "input_json_delta")
          partialJson[ev.index] = (partialJson[ev.index] ?? "") + d.partial_json;
        break;
      }
      case "message_delta":
        stop_reason = ev.delta?.stop_reason ?? stop_reason;
        if (ev.usage?.output_tokens != null) outTok = ev.usage.output_tokens;
        break;
    }
  }
  for (const [i, json] of Object.entries(partialJson)) {
    const b = blocks[Number(i)];
    if (b && json) {
      try {
        b.input = JSON.parse(json);
      } catch {
        b.input_raw = json;
      }
    }
  }
  const usage: Usage | null =
    inTok || outTok
      ? { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok }
      : null;
  return { model, content: blocks.filter(Boolean), stop_reason, usage };
}

/** OpenAI chat-completions SSE → {content, tool_calls, finish_reason, usage} */
function assembleChat(text: string) {
  let content = "";
  let finish_reason: string | null = null;
  let model: string | null = null;
  let usage: Usage | null = null;
  const toolCalls: Record<number, { id?: string; name: string; args: string }> = {};

  for (const ev of sseDataLines(text) as Array<Record<string, any>>) {
    model = ev.model ?? model;
    if (ev.usage) {
      usage = {
        prompt_tokens: ev.usage.prompt_tokens ?? 0,
        completion_tokens: ev.usage.completion_tokens ?? 0,
        total_tokens: ev.usage.total_tokens ?? 0,
      };
    }
    const choice = ev.choices?.[0];
    if (!choice) continue;
    finish_reason = choice.finish_reason ?? finish_reason;
    const delta = choice.delta ?? choice.message ?? {};
    if (typeof delta.content === "string") content += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const slot = (toolCalls[tc.index ?? 0] ??= { name: "", args: "" });
      if (tc.id) slot.id = tc.id;
      // First non-empty name wins — some providers repeat it in every delta.
      if (tc.function?.name && !slot.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
  }
  return {
    model,
    content: content || null,
    tool_calls: Object.values(toolCalls),
    finish_reason,
    usage,
  };
}

/** OpenAI Responses SSE → the final response object from response.completed */
function assembleResponses(text: string) {
  let final: Record<string, any> | null = null;
  for (const ev of sseDataLines(text) as Array<Record<string, any>>) {
    if (ev.type === "response.completed" || ev.type === "response.incomplete") {
      final = ev.response ?? null;
    }
  }
  if (!final) return { model: null, output: null, usage: null, status: null };
  const u = final.usage;
  return {
    model: final.model ?? null,
    output: final.output ?? null,
    status: final.status ?? null,
    usage: u
      ? {
          prompt_tokens: u.input_tokens ?? 0,
          completion_tokens: u.output_tokens ?? 0,
          total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Span extraction
// ---------------------------------------------------------------------------

function dialectFor(path: string): Span["dialect"] {
  if (path.startsWith("/v1/messages")) return "messages";
  if (path.startsWith("/v1/chat/completions")) return "chat";
  if (path.startsWith("/v1/responses")) return "responses";
  return "other";
}

function extractRequestFacts(dialect: Span["dialect"], body: any) {
  const facts = {
    model: (body?.model as string) ?? null,
    stream: body?.stream === true,
    n_messages: null as number | null,
    tools_offered: null as string[] | null,
    tool_results_in: 0,
    system_sha: null as string | null,
    tools_sha: null as string | null,
    session: null as string | null,
  };
  if (!body || typeof body !== "object") return facts;

  if (dialect === "messages") {
    facts.n_messages = Array.isArray(body.messages) ? body.messages.length : null;
    if (body.system) facts.system_sha = sha(JSON.stringify(body.system));
    if (Array.isArray(body.tools)) {
      facts.tools_offered = body.tools.map((t: any) => t.name ?? "?");
      facts.tools_sha = sha(JSON.stringify(body.tools.map((t: any) => t.name)));
    }
    const last = body.messages?.[body.messages.length - 1];
    if (Array.isArray(last?.content)) {
      facts.tool_results_in = last.content.filter((b: any) => b?.type === "tool_result").length;
    }
    facts.session = body.metadata?.user_id ?? null;
  } else if (dialect === "chat") {
    facts.n_messages = Array.isArray(body.messages) ? body.messages.length : null;
    const sys = body.messages?.find((m: any) => m.role === "system");
    if (sys) facts.system_sha = sha(JSON.stringify(sys.content));
    if (Array.isArray(body.tools)) {
      facts.tools_offered = body.tools.map((t: any) => t.function?.name ?? "?");
      facts.tools_sha = sha(JSON.stringify(facts.tools_offered));
    }
    facts.tool_results_in = (body.messages ?? []).filter((m: any) => m.role === "tool").length;
  } else if (dialect === "responses") {
    facts.n_messages = Array.isArray(body.input) ? body.input.length : null;
    if (body.instructions) facts.system_sha = sha(String(body.instructions));
    if (Array.isArray(body.tools)) {
      facts.tools_offered = body.tools.map((t: any) => t.name ?? t.type ?? "?");
      facts.tools_sha = sha(JSON.stringify(facts.tools_offered));
    }
    if (Array.isArray(body.input)) {
      facts.tool_results_in = body.input.filter(
        (i: any) => i?.type === "function_call_output",
      ).length;
    }
  }
  return facts;
}

function extractResponseFacts(
  dialect: Span["dialect"],
  raw: string,
  contentType: string,
) {
  const out = {
    body: null as unknown,
    usage: null as Usage | null,
    stop_reason: null as string | null,
    tool_calls: [] as Span["tool_calls"],
    text_preview: null as string | null,
  };

  const isSSE = contentType.includes("text/event-stream");

  if (!isSSE) {
    try {
      out.body = JSON.parse(raw);
    } catch {
      out.body = raw.slice(0, 4000);
      return out;
    }
    const b = out.body as any;
    if (dialect === "messages" && Array.isArray(b?.content)) {
      out.stop_reason = b.stop_reason ?? null;
      const u = b.usage ?? {};
      const inTok =
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0);
      if (u.input_tokens != null || u.output_tokens != null) {
        out.usage = {
          prompt_tokens: inTok,
          completion_tokens: u.output_tokens ?? 0,
          total_tokens: inTok + (u.output_tokens ?? 0),
        };
      }
      for (const blk of b.content) {
        if (blk?.type === "tool_use")
          out.tool_calls.push({ id: blk.id, name: blk.name, input_preview: preview(blk.input) });
        if (blk?.type === "text" && !out.text_preview) out.text_preview = preview(blk.text, 300);
      }
    } else if (dialect === "chat" && b?.choices) {
      const msg = b.choices[0]?.message ?? {};
      out.stop_reason = b.choices[0]?.finish_reason ?? null;
      if (b.usage) {
        out.usage = {
          prompt_tokens: b.usage.prompt_tokens ?? 0,
          completion_tokens: b.usage.completion_tokens ?? 0,
          total_tokens: b.usage.total_tokens ?? 0,
        };
      }
      if (msg.content) out.text_preview = preview(msg.content, 300);
      for (const tc of msg.tool_calls ?? []) {
        out.tool_calls.push({
          id: tc.id,
          name: tc.function?.name ?? "?",
          input_preview: preview(tc.function?.arguments ?? ""),
        });
      }
    }
    return out;
  }

  // SSE: reassemble per dialect
  if (dialect === "messages") {
    const m = assembleMessages(raw);
    out.body = m;
    out.usage = m.usage;
    out.stop_reason = m.stop_reason;
    for (const blk of m.content as any[]) {
      if (blk?.type === "tool_use")
        out.tool_calls.push({
          id: blk.id,
          name: blk.name,
          input_preview: preview(blk.input ?? blk.input_raw ?? {}),
        });
      if (blk?.type === "text" && !out.text_preview) out.text_preview = preview(blk.text, 300);
    }
  } else if (dialect === "chat") {
    const m = assembleChat(raw);
    out.body = m;
    out.usage = m.usage;
    out.stop_reason = m.finish_reason;
    if (m.content) out.text_preview = preview(m.content, 300);
    for (const tc of m.tool_calls) {
      out.tool_calls.push({ id: tc.id, name: tc.name, input_preview: preview(tc.args) });
    }
  } else if (dialect === "responses") {
    const m = assembleResponses(raw);
    out.body = m;
    out.usage = m.usage;
    out.stop_reason = m.status;
    for (const item of (m.output as any[]) ?? []) {
      if (item?.type === "function_call") {
        out.tool_calls.push({
          id: item.call_id,
          name: item.name ?? "?",
          input_preview: preview(item.arguments ?? ""),
        });
      }
      if (item?.type === "message" && !out.text_preview) {
        const txt = (item.content ?? []).find((c: any) => c?.type === "output_text");
        if (txt) out.text_preview = preview(txt.text, 300);
      }
    }
  } else {
    out.body = raw.slice(0, 4000);
  }
  return out;
}

function pushSpan(span: Span) {
  ring.push(span);
  if (ring.length > RING_SIZE) ring.shift();
  // Async append: spans can carry multi-MB bodies, and a sync write here
  // would stall every other agent's in-flight stream.
  appendFile(SPANS_FILE, JSON.stringify(span) + "\n").catch((e) =>
    console.error("[spotlight] span write failed:", e),
  );
  const fb = span.fallback ? `  ⚠ FALLBACK ${span.fallback}` : "";
  console.log(
    `[spotlight] ${span.agent} ${span.dialect} ${span.status} ` +
      `${span.provider ?? "?"}/${span.model_served ?? span.model_requested ?? "?"} ` +
      `${span.latency_ms}ms ${span.tool_calls.length ? `tools:[${span.tool_calls.map((t) => t.name).join(",")}]` : ""}${fb}`,
  );
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const STRIP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "content-encoding",
  "keep-alive",
]);

function summarize(s: Span) {
  const { request_body, response_body, ...rest } = s;
  return rest;
}

async function handleInternal(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (url.pathname === "/__ui") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(HERE, "viewer.html")));
    return;
  }
  if (url.pathname === "/__spans") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(ring.map(summarize)));
    return;
  }
  if (url.pathname === "/__span") {
    const id = url.searchParams.get("id");
    const span = ring.find((s) => s.id === id);
    res.writeHead(span ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(span ?? { error: "not found (evicted from ring?)" }));
    return;
  }
  if (url.pathname === "/__chaos") {
    // proxy the chaos control through so the viewer stays same-origin
    const target = url.searchParams.get("target") === "openai" ? GREMLIN_OPENAI : GREMLIN;
    let body = "";
    for await (const c of req) body += c;
    try {
      const r = await fetch(`${target}/__chaos`, {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: req.method === "POST" ? body : undefined,
      });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(await r.text());
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end('{"error":"gremlin unreachable"}');
    }
    return;
  }
  if (url.pathname === "/__health") {
    const [g, go, u] = await Promise.all([
      fetch(`${GREMLIN}/__chaos`).then((r) => r.json()).catch(() => null),
      fetch(`${GREMLIN_OPENAI}/__chaos`).then((r) => r.json()).catch(() => null),
      fetch(`${UNDERSTUDY}/health`).then((r) => r.json()).catch(() => null),
    ]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ gremlin: g, gremlin_openai: go, understudy: u, spans: ring.length }),
    );
    return;
  }
  res.writeHead(404).end("not found");
}

const server = createServer((req, res) => {
  // Client aborts and upstream restarts are routine mid-drill; an unhandled
  // stream error must never take the tracing proxy (and viewer) down.
  res.on("error", () => {});
  handle(req, res).catch((err) => {
    console.error("[spotlight] request error:", err);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end();
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  if (url.pathname.startsWith("/__")) {
    try {
      await handleInternal(req, res, url);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e));
    }
    return;
  }

  // ---- proxy to Understudy, capturing a span ----------------------------
  const started = Date.now();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const reqBody = Buffer.concat(chunks);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${UNDERSTUDY}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method!) ? undefined : reqBody,
    });
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `spotlight: understudy unreachable: ${err}` } }));
    return;
  }

  const outHeaders: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    if (!STRIP.has(k)) outHeaders[k] = v;
  });
  res.writeHead(upstream.status, outHeaders);

  // Only the LLM front doors become spans; don't buffer /health, /v1/models...
  const dialect = dialectFor(url.pathname);
  const isLLMCall =
    req.method === "POST" &&
    dialect !== "other" &&
    !url.pathname.includes("count_tokens");

  let ttfb: number | null = null;
  let captured = "";
  let truncated = false;
  const decoder = new TextDecoder();

  if (upstream.body) {
    for await (const chunk of upstream.body) {
      if (ttfb === null) ttfb = Date.now() - started;
      res.write(chunk);
      if (!isLLMCall) continue;
      if (captured.length < MAX_CAPTURE) {
        captured += decoder.decode(chunk as Uint8Array, { stream: true });
      } else {
        truncated = true;
      }
    }
  }
  res.end();
  const latency = Date.now() - started;

  if (!isLLMCall) return;

  let parsedReq: unknown = null;
  try {
    parsedReq = JSON.parse(reqBody.toString("utf8"));
  } catch {}

  const rf = extractRequestFacts(dialect, parsedReq);
  const contentType = upstream.headers.get("content-type") ?? "";
  const resp = extractResponseFacts(dialect, captured, contentType);

  const provider = upstream.headers.get("x-understudy-provider");
  const modelServed =
    upstream.headers.get("x-understudy-model") ??
    ((resp.body as any)?.model ?? null);

  pushSpan({
    kind: "span",
    id: `sp_${String(++spanCounter).padStart(6, "0")}_${started}`,
    ts: new Date(started).toISOString(),
    agent: agentName(req),
    ua: (req.headers["user-agent"] as string) ?? null,
    session: rf.session,
    dialect,
    method: req.method!,
    path: url.pathname,
    status: upstream.status,
    model_requested: rf.model,
    provider,
    model_served: modelServed,
    fallback: upstream.headers.get("x-understudy-fallback"),
    cache: upstream.headers.get("x-understudy-cache"),
    stream: rf.stream,
    latency_ms: latency,
    ttfb_ms: ttfb,
    usage: resp.usage,
    cost_usd: costFor(modelServed, resp.usage),
    stop_reason: resp.stop_reason,
    n_messages: rf.n_messages,
    tools_offered: rf.tools_offered,
    tool_results_in: rf.tool_results_in,
    tool_calls: resp.tool_calls,
    text_preview: resp.text_preview,
    system_sha: rf.system_sha,
    tools_sha: rf.tools_sha,
    request_sha: sha(reqBody.toString("utf8")),
    error: upstream.status >= 400 ? resp.body : null,
    request_body: parsedReq,
    response_body: resp.body,
    truncated,
  });
}

// Default to loopback: spans hold full conversation bodies and the proxy
// spends real API keys. Set SPOTLIGHT_HOST=0.0.0.0 to accept LAN traffic
// (e.g. n8n on another machine) on a network you trust.
const HOST = process.env.SPOTLIGHT_HOST || "127.0.0.1";

server.listen(PORT, HOST, () => {
  console.log(`[spotlight] tracing proxy on http://${HOST}:${PORT} → ${UNDERSTUDY}`);
  console.log(`[spotlight] viewer at http://127.0.0.1:${PORT}/__ui`);
});
