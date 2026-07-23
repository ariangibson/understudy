#!/usr/bin/env node
/**
 * gremlin — chaos proxy that sits between Understudy and api.anthropic.com.
 *
 * Understudy is pointed here via UNDERSTUDY_ANTHROPIC_UPSTREAM. Normally every
 * request is forwarded verbatim to the real Anthropic API. When chaos is
 * armed, POST /v1/messages gets a synthetic 429 (rate_limit_error) instead,
 * which is exactly what a real rate limit looks like to Understudy — so the
 * gateway's bench/failover logic runs for real, not in a mock.
 *
 * Control API (also proxied through spotlight at /__chaos):
 *   GET  /__chaos                     → current state
 *   POST /__chaos {"mode":"on"}       → 429 every /v1/messages until off
 *   POST /__chaos {"mode":"count","count":2} → 429 the next 2, then auto-off
 *   POST /__chaos {"mode":"off"}      → pass everything through
 *   Optional fields: status (default 429), retryAfterS (default 5)
 *
 * /v1/messages/count_tokens is never faulted — it has no failover path and
 * a fault there just confuses the client without testing anything.
 */

import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GREMLIN_PORT ?? 42901);
const UPSTREAM = process.env.GREMLIN_UPSTREAM ?? "https://api.anthropic.com";
// Which provider dialect to shape fault bodies in, and which paths to fault.
const FLAVOR = process.env.GREMLIN_FLAVOR ?? "anthropic"; // anthropic | openai
const FAULT_PATHS = (process.env.GREMLIN_FAULT_PATHS ?? "/v1/messages")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const EVENTS = join(HERE, "traces", "events.jsonl");
mkdirSync(dirname(EVENTS), { recursive: true });

const chaos = {
  mode: "off", // off | on | count
  count: 0, // remaining faults in count mode
  status: 429,
  retryAfterS: 5,
  faultsInjected: 0,
};

function logEvent(kind, extra) {
  const evt = { kind, ts: new Date().toISOString(), target: FLAVOR, ...extra };
  try {
    appendFileSync(EVENTS, JSON.stringify(evt) + "\n");
  } catch {}
  console.log(`[gremlin] ${kind}`, JSON.stringify(extra ?? {}));
}

// Hop-by-hop / transport headers we must not forward in either direction.
const STRIP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding", // let fetch negotiate; we re-serve decompressed bytes
  "content-encoding",
  "keep-alive",
]);

function faultBody() {
  const message = "Simulated rate limit injected by gremlin (test harness)";
  if (FLAVOR === "openai") {
    return {
      error: {
        message,
        type: chaos.status === 429 ? "rate_limit_error" : "server_error",
        code: chaos.status === 429 ? "rate_limit_exceeded" : null,
      },
    };
  }
  return {
    type: "error",
    error: {
      type: chaos.status === 429 ? "rate_limit_error" : "overloaded_error",
      message,
    },
  };
}

function shouldFault(method, path) {
  if (method !== "POST" || !FAULT_PATHS.includes(path)) return false;
  if (chaos.mode === "on") return true;
  if (chaos.mode === "count" && chaos.count > 0) return true;
  return false;
}

const server = createServer((req, res) => {
  // Client aborts and upstream resets are routine during chaos drills; an
  // unhandled stream error must never take the proxy down with it.
  res.on("error", () => {});
  handle(req, res).catch((err) => {
    logEvent("proxy_error", { error: String(err) });
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end();
  });
});

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // --- control plane ---------------------------------------------------
  if (url.pathname === "/__chaos") {
    if (req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      try {
        const cmd = JSON.parse(body || "{}");
        if (cmd.mode) chaos.mode = cmd.mode;
        if (cmd.mode === "count") chaos.count = Number(cmd.count ?? 1);
        if (cmd.mode === "off") chaos.count = 0;
        // Arming resets status/retry to defaults unless given — otherwise a
        // past `overload` would silently linger behind a button labeled 429.
        if (cmd.mode === "on" || cmd.mode === "count") {
          chaos.status = Number(cmd.status ?? 429);
          chaos.retryAfterS = Number(cmd.retryAfterS ?? 5);
        }
        logEvent("chaos_toggle", { ...chaos });
      } catch {
        res.writeHead(400).end('{"error":"bad json"}');
        return;
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(chaos));
    return;
  }

  // --- fault injection ---------------------------------------------------
  if (shouldFault(req.method, url.pathname)) {
    if (chaos.mode === "count" && --chaos.count <= 0) chaos.mode = "off";
    chaos.faultsInjected++;
    // Drain the request body so the client socket isn't left hanging.
    for await (const _ of req) void _;
    logEvent("chaos_fault", {
      path: url.pathname,
      status: chaos.status,
      retryAfterS: chaos.retryAfterS,
      remaining: chaos.mode === "count" ? chaos.count : null,
    });
    res.writeHead(chaos.status, {
      "content-type": "application/json",
      "retry-after": String(chaos.retryAfterS),
    });
    res.end(JSON.stringify(faultBody()));
    return;
  }

  // --- passthrough -------------------------------------------------------
  // The body is opaque to gremlin, so stream it straight through — no copy,
  // and the upstream request starts before the last client byte arrives.
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
  }

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      ...(["GET", "HEAD"].includes(req.method)
        ? {}
        : { body: req, duplex: "half" }),
    });
  } catch (err) {
    logEvent("upstream_unreachable", { error: String(err) });
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message: `gremlin: upstream unreachable: ${err}` },
      }),
    );
    return;
  }

  const outHeaders = {};
  upstream.headers.forEach((v, k) => {
    if (!STRIP.has(k)) outHeaders[k] = v;
  });
  res.writeHead(upstream.status, outHeaders);

  if (upstream.body) {
    for await (const chunk of upstream.body) res.write(chunk);
  }
  res.end();
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[gremlin:${FLAVOR}] chaos upstream on http://127.0.0.1:${PORT} → ${UPSTREAM} (faults: ${FAULT_PATHS.join(", ")})`,
  );
});
