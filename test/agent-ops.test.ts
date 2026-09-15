import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The agent-operable surface: flag-driven setup, service unit rendering,
 * and the doctor's verdicts. Nothing here touches launchctl, systemctl, or
 * a real harness config - those are I/O behind pure functions.
 */

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("parseSetupArgs", () => {
  it("maps provider flags, --chain, --set, --enable and --gateway-key", async () => {
    const { parseSetupArgs } = await import("../src/setup.js");
    const f = parseSetupArgs([
      "--yes",
      "--json",
      "--anthropic-key", "sk-ant-1",
      "--openai-key=sk-oa",
      "--chain", "anthropic/claude-sonnet-4-6,openai/gpt-5.5",
      "--set", "COOLDOWN_S=45",
      "--port", "5000",
      "--gateway-key", "generate",
      "--enable", "claude,codex",
    ]);
    expect(f.errors).toEqual([]);
    expect(f.yes).toBe(true);
    expect(f.json).toBe(true);
    expect(f.set).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-1",
      OPENAI_API_KEY: "sk-oa",
      FALLBACK_CHAIN: "anthropic/claude-sonnet-4-6,openai/gpt-5.5",
      COOLDOWN_S: "45",
      PORT: "5000",
    });
    expect(f.gatewayKey).toBe("generate");
    expect(f.enable).toEqual(["claude", "codex"]);
  });

  it("defaults --enable to all when bare, and reports bad input", async () => {
    const { parseSetupArgs } = await import("../src/setup.js");
    expect(parseSetupArgs(["--enable"]).enable).toBe("all");
    expect(parseSetupArgs([]).enable).toBe("none");
    const bad = parseSetupArgs(["--enable", "vim", "--port", "abc", "--set", "nope", "--bogus", "--chain"]);
    expect(bad.errors).toHaveLength(5);
  });
});

describe("runSetup --yes", () => {
  it("writes flags and exported env vars to .env without prompting and reports JSON-shaped facts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-setup-"));
    const envPath = join(dir, ".env");
    vi.stubEnv("GROQ_API_KEY", "gk-exported");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSetup } = await import("../src/setup.js");
    const report = await runSetup({
      firstRun: true,
      envPath,
      home: dir,
      interactive: false,
      args: ["--yes", "--json", "--openai-key", "sk-oa", "--gateway-key", "uk-fixed", "--enable", "none"],
    });
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain("OPENAI_API_KEY=sk-oa");
    expect(env).toContain("GROQ_API_KEY=gk-exported");
    expect(env).toContain("GATEWAY_API_KEYS=uk-fixed");
    expect(env).toContain("PORT=42986");
    // Suggested chain follows the keys that are present, in preference order.
    expect(env).toContain("FALLBACK_CHAIN=openai/gpt-5.5,groq/llama-4-maverick");
    expect(report.providers).toEqual(["openai", "groq"]);
    expect(report.gateway_key).toBe("uk-fixed");
    expect(report.base_url).toBe("http://localhost:42986");
    expect(report.next).toContain("start the gateway with `understudy start`");
    // --json printed exactly one JSON document.
    const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(JSON.parse(printed).env_path).toBe(envPath);
  });

  it("is idempotent: re-running keeps existing values and writes nothing new", async () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-setup-"));
    const envPath = join(dir, ".env");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runSetup } = await import("../src/setup.js");
    await runSetup({ envPath, home: dir, interactive: false, args: ["--yes", "--openai-key", "sk-1"] });
    const first = readFileSync(envPath, "utf8");
    const again = await runSetup({ envPath, home: dir, interactive: false, args: ["--yes"] });
    expect(again.wrote).toEqual([]);
    expect(readFileSync(envPath, "utf8")).toBe(first);
    expect(existsSync(`${envPath}.bak-${Date.now()}`)).toBe(false);
  });
});

describe("service unit files", () => {
  const p = {
    node: "/opt/homebrew/bin/node",
    cli: "/Users/x/.understudy/app/dist/cli.js",
    home: "/Users/x/.understudy",
    log: "/Users/x/.understudy/logs/understudy.log",
  };

  it("renders a launchd plist that runs `serve` from the gateway home and keeps it alive", async () => {
    const { launchdPlist, LAUNCHD_LABEL } = await import("../src/service.js");
    const plist = launchdPlist(p);
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain("<string>/Users/x/.understudy/app/dist/cli.js</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<key>WorkingDirectory</key><string>/Users/x/.understudy</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("/Users/x/.understudy/logs/understudy.log");
  });

  it("renders a systemd user unit with restart and an install target", async () => {
    const { systemdUnit } = await import("../src/service.js");
    const unit = systemdUnit(p);
    expect(unit).toContain('ExecStart="/opt/homebrew/bin/node" "/Users/x/.understudy/app/dist/cli.js" serve');
    expect(unit).toContain("WorkingDirectory=/Users/x/.understudy");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("StandardOutput=append:/Users/x/.understudy/logs/understudy.log");
  });

  it("falls back to a pidfile where no service manager fits", async () => {
    const { detectManager } = await import("../src/service.js");
    expect(detectManager("win32")).toBe("pidfile");
    expect(detectManager("freebsd")).toBe("pidfile");
  });
});

describe("doctor", () => {
  const healthy = (): Parameters<typeof import("../src/doctor.js")["assess"]>[0] => ({
    nodeVersion: "v22.4.0",
    home: "/Users/x/.understudy",
    envExists: true,
    env: { OPENAI_API_KEY: "sk", FALLBACK_CHAIN: "openai/gpt-5.5", GATEWAY_API_KEYS: "uk" },
    configured: ["openai"],
    seats: {},
    chain: [{ entry: "openai/gpt-5.5", provider: "openai" }],
    baseUrl: "http://localhost:42986",
    health: { providers: ["openai"], cooldowns: {} },
    portBusy: false,
    service: { manager: "launchd", installed: true, running: true, pid: 4242, log: "/l" },
    harnesses: { claude: "routed", codex: "routed", opencode: "not installed", openclaw: "not installed", hermes: "not installed" },
  });

  it("passes a healthy install with no fixes", async () => {
    const { assess } = await import("../src/doctor.js");
    const checks = assess(healthy());
    expect(checks.every((c) => c.level === "ok")).toBe(true);
    expect(checks.map((c) => c.id)).toEqual(["node", "config", "providers", "chain", "gateway", "service", "gateway_key", "harnesses"]);
  });

  it("names the fix for each kind of miss", async () => {
    const { assess } = await import("../src/doctor.js");
    const byId = (checks: ReturnType<typeof assess>) => Object.fromEntries(checks.map((c) => [c.id, c]));

    let c = byId(assess({ ...healthy(), nodeVersion: "v18.19.0", envExists: false, health: null, portBusy: false }));
    expect(c.node?.level).toBe("fail");
    expect(c.config?.fix).toContain("understudy setup --yes");
    expect(c.gateway?.fix).toBe("understudy start");

    c = byId(assess({ ...healthy(), health: null, portBusy: true }));
    expect(c.gateway?.level).toBe("fail");
    expect(c.gateway?.detail).toContain("taken by something that is not understudy");

    c = byId(assess({ ...healthy(), chain: [{ entry: "gpt-5.5", provider: "openai" }, { entry: "nope/x", provider: null }] }));
    expect(c.chain?.level).toBe("fail");
    expect(c.chain?.detail).toContain("nope/x");

    c = byId(assess({ ...healthy(), chain: [{ entry: "anthropic/claude-sonnet-4-6", provider: "anthropic" }] }));
    expect(c.chain?.level).toBe("fail");
    expect(c.chain?.detail).toContain("no key or seat");

    c = byId(assess({ ...healthy(), configured: [], chain: [] }));
    expect(c.providers?.level).toBe("fail");
    expect(c.chain?.level).toBe("warn");

    c = byId(assess({ ...healthy(), service: { manager: "systemd", installed: false, running: false, pid: null, log: "/l" } }));
    expect(c.service?.level).toBe("warn");
    expect(c.service?.detail).toContain("foreground shell");

    c = byId(assess({ ...healthy(), harnesses: { ...healthy().harnesses, codex: "direct" } }));
    expect(c.harnesses?.level).toBe("warn");
    expect(c.harnesses?.fix).toBe("understudy enable codex");

    c = byId(assess({ ...healthy(), seats: { chatgpt: ["a@x", "b@x"] } }));
    expect(c.seats?.detail).toBe("chatgpt: 2 seats rotating");
  });
});
