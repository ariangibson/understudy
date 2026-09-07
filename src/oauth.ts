/**
 * OAuth subscription credentials as an auth source. `understudy login`
 * stores tokens in data/auth.json; providers fall back to them when no API
 * key env is set, so a Claude Pro/Max or GitHub Copilot subscription can
 * stand in the failover chain alongside plain API keys.
 *
 * A provider may hold several accounts (four ChatGPT Pro seats, say). Each
 * gets a stable id, the router spreads sessions across them, and the circuit
 * breaker benches them one at a time - see accounts.ts.
 *
 * Token refresh is delegated to @earendil-works/pi-ai (loaded lazily — the
 * gateway never imports it unless OAuth credentials actually exist).
 *
 * Caveats worth knowing: Anthropic bills third-party OAuth usage per-token
 * against subscription "extra usage", and OAuth-for-third-party-clients is
 * an area Anthropic has changed before — treat it as best-effort, with API
 * keys as the durable path.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const AUTH_FILE_DEFAULT = "data/auth.json";

function authFilePath(): string {
  return process.env.UNDERSTUDY_AUTH ?? AUTH_FILE_DEFAULT;
}

export interface OAuthCreds {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

/** A stored credential set with the stable id the gateway rotates on. */
export interface OAuthAccount extends OAuthCreds {
  id: string;
}

/** Understudy provider name → pi-ai OAuth provider id. */
const OAUTH_IDS: Record<string, string> = {
  anthropic: "anthropic",
  copilot: "github-copilot",
  chatgpt: "openai-codex",
};

/**
 * On disk each pi-ai provider id maps to one credential set (the original
 * format) or a list of them. Both are read; the list form is always written.
 */
type AuthFile = Record<string, OAuthCreds | OAuthCreds[]>;

let cache: { path: string; accounts: Record<string, OAuthAccount[]> } | null = null;

/**
 * A stable, human-scannable id for a credential set. ChatGPT tokens are
 * JWTs whose claims name the account; the other providers' tokens are
 * opaque, so the id is a short hash of the refresh token taken at login
 * (refresh tokens rotate later, so the id is persisted rather than recomputed).
 */
export function deriveAccountId(providerId: string, creds: OAuthCreds): string {
  if (providerId === "openai-codex") {
    const claims = jwtClaims(creds.access);
    const auth = claims?.["https://api.openai.com/auth"] as
      | { chatgpt_account_id?: string }
      | undefined;
    const profile = claims?.["https://api.openai.com/profile"] as
      | { email?: string }
      | undefined;
    if (profile?.email) return profile.email;
    if (auth?.chatgpt_account_id) return auth.chatgpt_account_id;
  }
  return createHash("sha256").update(creds.refresh).digest("hex").slice(0, 8);
}

function jwtClaims(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalize(providerId: string, raw: OAuthCreds | OAuthCreds[]): OAuthAccount[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((c) => c && typeof c === "object" && typeof c.access === "string")
    .map((c) => ({ ...c, id: typeof c.id === "string" ? c.id : deriveAccountId(providerId, c) }));
}

function load(): Record<string, OAuthAccount[]> {
  const path = authFilePath();
  if (cache?.path === path) return cache.accounts;
  let file: AuthFile = {};
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as AuthFile;
  } catch {
    // no auth file — OAuth simply isn't configured
  }
  const accounts: Record<string, OAuthAccount[]> = {};
  for (const [id, raw] of Object.entries(file)) {
    const list = normalize(id, raw);
    if (list.length) accounts[id] = list;
  }
  cache = { path, accounts };
  return accounts;
}

function persist(accounts: Record<string, OAuthAccount[]>): void {
  const path = authFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(accounts, null, 2));
  chmodSync(path, 0o600);
  cache = { path, accounts };
}

/**
 * Add (or refresh in place) one account for a pi-ai provider id. An account
 * with the same id is replaced rather than duplicated, so re-running login
 * for a seat you already hold doesn't double its weight in the rotation.
 */
export function saveCredentials(id: string, creds: OAuthCreds): OAuthAccount {
  const account: OAuthAccount = {
    ...creds,
    id: typeof creds.id === "string" ? creds.id : deriveAccountId(id, creds),
  };
  const all = { ...load() };
  const list = all[id] ?? [];
  const at = list.findIndex((a) => a.id === account.id);
  all[id] = at >= 0 ? list.map((a, i) => (i === at ? account : a)) : [...list, account];
  persist(all);
  return account;
}

/** Drop every stored account for a pi-ai provider id. */
export function clearCredentials(id: string): void {
  const all = { ...load() };
  delete all[id];
  persist(all);
}

export function hasOAuth(providerName: string): boolean {
  return oauthAccounts(providerName).length > 0;
}

/** Stored accounts for an understudy provider name, in login order. */
export function oauthAccounts(providerName: string): OAuthAccount[] {
  const id = OAUTH_IDS[providerName];
  return id ? (load()[id] ?? []) : [];
}

/** Account ids per provider that has any stored login (for /health and status). */
export function oauthAccountSummary(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of Object.keys(OAUTH_IDS)) {
    const ids = oauthAccounts(name).map((a) => a.id);
    if (ids.length) out[name] = ids;
  }
  return out;
}

/**
 * Resolve a usable bearer key from stored OAuth credentials, refreshing
 * (and persisting) when expired. With no account id, the first stored
 * account is used. Returns null when none are stored.
 */
export async function oauthApiKey(
  providerName: string,
  accountId?: string,
): Promise<string | null> {
  const id = OAUTH_IDS[providerName];
  if (!id) return null;
  const accounts = load()[id] ?? [];
  const account = accountId ? accounts.find((a) => a.id === accountId) : accounts[0];
  if (!account) return null;

  const { getOAuthApiKey } = await import("@earendil-works/pi-ai/oauth");
  const result = await getOAuthApiKey(id, { [id]: account });
  if (!result) return null;
  if (result.newCredentials !== account) {
    saveCredentials(id, { ...(result.newCredentials as OAuthCreds), id: account.id });
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
