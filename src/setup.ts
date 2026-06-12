/**
 * `understudy setup` - interactive first-run wizard. Collects provider keys
 * into .env, picks a fallback chain, and (per harness, opt-in) writes the
 * client config so Claude Code, Codex, OpenCode, and OpenClaw point at the
 * gateway without anyone hand-editing files. Every file it touches gets a
 * timestamped .bak first.
 *
 * The merge helpers are pure (text/object in, text/object out) so they can
 * be unit-tested; only runSetup does I/O.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

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

/** Add the understudy provider block to a Codex config.toml (idempotent). */
export function ensureCodexProvider(
  toml: string,
  baseUrl: string,
  makeDefault: boolean,
): string {
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
  if (makeDefault) {
    out = /^model_provider\s*=/m.test(out)
      ? out.replace(/^model_provider\s*=.*$/m, 'model_provider = "understudy"')
      : `model_provider = "understudy"\n${out}`;
  }
  return out;
}

/** Merge the understudy provider into an OpenCode config object. */
export function mergeOpenCodeConfig(
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

/** Merge the understudy provider into an OpenClaw config object. */
export function mergeOpenClawConfig(
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

/** Point Claude Code at the gateway via the env block in settings.json. */
export function mergeClaudeSettings(
  settings: Record<string, unknown> | null,
  baseUrl: string,
): Record<string, unknown> {
  const out = { ...(settings ?? {}) } as Record<string, unknown>;
  out.env = { ...((out.env as Record<string, unknown>) ?? {}), ANTHROPIC_BASE_URL: baseUrl };
  return out;
}

// ---------------------------------------------------------------------------
// Wizard I/O

const PROVIDER_KEYS: Array<{ env: string; label: string }> = [
  { env: "ANTHROPIC_API_KEY", label: "Anthropic (claude-*)" },
  { env: "OPENAI_API_KEY", label: "OpenAI platform (gpt-*)" },
  { env: "GOOGLE_API_KEY", label: "Google (gemini-*)" },
  { env: "XAI_API_KEY", label: "xAI (grok-*)" },
  { env: "GROQ_API_KEY", label: "Groq (fast open models)" },
  { env: "DEEPSEEK_API_KEY", label: "DeepSeek" },
  { env: "MISTRAL_API_KEY", label: "Mistral" },
  { env: "SYNTHETIC_API_KEY", label: "synthetic.new (syn: aliases)" },
];

/** Fallback-chain suggestions, in preference order, keyed by env presence. */
const CHAIN_SUGGESTIONS: Array<{ env: string; model: string }> = [
  { env: "ANTHROPIC_API_KEY", model: "anthropic/claude-sonnet-4-6" },
  { env: "OPENAI_API_KEY", model: "openai/gpt-5.5" },
  { env: "SYNTHETIC_API_KEY", model: "synthetic/syn:large:vision" },
  { env: "GROQ_API_KEY", model: "groq/llama-4-maverick" },
  { env: "GOOGLE_API_KEY", model: "google/gemini-3.5-flash" },
  { env: "DEEPSEEK_API_KEY", model: "deepseek/deepseek-chat" },
];

function parseEnvText(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2]) vars[m[1]!] = m[2]!;
  }
  return vars;
}

function onPath(cmd: string): boolean {
  return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
}

function backup(path: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${Date.now()}`);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  backup(path);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

type Ask = (prompt: string) => Promise<string>;

async function confirm(ask: Ask, question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await ask(`${question} [y/N] `)).trim());
}

export async function runSetup(): Promise<void> {
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
  const home = homedir();

  console.log("\n🎭 understudy setup - let's get the stage ready.\n");

  // --- provider keys → .env -------------------------------------------
  const envPath = join(process.cwd(), ".env");
  const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const current = parseEnvText(envText);
  const updates: Record<string, string> = {};

  console.log("Provider API keys (enter to keep/skip):");
  for (const { env, label } of PROVIDER_KEYS) {
    const status = current[env] || process.env[env] ? "configured" : "not set";
    const answer = await ask(`  ${label} [${status}]: `);
    if (answer.trim()) updates[env] = answer.trim();
  }

  // --- fallback chain ---------------------------------------------------
  const effective = { ...current, ...updates };
  const suggested = CHAIN_SUGGESTIONS.filter(
    (s) => effective[s.env] || process.env[s.env],
  )
    .map((s) => s.model)
    .slice(0, 3)
    .join(",");
  console.log("\nThe fallback chain is tried in order when a model fails.");
  const chain = await ask(
    `  FALLBACK_CHAIN [${effective.FALLBACK_CHAIN || suggested || "none"}]: `,
  );
  const chosenChain = chain.trim() || effective.FALLBACK_CHAIN || suggested;
  if (chosenChain) updates.FALLBACK_CHAIN = chosenChain;

  // --- gateway key ------------------------------------------------------
  if (!effective.GATEWAY_API_KEYS) {
    console.log("\nWithout a gateway key, anyone who can reach the port can use your providers.");
    if (await confirm(ask, "Generate a gateway API key? (recommended off-localhost)")) {
      updates.GATEWAY_API_KEYS = `uk-${cryptoRandom()}`;
      console.log(`  generated: ${updates.GATEWAY_API_KEYS}`);
    }
  }

  if (Object.keys(updates).length > 0) {
    backup(envPath);
    writeFileSync(envPath, upsertEnvFile(envText, updates));
    console.log(`\nWrote ${envPath}`);
  }

  const port = Number(effective.PORT || process.env.PORT || 3001);
  const baseUrl = `http://localhost:${port}`;
  const gatewayKey = updates.GATEWAY_API_KEYS ?? effective.GATEWAY_API_KEYS ?? "";

  // --- subscriptions ----------------------------------------------------
  console.log(
    "\nSubscriptions (ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot) can also serve:",
  );
  console.log("  understudy login chatgpt | anthropic | copilot\n");

  // --- harness wiring ---------------------------------------------------
  console.log("Detected harnesses can be pointed at the gateway automatically");
  console.log("(existing config files are backed up first):\n");

  if (onPath("claude")) {
    const path = join(home, ".claude", "settings.json");
    if (await confirm(ask, `Claude Code: set ANTHROPIC_BASE_URL=${baseUrl} in ${path}?`)) {
      writeJson(path, mergeClaudeSettings(readJson(path), baseUrl));
      console.log("  done - every claude session now routes through the gateway");
    } else {
      console.log(`  manual: ANTHROPIC_BASE_URL=${baseUrl} claude`);
    }
  }

  if (onPath("codex")) {
    const path = join(process.env.CODEX_HOME ?? join(home, ".codex"), "config.toml");
    if (await confirm(ask, `Codex: add the understudy provider to ${path}?`)) {
      const makeDefault = await confirm(ask, "  ...and make it Codex's default provider?");
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      mkdirSync(dirname(path), { recursive: true });
      backup(path);
      writeFileSync(path, ensureCodexProvider(text, baseUrl, makeDefault));
      if (gatewayKey) console.log(`  remember: export UNDERSTUDY_API_KEY=${gatewayKey}`);
      console.log("  done");
    }
  }

  if (onPath("opencode")) {
    const path = join(home, ".config", "opencode", "opencode.json");
    if (await confirm(ask, `OpenCode: add the understudy provider to ${path}?`)) {
      writeJson(path, mergeOpenCodeConfig(readJson(path), baseUrl, gatewayKey || "none"));
      console.log("  done - pick understudy/<model> inside opencode");
    }
  }

  if (onPath("openclaw")) {
    const path = join(home, ".openclaw", "openclaw.json");
    if (await confirm(ask, `OpenClaw: add the understudy provider to ${path}?`)) {
      writeJson(path, mergeOpenClawConfig(readJson(path), baseUrl, gatewayKey));
      console.log("  done - models appear as understudy/<model>");
    }
  }

  if (onPath("hermes")) {
    if (await confirm(ask, `Hermes: point model.base_url at ${baseUrl}/v1 (via hermes config set)?`)) {
      for (const [k, v] of [
        ["model.base_url", `${baseUrl}/v1`],
        ["model.provider", "custom"],
      ]) {
        spawnSync("hermes", ["config", "set", k!, v!], { stdio: "inherit" });
      }
      console.log("  done");
    }
  }

  rl.close();
  console.log("\nPlaces, everyone. Raise the curtain with:");
  console.log("  understudy   (or: npm run dev from a clone)\n");
}

function cryptoRandom(): string {
  return [...crypto.getRandomValues(new Uint8Array(18))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
