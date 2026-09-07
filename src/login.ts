/**
 * Interactive OAuth login:  understudy login <anthropic|chatgpt|copilot> [--reset]
 *
 * Stores credentials in data/auth.json (0600). The gateway picks them up
 * automatically whenever the matching provider has no API key env set.
 *
 * Running login again for the same provider adds another seat rather than
 * replacing the first: several subscriptions on one provider rotate per
 * session and bench one at a time (see accounts.ts). `--reset` forgets the
 * provider's existing seats before logging in.
 */

import { createInterface } from "node:readline/promises";
import { clearCredentials, oauthAccounts, saveCredentials, type OAuthCreds } from "./oauth.js";

const PROVIDERS: Record<string, { id: string; label: string }> = {
  anthropic: { id: "anthropic", label: "Anthropic (Claude Pro/Max)" },
  chatgpt: { id: "openai-codex", label: "ChatGPT (Plus/Pro subscription)" },
  copilot: { id: "github-copilot", label: "GitHub Copilot" },
};

export async function runLogin(name: string | undefined, flags: string[] = []): Promise<void> {
  const target = name ? PROVIDERS[name] : undefined;
  if (!target) {
    console.error(`usage: understudy login <${Object.keys(PROVIDERS).join("|")}> [--reset]`);
    process.exit(1);
  }
  if (flags.includes("--reset")) {
    clearCredentials(target.id);
    console.log(`Forgot every stored ${target.label} seat.`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const callbacks = {
    onAuth: (info: { url: string; instructions?: string }) => {
      console.log(`\nOpen this URL to authorize ${target.label}:\n\n  ${info.url}\n`);
      if (info.instructions) console.log(info.instructions);
    },
    onDeviceCode: (info: { userCode: string; verificationUri: string }) => {
      console.log(`\nVisit ${info.verificationUri} and enter code: ${info.userCode}\n`);
    },
    onPrompt: (prompt: { message: string }) => rl.question(`${prompt.message}: `),
    onProgress: (message: string) => console.log(message),
    onManualCodeInput: () => rl.question("Paste the authorization code: "),
  };

  const oauth = await import("@earendil-works/pi-ai/oauth");
  const creds =
    target.id === "anthropic"
      ? await oauth.loginAnthropic(callbacks)
      : target.id === "openai-codex"
        ? await oauth.loginOpenAICodex(callbacks)
        : await oauth.loginGitHubCopilot(callbacks);

  const account = saveCredentials(target.id, creds as OAuthCreds);
  rl.close();
  const seats = oauthAccounts(name!);
  console.log(
    `\nLogged in to ${target.label} as ${account.id}. The understudy now has a key to the stage door.`,
  );
  if (seats.length > 1) {
    console.log(
      `${seats.length} ${target.label} seats on file (${seats.map((a) => a.id).join(", ")}); sessions rotate across them and each benches on its own. Run login again to add another, or with --reset to start over.`,
    );
  }
  if (target.id === "anthropic") {
    console.log(
      "Note: Anthropic bills third-party OAuth usage per-token against your subscription's extra usage, and may change this behavior — keep an API key configured as the durable path.",
    );
  }
}

