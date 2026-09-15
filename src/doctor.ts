/**
 * `understudy doctor` - one pass over everything that has to be true for
 * the show to go on, each finding paired with the command that fixes it.
 * Built for the run / read / fix / re-run loop an agent (or a tired human)
 * works through: `--json` for the agent, a short table for the human, exit
 * code 1 while anything is failing.
 *
 * Facts are gathered with I/O in `gatherFacts`; the verdicts in `assess`
 * are pure so they can be tested without a machine to inspect.
 */

import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { oauthAccountSummary } from "./oauth.js";
import { HARNESS_NAMES, HARNESSES, defaultContext, type HarnessName, type HarnessStatus } from "./harnesses.js";
import { detectManager, gatewayBaseUrl, servicePaths, serviceStatus, type ServiceStatus } from "./service.js";
import { parseEnvText } from "./setup.js";

export type Level = "ok" | "warn" | "fail";

export interface Check {
  id: string;
  level: Level;
  detail: string;
  fix?: string;
}

export interface Facts {
  nodeVersion: string;
  home: string;
  envExists: boolean;
  env: Record<string, string>;
  /** Provider names with a key or a stored subscription seat. */
  configured: string[];
  seats: Record<string, string[]>;
  /** Each FALLBACK_CHAIN entry → provider name it resolves to (null if unroutable). */
  chain: Array<{ entry: string; provider: string | null }>;
  baseUrl: string;
  health: { providers?: string[]; cooldowns?: Record<string, number> } | null;
  /** Something accepts TCP on the port even though /health didn't answer. */
  portBusy: boolean;
  service: ServiceStatus;
  harnesses: Record<HarnessName, HarnessStatus>;
}

export function assess(f: Facts): Check[] {
  const checks: Check[] = [];
  const major = Number(f.nodeVersion.replace(/^v/, "").split(".")[0]);
  checks.push(
    major >= 20
      ? { id: "node", level: "ok", detail: `node ${f.nodeVersion}` }
      : {
          id: "node",
          level: "fail",
          detail: `node ${f.nodeVersion} is too old`,
          fix: "install Node 20 or newer (https://nodejs.org or `brew install node`), then re-run install.sh",
        },
  );

  checks.push(
    f.envExists
      ? { id: "config", level: "ok", detail: `${join(f.home, ".env")}` }
      : {
          id: "config",
          level: "fail",
          detail: `no .env in ${f.home}`,
          fix: "understudy setup --yes --<provider>-key <key> [--chain provider/model,...]",
        },
  );

  checks.push(
    f.configured.length
      ? { id: "providers", level: "ok", detail: f.configured.join(", ") }
      : {
          id: "providers",
          level: "fail",
          detail: "no provider has a key or a subscription seat",
          fix: "understudy setup --yes --openai-key <key>   (or: understudy login chatgpt|anthropic|copilot)",
        },
  );

  if (f.chain.length === 0) {
    checks.push({
      id: "chain",
      level: "warn",
      detail: "FALLBACK_CHAIN is empty - requests fail over only to per-request `fallbacks`",
      fix: "understudy setup --yes --chain anthropic/claude-sonnet-4-6,openai/gpt-5.5",
    });
  } else {
    const unroutable = f.chain.filter((c) => !c.provider).map((c) => c.entry);
    const unkeyed = f.chain
      .filter((c) => c.provider && !f.configured.includes(c.provider))
      .map((c) => c.entry);
    if (unroutable.length) {
      checks.push({
        id: "chain",
        level: "fail",
        detail: `unroutable FALLBACK_CHAIN entries: ${unroutable.join(", ")}`,
        fix: "use provider/model form, e.g. --chain openai/gpt-5.5",
      });
    } else if (unkeyed.length) {
      checks.push({
        id: "chain",
        level: "fail",
        detail: `FALLBACK_CHAIN names providers with no key or seat: ${unkeyed.join(", ")}`,
        fix: "add the key (understudy setup --yes --<provider>-key ...) or drop the entry",
      });
    } else {
      checks.push({ id: "chain", level: "ok", detail: f.chain.map((c) => c.entry).join(" → ") });
    }
  }

  if (f.health) {
    const benched = Object.keys(f.health.cooldowns ?? {});
    checks.push({
      id: "gateway",
      level: "ok",
      detail: `answering at ${f.baseUrl}${benched.length ? ` (benched: ${benched.join(", ")})` : ""}`,
    });
  } else if (f.portBusy) {
    checks.push({
      id: "gateway",
      level: "fail",
      detail: `${f.baseUrl} is taken by something that is not understudy`,
      fix: "free the port, or: understudy setup --yes --port <other> && understudy start && understudy enable",
    });
  } else {
    checks.push({
      id: "gateway",
      level: "fail",
      detail: `nothing answering at ${f.baseUrl}`,
      fix: "understudy start",
    });
  }

  if (f.service.installed && f.service.running) {
    checks.push({ id: "service", level: "ok", detail: `${f.service.manager} service running` });
  } else if (f.service.installed) {
    checks.push({
      id: "service",
      level: "warn",
      detail: `${f.service.manager} service installed but not running`,
      fix: "understudy restart   (then: understudy logs)",
    });
  } else if (f.health) {
    checks.push({
      id: "service",
      level: "warn",
      detail: "gateway is running in a foreground shell, not as a service - it dies with that shell",
      fix: "stop it, then: understudy start",
    });
  } else {
    checks.push({
      id: "service",
      level: "warn",
      detail: `not installed as a ${f.service.manager} service`,
      fix: "understudy start",
    });
  }

  if (!f.env.GATEWAY_API_KEYS) {
    checks.push({
      id: "gateway_key",
      level: "warn",
      detail: "no GATEWAY_API_KEYS - fine on localhost, not if the port is reachable from elsewhere",
      fix: "understudy setup --yes --gateway-key generate && understudy restart && understudy enable",
    });
  } else {
    checks.push({ id: "gateway_key", level: "ok", detail: "gateway key set" });
  }

  const installed = HARNESS_NAMES.filter((n) => f.harnesses[n] !== "not installed");
  const direct = installed.filter((n) => f.harnesses[n] === "direct");
  if (installed.length === 0) {
    checks.push({ id: "harnesses", level: "warn", detail: "no supported harness found on PATH (claude, codex, opencode, openclaw, hermes)" });
  } else if (direct.length) {
    checks.push({
      id: "harnesses",
      level: "warn",
      detail: `talking to providers directly: ${direct.join(", ")}${installed.length > direct.length ? `; routed: ${installed.filter((n) => f.harnesses[n] === "routed").join(", ")}` : ""}`,
      fix: `understudy enable ${direct.length === installed.length ? "" : direct.join(" ")}`.trim(),
    });
  } else {
    checks.push({ id: "harnesses", level: "ok", detail: `routed: ${installed.join(", ")}` });
  }

  const multi = Object.entries(f.seats).filter(([, ids]) => ids.length > 1);
  if (multi.length) {
    checks.push({
      id: "seats",
      level: "ok",
      detail: multi.map(([p, ids]) => `${p}: ${ids.length} seats rotating`).join("; "),
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Gathering

async function tcpOpen(baseUrl: string): Promise<boolean> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve) => {
    const sock = connect({ host: hostname, port: Number(port) });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(800, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export async function gatherFacts(home = process.cwd()): Promise<Facts> {
  const envPath = join(home, ".env");
  const envExists = existsSync(envPath);
  const env = envExists ? parseEnvText(readFileSync(envPath, "utf8")) : {};
  // Provider lookups read process.env; let the file fill in what the shell
  // didn't export, exactly as `serve` does.
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;

  const { configuredProviders } = await import("./config.js");
  const { resolveModel } = await import("./router.js");
  const configured = configuredProviders().map((p) => p.name);
  const chain = (env.FALLBACK_CHAIN ?? process.env.FALLBACK_CHAIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => ({ entry, provider: resolveModel(entry)?.provider.name ?? null }));

  const baseUrl = gatewayBaseUrl(home);
  let health: Facts["health"] = null;
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const body = (await res.json()) as Record<string, unknown>;
      if (body.status === "ok" && Array.isArray(body.providers)) health = body as Facts["health"];
    }
  } catch {
    // not answering
  }
  const portBusy = health ? false : await tcpOpen(baseUrl);

  const ctx = defaultContext();
  const harnesses = Object.fromEntries(
    HARNESS_NAMES.map((n) => [n, HARNESSES[n].status(ctx)]),
  ) as Facts["harnesses"];

  return {
    nodeVersion: process.version,
    home,
    envExists,
    env,
    configured,
    seats: oauthAccountSummary(),
    chain,
    baseUrl,
    health,
    portBusy,
    service: serviceStatus(servicePaths(), detectManager()),
    harnesses,
  };
}

const MARK: Record<Level, string> = { ok: "✔", warn: "!", fail: "✖" };

export async function runDoctor(args: string[]): Promise<void> {
  const checks = assess(await gatherFacts());
  const ok = checks.every((c) => c.level !== "fail");
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
  } else {
    for (const c of checks) {
      console.log(`${MARK[c.level]} ${c.id.padEnd(12)} ${c.detail}`);
      if (c.fix && c.level !== "ok") console.log(`${" ".repeat(15)}fix: ${c.fix}`);
    }
    console.log(ok ? "\nThe show can go on." : "\nFix the ✖ items above, then run `understudy doctor` again.");
  }
  if (!ok) process.exit(1);
}
