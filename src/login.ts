/**
 * Interactive OAuth login:  npm run login -- <anthropic|copilot>
 *
 * Stores credentials in data/auth.json (0600). The gateway picks them up
 * automatically whenever the matching provider has no API key env set.
 */

import { createInterface } from "node:readline/promises";
import { saveCredentials, type OAuthCreds } from "./oauth.js";

const PROVIDERS: Record<string, { id: string; label: string }> = {
  anthropic: { id: "anthropic", label: "Anthropic (Claude Pro/Max)" },
  chatgpt: { id: "openai-codex", label: "ChatGPT (Plus/Pro subscription)" },
  copilot: { id: "github-copilot", label: "GitHub Copilot" },
};

async function main(): Promise<void> {
  const name = process.argv[2];
  const target = name ? PROVIDERS[name] : undefined;
  if (!target) {
    console.error(`usage: npm run login -- <${Object.keys(PROVIDERS).join("|")}>`);
    process.exit(1);
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

  saveCredentials(target.id, creds as OAuthCreds);
  rl.close();
  console.log(
    `\nLogged in to ${target.label}. The understudy now has a key to the stage door.`,
  );
  if (target.id === "anthropic") {
    console.log(
      "Note: Anthropic bills third-party OAuth usage per-token against your subscription's extra usage, and may change this behavior — keep an API key configured as the durable path.",
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
