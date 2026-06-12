#!/usr/bin/env node
/**
 * Dev tool: logging passthrough proxy for capturing harness wire traffic.
 *
 *   node scripts/capture-proxy.mjs <port> <target-base-url> [capture-dir]
 *
 * Example:
 *   node scripts/capture-proxy.mjs 4040 https://api.anthropic.com tmp/captures/claude
 *   ANTHROPIC_BASE_URL=http://localhost:4040 claude -p "hi"
 *
 * Each request is written to <capture-dir>/<n>-<method>-<path>.json with the
 * full request and response (SSE bodies captured as text).
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [port, target, dir = "tmp/captures"] = process.argv.slice(2);
if (!port || !target) {
  console.error("usage: capture-proxy.mjs <port> <target-base-url> [capture-dir]");
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
let seq = 0;

createServer(async (req, res) => {
  const n = ++seq;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const reqBody = Buffer.concat(chunks).toString("utf8");

  const url = new URL(req.url, target);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];

  const record = {
    request: {
      method: req.method,
      path: req.url,
      headers,
      body: tryJson(reqBody),
    },
    response: null,
  };

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : reqBody,
    });

    const resHeaders = Object.fromEntries(upstream.headers.entries());
    delete resHeaders["content-encoding"];
    delete resHeaders["content-length"];
    res.writeHead(upstream.status, resHeaders);

    const parts = [];
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        parts.push(Buffer.from(chunk));
        res.write(chunk);
      }
    }
    res.end();
    const resBody = Buffer.concat(parts).toString("utf8");
    record.response = {
      status: upstream.status,
      headers: resHeaders,
      body: resHeaders["content-type"]?.includes("event-stream")
        ? resBody
        : tryJson(resBody),
    };
  } catch (err) {
    record.response = { error: String(err) };
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }

  const safePath = req.url.replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
  const file = join(dir, `${String(n).padStart(3, "0")}-${req.method}-${safePath}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`[${n}] ${req.method} ${req.url} -> ${record.response?.status ?? "ERR"} (${file})`);
}).listen(Number(port), () => {
  console.log(`capture-proxy on :${port} -> ${target}, logging to ${dir}/`);
});

function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
