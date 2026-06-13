/**
 * `understudy setup` - interactive first-run wizard. Collects provider keys
 * into .env, picks a fallback chain, and (per harness, opt-in) routes the
 * installed harnesses through the gateway via the same enable functions
 * that back `understudy enable/disable`. Every file it touches gets a
 * timestamped .bak first.
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

function backup(path: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak-${Date.now()}`);
}

type Ask = (prompt: string) => Promise<string>;

async function confirm(ask: Ask, question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await ask(`${question} [y/N] `)).trim());
}

export async function runSetup(opts: { firstRun?: boolean } = {}): Promise<void> {
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

  console.log(
    opts.firstRun
      ? "\n🎭 First run - let's get the stage ready before the curtain rises.\n"
      : "\n🎭 understudy setup - let's get the stage ready.\n",
  );

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

  // On first run, make sure the .env exists (seed PORT if nothing else was
  // entered) so the next launch doesn't mistake itself for a first run too.
  if (opts.firstRun && !effective.PORT && updates.PORT === undefined) {
    updates.PORT = String(effective.PORT || 42986);
  }
  if (Object.keys(updates).length > 0) {
    backup(envPath);
    writeFileSync(envPath, upsertEnvFile(envText, updates));
    console.log(`\nWrote ${envPath}`);
  }

  const port = Number(effective.PORT || process.env.PORT || 42986);
  const baseUrl = `http://localhost:${port}`;
  const gatewayKey = updates.GATEWAY_API_KEYS ?? effective.GATEWAY_API_KEYS ?? "";

  // --- subscriptions ----------------------------------------------------
  console.log(
    "\nSubscriptions (ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot) can also serve:",
  );
  console.log("  understudy login chatgpt | anthropic | copilot\n");

  // --- harness wiring ---------------------------------------------------
  console.log("Detected harnesses can be routed through the gateway automatically");
  console.log("(config files are backed up first; `understudy disable` undoes it):\n");

  const ctx: HarnessContext = { home, baseUrl, gatewayKey };
  const labels: Record<HarnessName, string> = {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    openclaw: "OpenClaw",
    hermes: "Hermes",
  };
  for (const name of HARNESS_NAMES) {
    if (!HARNESSES[name].detect(ctx)) continue;
    if (await confirm(ask, `${labels[name]}: route through the gateway?`)) {
      console.log(`  ${HARNESSES[name].enable(ctx)}`);
      if (name === "codex" && gatewayKey) {
        console.log(`  remember: export UNDERSTUDY_API_KEY=${gatewayKey}`);
      }
    }
  }

  rl.close();
  console.log(
    "\nRe-run this any time with `understudy setup`. Pause all routing with",
  );
  console.log("`understudy disable`; resume with `understudy enable`.");
  if (opts.firstRun) {
    console.log("\nPlaces, everyone - raising the curtain...\n");
  } else {
    console.log("\nRaise the curtain with:  understudy\n");
  }
}

function cryptoRandom(): string {
  return [...crypto.getRandomValues(new Uint8Array(18))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
