/**
 * `understudy setup` - first-run configuration. Collects provider keys into
 * .env, picks a fallback chain, and (per harness, opt-in) routes the
 * installed harnesses through the gateway via the same enable functions
 * that back `understudy enable/disable`. Every file it touches gets a
 * timestamped .bak first.
 *
 * Two modes share one write path:
 *   - interactive wizard (a human at a TTY)
 *   - non-interactive (`--yes`, or no TTY): answers come from flags and
 *     exported env vars, nothing is asked, `--json` reports what happened.
 *     This is the path an agent setting up understudy for someone takes.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  HARNESS_NAMES,
  HARNESSES,
  type HarnessContext,
  type HarnessName,
} from "./harnesses.js";

// ---------------------------------------------------------------------------
// Pure helpers

/** Update KEY=value lines in .env text, appending keys that don't exist. */
export function upsertEnvFile(text: string, updates: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    out = pattern.test(out)
      ? out.replace(pattern, line)
      : `${out}${out.endsWith("\n") || out === "" ? "" : "\n"}${line}\n`;
  }
  return out;
}

export function parseEnvText(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2]) vars[m[1]!] = m[2]!;
  }
  return vars;
}

export const PROVIDER_KEYS: Array<{ env: string; label: string; flag: string }> = [
  { env: "ANTHROPIC_API_KEY", label: "Anthropic (claude-*)", flag: "anthropic-key" },
  { env: "OPENAI_API_KEY", label: "OpenAI platform (gpt-*)", flag: "openai-key" },
  { env: "GOOGLE_API_KEY", label: "Google (gemini-*)", flag: "google-key" },
  { env: "XAI_API_KEY", label: "xAI (grok-*)", flag: "xai-key" },
  { env: "GROQ_API_KEY", label: "Groq (fast open models)", flag: "groq-key" },
  { env: "DEEPSEEK_API_KEY", label: "DeepSeek", flag: "deepseek-key" },
  { env: "MISTRAL_API_KEY", label: "Mistral", flag: "mistral-key" },
  { env: "SYNTHETIC_API_KEY", label: "synthetic.new (syn: aliases)", flag: "synthetic-key" },
];

/** Fallback-chain suggestions, in preference order, keyed by env presence. */
export const CHAIN_SUGGESTIONS: Array<{ env: string; model: string }> = [
  { env: "ANTHROPIC_API_KEY", model: "anthropic/claude-sonnet-4-6" },
  { env: "OPENAI_API_KEY", model: "openai/gpt-5.5" },
  { env: "SYNTHETIC_API_KEY", model: "synthetic/syn:large:vision" },
  { env: "GROQ_API_KEY", model: "groq/llama-4-maverick" },
  { env: "GOOGLE_API_KEY", model: "google/gemini-3.5-flash" },
  { env: "DEEPSEEK_API_KEY", model: "deepseek/deepseek-chat" },
];

export function suggestChain(effective: Record<string, string | undefined>): string {
  return CHAIN_SUGGESTIONS.filter((s) => effective[s.env])
    .map((s) => s.model)
    .slice(0, 3)
    .join(",");
}

export interface SetupFlags {
  /** Non-interactive: take answers from flags and env, ask nothing. */
  yes: boolean;
  /** Emit a machine-readable summary instead of prose. */
  json: boolean;
  /** .env keys to write. */
  set: Record<string, string>;
  /** Harnesses to route: an explicit list, every detected one, or none. */
  enable: HarnessName[] | "all" | "none";
  /** Gateway key: literal value, "generate", or unset. */
  gatewayKey?: string;
  errors: string[];
}

/**
 * Parse `understudy setup` flags. Provider keys take `--anthropic-key V`
 * (or `=V`); anything else in .env takes `--set KEY=VALUE`.
 */
export function parseSetupArgs(args: string[]): SetupFlags {
  const flags: SetupFlags = { yes: false, json: false, set: {}, enable: "none", errors: [] };
  const byFlag = new Map(PROVIDER_KEYS.map((k) => [k.flag, k.env]));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      if (arg === "-y") flags.yes = true;
      else flags.errors.push(`unexpected argument: ${arg}`);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const take = (): string | undefined => {
      if (eq > 0) return arg.slice(eq + 1);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      i++;
      return next;
    };
    const need = (): string | null => {
      const v = take();
      if (v === undefined) flags.errors.push(`--${name} needs a value`);
      return v ?? null;
    };

    if (name === "yes") flags.yes = true;
    else if (name === "json") flags.json = true;
    else if (name === "non-interactive") flags.yes = true;
    else if (byFlag.has(name)) {
      const v = need();
      if (v !== null) flags.set[byFlag.get(name)!] = v;
    } else if (name === "chain") {
      const v = need();
      if (v !== null) flags.set.FALLBACK_CHAIN = v;
    } else if (name === "port") {
      const v = need();
      if (v !== null) {
        if (/^\d+$/.test(v)) flags.set.PORT = v;
        else flags.errors.push(`--port must be a number, got ${v}`);
      }
    } else if (name === "gateway-key") {
      const v = need();
      if (v !== null) flags.gatewayKey = v;
    } else if (name === "set") {
      const v = need();
      if (v !== null) {
        const m = v.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) flags.set[m[1]!] = m[2]!;
        else flags.errors.push(`--set expects KEY=VALUE, got ${v}`);
      }
    } else if (name === "enable") {
      const v = take() ?? "all";
      if (v === "all" || v === "none") flags.enable = v;
      else {
        const names = v.split(",").map((s) => s.trim()).filter(Boolean);
        const bad = names.filter((n) => !HARNESS_NAMES.includes(n as HarnessName));
        if (bad.length) flags.errors.push(`--enable: unknown harness ${bad.join(", ")}`);
        else flags.enable = names as HarnessName[];
      }
    } else {
      flags.errors.push(`unknown flag --${name}`);
    }
  }
  return flags;
}

/** What setup did, for `--json` and for tests. */
export interface SetupReport {
  env_path: string;
  wrote: string[];
  providers: string[];
  fallback_chain: string;
  gateway_key: string;
  base_url: string;
  harnesses: Record<HarnessName, "routed" | "direct" | "not installed">;
  next: string[];
}

function backup(path: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${Date.now()}`);
}

type Ask = (prompt: string) => Promise<string>;

async function confirm(ask: Ask, question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await ask(`${question} [y/N] `)).trim());
}

const HARNESS_LABELS: Record<HarnessName, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  hermes: "Hermes",
};

export interface SetupOptions {
  firstRun?: boolean;
  args?: string[];
  /** Override for tests; defaults to process.cwd()/.env. */
  envPath?: string;
  /** Override for tests; defaults to os.homedir(). */
  home?: string;
  /** Override TTY detection for tests. */
  interactive?: boolean;
}

export async function runSetup(opts: SetupOptions = {}): Promise<SetupReport> {
  const flags = parseSetupArgs(opts.args ?? []);
  if (flags.errors.length) {
    for (const e of flags.errors) console.error(`setup: ${e}`);
    console.error(
      "usage: understudy setup [--yes] [--json] [--<provider>-key V] [--chain a,b] [--gateway-key V|generate] [--port N] [--set KEY=VALUE] [--enable all|none|claude,codex,...]",
    );
    process.exit(2);
  }
  const interactive = opts.interactive ?? (!flags.yes && process.stdin.isTTY === true);
  const home = opts.home ?? homedir();
  const envPath = opts.envPath ?? join(process.cwd(), ".env");
  const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const current = parseEnvText(envText);
  const say = (line = "") => {
    if (!flags.json) console.log(line);
  };

  const updates: Record<string, string> = {};
  let enable: HarnessName[] = [];

  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Read answers off a shared line iterator rather than rl.question(): with
    // piped stdin, lines that arrive while no question is pending would be
    // dropped, and the wizard must be scriptable (`printf 'y\n...' | setup`).
    const lines = rl[Symbol.asyncIterator]();
    const ask: Ask = async (prompt) => {
      process.stdout.write(prompt);
      const { value, done } = await lines.next();
      if (done) process.stdout.write("\n");
      return done ? "" : value;
    };

    say(
      opts.firstRun
        ? "\n🎭 First run - let's get the stage ready before the curtain rises.\n"
        : "\n🎭 understudy setup - let's get the stage ready.\n",
    );

    say("Provider API keys (enter to keep/skip):");
    for (const { env, label } of PROVIDER_KEYS) {
      const status = current[env] || process.env[env] ? "configured" : "not set";
      const answer = await ask(`  ${label} [${status}]: `);
      if (answer.trim()) updates[env] = answer.trim();
    }

    const effective = { ...current, ...updates };
    const suggested = suggestChain({ ...process.env, ...effective });
    say("\nThe fallback chain is tried in order when a model fails.");
    const chain = await ask(
      `  FALLBACK_CHAIN [${effective.FALLBACK_CHAIN || suggested || "none"}]: `,
    );
    const chosenChain = chain.trim() || effective.FALLBACK_CHAIN || suggested;
    if (chosenChain) updates.FALLBACK_CHAIN = chosenChain;

    if (!effective.GATEWAY_API_KEYS) {
      say("\nWithout a gateway key, anyone who can reach the port can use your providers.");
      if (await confirm(ask, "Generate a gateway API key? (recommended off-localhost)")) {
        updates.GATEWAY_API_KEYS = `uk-${cryptoRandom()}`;
        say(`  generated: ${updates.GATEWAY_API_KEYS}`);
      }
    }

    say("\nSubscriptions (ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot) can also serve:");
    say("  understudy login chatgpt | anthropic | copilot");
    say("  (run it again to add a second seat on the same provider - sessions rotate across them)\n");

    say("Detected harnesses can be routed through the gateway automatically");
    say("(config files are backed up first; `understudy disable` undoes it):\n");
    const probe: HarnessContext = { home, baseUrl: "", gatewayKey: "" };
    for (const name of HARNESS_NAMES) {
      if (!HARNESSES[name].detect(probe)) continue;
      if (await confirm(ask, `${HARNESS_LABELS[name]}: route through the gateway?`)) {
        enable.push(name);
      }
    }
    rl.close();
  } else {
    // Non-interactive: flags win, then exported env vars an agent (or a
    // shell profile) already set, then whatever the file has.
    Object.assign(updates, flags.set);
    for (const { env } of PROVIDER_KEYS) {
      if (!updates[env] && !current[env] && process.env[env]) updates[env] = process.env[env]!;
    }
    const effective = { ...current, ...updates };
    const chain =
      updates.FALLBACK_CHAIN ||
      effective.FALLBACK_CHAIN ||
      process.env.FALLBACK_CHAIN ||
      suggestChain(effective);
    if (chain && chain !== current.FALLBACK_CHAIN) updates.FALLBACK_CHAIN = chain;
    if (flags.gatewayKey) {
      updates.GATEWAY_API_KEYS =
        flags.gatewayKey === "generate" ? `uk-${cryptoRandom()}` : flags.gatewayKey;
    }
    const probe: HarnessContext = { home, baseUrl: "", gatewayKey: "" };
    enable =
      flags.enable === "all"
        ? HARNESS_NAMES.filter((n) => HARNESSES[n].detect(probe))
        : flags.enable === "none"
          ? []
          : flags.enable;
  }

  // On first run, make sure the .env exists (seed PORT if nothing else was
  // entered) so the next launch doesn't mistake itself for a first run too.
  const effective = { ...current, ...updates };
  if ((opts.firstRun || !existsSync(envPath)) && !effective.PORT) {
    updates.PORT = String(process.env.PORT || 42986);
  }
  if (Object.keys(updates).length > 0) {
    backup(envPath);
    writeFileSync(envPath, upsertEnvFile(envText, updates));
    say(`\nWrote ${envPath}`);
  }

  const port = Number(effective.PORT || updates.PORT || process.env.PORT || 42986);
  const baseUrl = `http://localhost:${port}`;
  const gatewayKey = updates.GATEWAY_API_KEYS ?? effective.GATEWAY_API_KEYS ?? "";
  const ctx: HarnessContext = { home, baseUrl, gatewayKey };

  for (const name of enable) {
    if (!HARNESSES[name].detect(ctx)) {
      say(`  ${name.padEnd(9)} not installed - skipped`);
      continue;
    }
    say(`  ${HARNESSES[name].enable(ctx)}`);
    if (name === "codex" && gatewayKey) {
      say(`  remember: export UNDERSTUDY_API_KEY=${gatewayKey}`);
    }
  }

  const providers = PROVIDER_KEYS.filter((k) => effective[k.env] || updates[k.env]).map(
    (k) => k.env.replace(/_API_KEY$/, "").toLowerCase(),
  );
  const harnesses = Object.fromEntries(
    HARNESS_NAMES.map((n) => [n, HARNESSES[n].status(ctx)]),
  ) as SetupReport["harnesses"];
  const next: string[] = [];
  if (providers.length === 0) {
    next.push(
      "no provider key is set: pass --<provider>-key, export the env var, or run `understudy login chatgpt|anthropic|copilot`",
    );
  }
  if (!enable.length && Object.values(harnesses).some((s) => s === "direct")) {
    next.push("route harnesses with `understudy enable` (or setup --enable all)");
  }
  if (!interactive) next.push("start the gateway with `understudy start`");

  const report: SetupReport = {
    env_path: envPath,
    wrote: Object.keys(updates),
    providers,
    fallback_chain: effective.FALLBACK_CHAIN ?? updates.FALLBACK_CHAIN ?? "",
    gateway_key: gatewayKey,
    base_url: baseUrl,
    harnesses,
    next,
  };

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (interactive) {
    say("\nRe-run this any time with `understudy setup`. Pause all routing with");
    say("`understudy disable`; resume with `understudy enable`.");
    say(opts.firstRun ? "\nPlaces, everyone - raising the curtain...\n" : "\nRaise the curtain with:  understudy start\n");
  } else {
    say(
      `\nConfigured ${providers.length ? providers.join(", ") : "no providers"}; chain: ${report.fallback_chain || "none"}`,
    );
    for (const n of next) say(`  next: ${n}`);
  }
  return report;
}

function cryptoRandom(): string {
  return [...crypto.getRandomValues(new Uint8Array(18))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
