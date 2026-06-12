/**
 * Harness wiring: pointing Claude Code, Codex, OpenCode, OpenClaw, and
 * Hermes at the gateway - and, just as important, pointing them back.
 * `understudy disable` is the panic button for "the gateway died and took
 * my agents with it": one command and every harness talks to its provider
 * directly again.
 *
 * Enable records whatever it overwrote in ~/.understudy/harnesses.json so
 * disable can restore it exactly. The config transforms are pure
 * (object/text in, object/text out); I/O lives in the harness registry.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HARNESS_NAMES = ["claude", "codex", "opencode", "openclaw", "hermes"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

// ---------------------------------------------------------------------------
// Pure transforms

/** Point Claude Code at the gateway via the env block in settings.json. */
export function claudeEnable(
  settings: Record<string, unknown> | null,
  baseUrl: string,
): Record<string, unknown> {
  const out = { ...(settings ?? {}) } as Record<string, unknown>;
  out.env = { ...((out.env as Record<string, unknown>) ?? {}), ANTHROPIC_BASE_URL: baseUrl };
  return out;
}

/**
 * Remove the gateway base URL from Claude settings. Only values that look
 * like a local gateway are removed - a custom remote URL someone set by
 * hand is not ours to delete.
 */
export function claudeDisable(settings: Record<string, unknown> | null): {
  settings: Record<string, unknown>;
  changed: boolean;
} {
  const out = { ...(settings ?? {}) } as Record<string, unknown>;
  const env = { ...((out.env as Record<string, unknown>) ?? {}) };
  const value = env.ANTHROPIC_BASE_URL;
  if (typeof value === "string" && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(value)) {
    delete env.ANTHROPIC_BASE_URL;
    out.env = env;
    return { settings: out, changed: true };
  }
  return { settings: out, changed: false };
}

/** Is Claude Code currently routed through a local gateway? */
export function claudeIsEnabled(settings: Record<string, unknown> | null): boolean {
  const value = (settings?.env as Record<string, unknown> | undefined)?.ANTHROPIC_BASE_URL;
  return typeof value === "string" && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(value);
}

/**
 * Ensure the provider block exists and make understudy the default,
 * capturing whatever `model_provider` previously pointed at.
 */
export function codexEnable(
  toml: string,
  baseUrl: string,
): { toml: string; prevProvider: string | null } {
  let out = toml;
  if (!out.includes("[model_providers.understudy]")) {
    const block = [
      "",
      "[model_providers.understudy]",
      'name = "Understudy gateway"',
      `base_url = "${baseUrl}/v1"`,
      'env_key = "UNDERSTUDY_API_KEY"',
      "",
    ].join("\n");
    out = `${out}${out.endsWith("\n") || out === "" ? "" : "\n"}${block}`;
  }
  const existing = out.match(/^model_provider\s*=\s*"([^"]*)"/m);
  const prevProvider =
    existing && existing[1] !== "understudy" ? (existing[1] ?? null) : null;
  out = existing
    ? out.replace(/^model_provider\s*=.*$/m, 'model_provider = "understudy"')
    : `model_provider = "understudy"\n${out}`;
  return { toml: out, prevProvider };
}

/**
 * Hand Codex back its previous default provider (or its built-in default
 * when none was recorded). The inert provider block stays for re-enabling.
 */
export function codexDisable(
  toml: string,
  prevProvider: string | null | undefined,
): { toml: string; changed: boolean } {
  if (!/^model_provider\s*=\s*"understudy"/m.test(toml)) {
    return { toml, changed: false };
  }
  const out = prevProvider
    ? toml.replace(/^model_provider\s*=.*$/m, `model_provider = "${prevProvider}"`)
    : toml.replace(/^model_provider\s*=.*$\n?/m, "");
  return { toml: out, changed: true };
}

export function codexIsEnabled(toml: string): boolean {
  return /^model_provider\s*=\s*"understudy"/m.test(toml);
}

/** Merge the understudy provider into an OpenCode config object. */
export function opencodeEnable(
  config: Record<string, unknown> | null,
  baseUrl: string,
  apiKey: string,
): Record<string, unknown> {
  const out = { ...(config ?? {}) } as Record<string, unknown>;
  const providers = { ...((out.provider as Record<string, unknown>) ?? {}) };
  providers.understudy = {
    npm: "@ai-sdk/openai-compatible",
    name: "Understudy",
    options: { baseURL: `${baseUrl}/v1`, apiKey },
    models: {
      "claude-sonnet-4-6": { name: "Claude via Understudy" },
      "gpt-5.5": { name: "GPT via Understudy" },
    },
  };
  out.provider = providers;
  return out;
}

/** Remove the provider entry; clear a default model that points at it. */
export function opencodeDisable(config: Record<string, unknown> | null): {
  config: Record<string, unknown>;
  changed: boolean;
} {
  const out = { ...(config ?? {}) } as Record<string, unknown>;
  const providers = { ...((out.provider as Record<string, unknown>) ?? {}) };
  let changed = false;
  if (providers.understudy) {
    delete providers.understudy;
    out.provider = providers;
    changed = true;
  }
  if (typeof out.model === "string" && out.model.startsWith("understudy/")) {
    delete out.model;
    changed = true;
  }
  return { config: out, changed };
}

export function opencodeIsEnabled(config: Record<string, unknown> | null): boolean {
  return Boolean((config?.provider as Record<string, unknown> | undefined)?.understudy);
}

/** Merge the understudy provider into an OpenClaw config object. */
export function openclawEnable(
  config: Record<string, unknown> | null,
  baseUrl: string,
  apiKey: string,
): Record<string, unknown> {
  const out = { ...(config ?? {}) } as Record<string, unknown>;
  const models = { ...((out.models as Record<string, unknown>) ?? {}) };
  const providers = { ...((models.providers as Record<string, unknown>) ?? {}) };
  providers.understudy = {
    baseUrl: `${baseUrl}/v1`,
    apiKey: apiKey || "none",
    api: "openai-completions",
    models: [
      { id: "claude-sonnet-4-6", name: "Claude via Understudy" },
      { id: "gpt-5.5", name: "GPT via Understudy" },
    ],
  };
  models.providers = providers;
  out.models = models;
  return out;
}

/** Remove the provider entry; clear a default model that points at it. */
export function openclawDisable(config: Record<string, unknown> | null): {
  config: Record<string, unknown>;
  changed: boolean;
} {
  const out = { ...(config ?? {}) } as Record<string, unknown>;
  const models = { ...((out.models as Record<string, unknown>) ?? {}) };
  const providers = { ...((models.providers as Record<string, unknown>) ?? {}) };
  let changed = false;
  if (providers.understudy) {
    delete providers.understudy;
    models.providers = providers;
    out.models = models;
    changed = true;
  }
  const agents = out.agents as
    | { defaults?: { model?: { primary?: unknown } } }
    | undefined;
  if (
    typeof agents?.defaults?.model?.primary === "string" &&
    agents.defaults.model.primary.startsWith("understudy/")
  ) {
    delete agents.defaults.model.primary;
    changed = true;
  }
  return { config: out, changed };
}

export function openclawIsEnabled(config: Record<string, unknown> | null): boolean {
  const models = config?.models as { providers?: Record<string, unknown> } | undefined;
  return Boolean(models?.providers?.understudy);
}

/** Extract base_url/provider from the model: block of Hermes' config.yaml. */
export function hermesRead(yaml: string): { base_url: string; provider: string } | null {
  const block = yaml.match(/^model:\n((?:[ \t]+.*\n?)*)/m)?.[1];
  if (!block) return null;
  const get = (key: string) =>
    block.match(new RegExp(`^[ \\t]+${key}:[ \\t]*['"]?([^'"\\n]*)['"]?\\s*$`, "m"))?.[1] ?? "";
  return { base_url: get("base_url"), provider: get("provider") };
}

// ---------------------------------------------------------------------------
// State + I/O

export interface HarnessState {
  codex?: { prevProvider: string | null };
  hermes?: { prev: { base_url: string; provider: string } | null };
  [key: string]: unknown;
}

function stateFile(home: string): string {
  return join(home, ".understudy", "harnesses.json");
}

export function loadState(home: string): HarnessState {
  try {
    return JSON.parse(readFileSync(stateFile(home), "utf8"));
  } catch {
    return {};
  }
}

export function saveState(home: string, state: HarnessState): void {
  mkdirSync(dirname(stateFile(home)), { recursive: true });
  writeFileSync(stateFile(home), `${JSON.stringify(state, null, 2)}\n`);
}

function backup(path: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${Date.now()}`);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  backup(path);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function onPath(cmd: string): boolean {
  return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
}

export interface HarnessContext {
  home: string;
  baseUrl: string;
  gatewayKey: string;
}

export type HarnessStatus = "routed" | "direct" | "not installed";

interface Harness {
  /** Is the harness present on this machine? */
  detect(ctx: HarnessContext): boolean;
  /** Route the harness through the gateway, recording what was replaced. */
  enable(ctx: HarnessContext): string;
  /** Hand the harness back its direct connection. */
  disable(ctx: HarnessContext): string;
  status(ctx: HarnessContext): HarnessStatus;
}

export const HARNESSES: Record<HarnessName, Harness> = {
  claude: {
    detect: () => onPath("claude"),
    enable(ctx) {
      const path = join(ctx.home, ".claude", "settings.json");
      writeJson(path, claudeEnable(readJson(path), ctx.baseUrl));
      return `claude    routed via gateway (${path})`;
    },
    disable(ctx) {
      const path = join(ctx.home, ".claude", "settings.json");
      const { settings, changed } = claudeDisable(readJson(path));
      if (!changed) return "claude    already direct";
      writeJson(path, settings);
      return "claude    back to direct Anthropic";
    },
    status(ctx) {
      if (!this.detect(ctx)) return "not installed";
      return claudeIsEnabled(readJson(join(ctx.home, ".claude", "settings.json")))
        ? "routed"
        : "direct";
    },
  },

  codex: {
    detect: () => onPath("codex"),
    enable(ctx) {
      const path = join(process.env.CODEX_HOME ?? join(ctx.home, ".codex"), "config.toml");
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      const { toml, prevProvider } = codexEnable(text, ctx.baseUrl);
      mkdirSync(dirname(path), { recursive: true });
      backup(path);
      writeFileSync(path, toml);
      const state = loadState(ctx.home);
      if (prevProvider) saveState(ctx.home, { ...state, codex: { prevProvider } });
      return `codex     routed via gateway (${path})`;
    },
    disable(ctx) {
      const path = join(process.env.CODEX_HOME ?? join(ctx.home, ".codex"), "config.toml");
      if (!existsSync(path)) return "codex     already direct";
      const prev = loadState(ctx.home).codex?.prevProvider ?? null;
      const { toml, changed } = codexDisable(readFileSync(path, "utf8"), prev);
      if (!changed) return "codex     already direct";
      backup(path);
      writeFileSync(path, toml);
      return `codex     back to ${prev ?? "its default provider"}`;
    },
    status(ctx) {
      if (!this.detect(ctx)) return "not installed";
      const path = join(process.env.CODEX_HOME ?? join(ctx.home, ".codex"), "config.toml");
      return existsSync(path) && codexIsEnabled(readFileSync(path, "utf8"))
        ? "routed"
        : "direct";
    },
  },

  opencode: {
    detect: () => onPath("opencode"),
    enable(ctx) {
      const path = join(ctx.home, ".config", "opencode", "opencode.json");
      writeJson(path, opencodeEnable(readJson(path), ctx.baseUrl, ctx.gatewayKey || "none"));
      return `opencode  understudy provider added (${path})`;
    },
    disable(ctx) {
      const path = join(ctx.home, ".config", "opencode", "opencode.json");
      const { config, changed } = opencodeDisable(readJson(path));
      if (!changed) return "opencode  already direct";
      writeJson(path, config);
      return "opencode  understudy provider removed";
    },
    status(ctx) {
      if (!this.detect(ctx)) return "not installed";
      return opencodeIsEnabled(readJson(join(ctx.home, ".config", "opencode", "opencode.json")))
        ? "routed"
        : "direct";
    },
  },

  openclaw: {
    detect: () => onPath("openclaw"),
    enable(ctx) {
      const path = join(ctx.home, ".openclaw", "openclaw.json");
      writeJson(path, openclawEnable(readJson(path), ctx.baseUrl, ctx.gatewayKey));
      return `openclaw  understudy provider added (${path})`;
    },
    disable(ctx) {
      const path = join(ctx.home, ".openclaw", "openclaw.json");
      const { config, changed } = openclawDisable(readJson(path));
      if (!changed) return "openclaw  already direct";
      writeJson(path, config);
      return "openclaw  understudy provider removed";
    },
    status(ctx) {
      if (!this.detect(ctx)) return "not installed";
      return openclawIsEnabled(readJson(join(ctx.home, ".openclaw", "openclaw.json")))
        ? "routed"
        : "direct";
    },
  },

  hermes: {
    detect: () => onPath("hermes"),
    enable(ctx) {
      const yamlPath = join(ctx.home, ".hermes", "config.yaml");
      const prev = existsSync(yamlPath) ? hermesRead(readFileSync(yamlPath, "utf8")) : null;
      const state = loadState(ctx.home);
      saveState(ctx.home, { ...state, hermes: { prev } });
      for (const [k, v] of [
        ["model.base_url", `${ctx.baseUrl}/v1`],
        ["model.provider", "custom"],
      ]) {
        spawnSync("hermes", ["config", "set", k!, v!], { stdio: "ignore" });
      }
      return "hermes    routed via gateway (hermes config set)";
    },
    disable(ctx) {
      const yamlPath = join(ctx.home, ".hermes", "config.yaml");
      const current = existsSync(yamlPath) ? hermesRead(readFileSync(yamlPath, "utf8")) : null;
      if (!current || !/^https?:\/\/(localhost|127\.0\.0\.1):/.test(current.base_url)) {
        return "hermes    already direct";
      }
      const prev = loadState(ctx.home).hermes?.prev;
      if (!prev) {
        return [
          "hermes    can't restore automatically (no recorded previous config). Run:",
          '            hermes config set model.base_url ""',
          "            hermes config set model.provider <your-provider>",
        ].join("\n");
      }
      for (const [k, v] of [
        ["model.base_url", prev.base_url],
        ["model.provider", prev.provider],
      ]) {
        spawnSync("hermes", ["config", "set", k!, v!], { stdio: "ignore" });
      }
      return `hermes    back to ${prev.provider || "its default provider"}`;
    },
    status(ctx) {
      if (!this.detect(ctx)) return "not installed";
      const yamlPath = join(ctx.home, ".hermes", "config.yaml");
      const current = existsSync(yamlPath) ? hermesRead(readFileSync(yamlPath, "utf8")) : null;
      return current && /^https?:\/\/(localhost|127\.0\.0\.1):/.test(current.base_url)
        ? "routed"
        : "direct";
    },
  },
};

export function defaultContext(): HarnessContext {
  const home = homedir();
  let port = Number(process.env.PORT ?? 0);
  if (!port) {
    try {
      const env = readFileSync(join(home, ".understudy", ".env"), "utf8");
      port = Number(env.match(/^PORT=(\d+)/m)?.[1] ?? 3001);
    } catch {
      port = 3001;
    }
  }
  let gatewayKey = "";
  try {
    const env = readFileSync(join(home, ".understudy", ".env"), "utf8");
    gatewayKey = env.match(/^GATEWAY_API_KEYS=([^,\n]+)/m)?.[1] ?? "";
  } catch {
    // no installed .env - localhost defaults apply
  }
  return { home, baseUrl: `http://localhost:${port}`, gatewayKey };
}

/** `understudy enable|disable [harness]` - the panic button and its undo. */
export async function runToggle(
  action: "enable" | "disable",
  target: string | undefined,
): Promise<void> {
  const ctx = defaultContext();

  if (target && !HARNESS_NAMES.includes(target as HarnessName)) {
    console.error(`Unknown harness: ${target} (${HARNESS_NAMES.join(", ")})`);
    process.exit(1);
  }
  const names = target
    ? [target as HarnessName]
    : HARNESS_NAMES.filter((n) => HARNESSES[n].detect(ctx));

  if (action === "enable") {
    const up = await gatewayUp(ctx.baseUrl);
    if (!up) {
      console.log(
        `⚠️  No gateway answering at ${ctx.baseUrl} - start it with \`understudy\` or your agents will have nowhere to go.\n`,
      );
    }
  }

  for (const name of names) {
    const harness = HARNESSES[name];
    if (!harness.detect(ctx)) {
      console.log(`${name.padEnd(9)} not installed - skipped`);
      continue;
    }
    console.log(action === "enable" ? harness.enable(ctx) : harness.disable(ctx));
  }

  if (action === "disable") {
    console.log("\nHouse lights up - your agents are talking to their providers directly.");
    console.log("Re-route any time with: understudy enable");
  }
}

/** `understudy status` - who's on stage, who's benched, who's routed. */
export async function runStatus(): Promise<void> {
  const ctx = defaultContext();
  const health = await gatewayHealth(ctx.baseUrl);
  if (health) {
    const benched = Object.keys(health.cooldowns ?? {}).length;
    console.log(
      `gateway   up at ${ctx.baseUrl} (providers: ${health.providers?.join(", ") || "none"}${benched ? `; ${benched} benched` : ""})`,
    );
  } else {
    console.log(`gateway   DOWN (nothing answering at ${ctx.baseUrl})`);
  }
  for (const name of HARNESS_NAMES) {
    const status = HARNESSES[name].status(ctx);
    if (status === "not installed") continue;
    console.log(`${name.padEnd(9)} ${status === "routed" ? "routed via gateway" : "direct"}`);
  }
}

async function gatewayUp(baseUrl: string): Promise<boolean> {
  return (await gatewayHealth(baseUrl)) !== null;
}

async function gatewayHealth(
  baseUrl: string,
): Promise<{ providers?: string[]; cooldowns?: Record<string, number> } | null> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok
      ? ((await res.json()) as { providers?: string[]; cooldowns?: Record<string, number> })
      : null;
  } catch {
    return null;
  }
}
