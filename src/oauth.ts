/**
 * OAuth subscription credentials as an auth source. `understudy login`
 * stores tokens in data/auth.json; providers fall back to them when no API
 * key env is set, so a Claude Pro/Max or GitHub Copilot subscription can
 * stand in the failover chain alongside plain API keys.
 *
 * Token refresh is delegated to @earendil-works/pi-ai (loaded lazily — the
 * gateway never imports it unless OAuth credentials actually exist).
 *
 * Caveats worth knowing: Anthropic bills third-party OAuth usage per-token
 * against subscription "extra usage", and OAuth-for-third-party-clients is
 * an area Anthropic has changed before — treat it as best-effort, with API
 * keys as the durable path.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const AUTH_FILE_DEFAULT = "data/auth.json";

function authFilePath(): string {
  return process.env.UNDERSTUDY_AUTH ?? AUTH_FILE_DEFAULT;
}

export interface OAuthCreds {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

/** Understudy provider name → pi-ai OAuth provider id. */
const OAUTH_IDS: Record<string, string> = {
  anthropic: "anthropic",
  copilot: "github-copilot",
  chatgpt: "openai-codex",
};

let cache: { path: string; creds: Record<string, OAuthCreds> } | null = null;

function load(): Record<string, OAuthCreds> {
  const path = authFilePath();
  if (cache?.path === path) return cache.creds;
  let creds: Record<string, OAuthCreds> = {};
  try {
    creds = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // no auth file — OAuth simply isn't configured
  }
  cache = { path, creds };
  return creds;
}

export function saveCredentials(id: string, creds: OAuthCreds): void {
  const path = authFilePath();
  const all = { ...load(), [id]: creds };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(all, null, 2));
  chmodSync(path, 0o600);
  cache = { path, creds: all };
}

export function hasOAuth(providerName: string): boolean {
  const id = OAUTH_IDS[providerName];
  return Boolean(id && load()[id]);
}

/**
 * Resolve a usable bearer key from stored OAuth credentials, refreshing
 * (and persisting) when expired. Returns null when none are stored.
 */
export async function oauthApiKey(providerName: string): Promise<string | null> {
  const id = OAUTH_IDS[providerName];
  if (!id) return null;
  const all = load();
  if (!all[id]) return null;

  const { getOAuthApiKey } = await import("@earendil-works/pi-ai/oauth");
  const result = await getOAuthApiKey(id, all);
  if (!result) return null;
  if (result.newCredentials !== all[id]) {
    saveCredentials(id, result.newCredentials as OAuthCreds);
  }
  return result.apiKey;
}

/** Headers GitHub Copilot's API requires on every request. */
export const COPILOT_HEADERS: Record<string, string> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

/**
 * Copilot's API host is embedded in the short-lived token (proxy-ep=...);
 * fall back to the individual-plan default.
 */
export function copilotBaseUrl(token: string): string {
  const match = token.match(/proxy-ep=([^;]+)/);
  if (match) return `https://${match[1]!.replace(/^proxy\./, "api.")}`;
  return "https://api.individual.githubcopilot.com";
}
