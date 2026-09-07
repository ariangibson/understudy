/**
 * Rotation across multiple subscription accounts on one provider.
 *
 * Provider prompt caches are scoped per account, so spreading a session's
 * turns across four seats round-robin would leave every seat's cached
 * prefix stale and re-bill the whole context on each turn. Rotation is
 * therefore per *session*, not per request: a new conversation is dealt to
 * the next account in the ring and sticks to it, so its cache stays warm
 * while the seats still share the load. When a seat 429s, the circuit
 * breaker benches that seat alone; the session moves to the next one and
 * re-sticks there, so its cache warms in one place rather than bouncing.
 */

import { createHash } from "node:crypto";
import { getApiKey } from "./config.js";
import { oauthAccounts } from "./oauth.js";
import type { Route } from "./router.js";

const STICKY_MAX = 4096;

export class AccountRotation {
  /** provider → next ring position for a brand-new session. */
  private next = new Map<string, number>();
  /** `${provider}\n${session}` → account id, insertion-ordered for LRU eviction. */
  private sticky = new Map<string, string>();

  /**
   * Order account ids for a session: the account it is stuck to (or, for a
   * new session, the next seat in the ring) first, then the rest in ring
   * order so failover walks the remaining seats evenly.
   */
  order(provider: string, ids: string[], session: string): string[] {
    if (ids.length === 0) return [];
    const key = `${provider}\n${session}`;
    let preferred = this.sticky.get(key);
    if (preferred === undefined || !ids.includes(preferred)) {
      const n = this.next.get(provider) ?? 0;
      preferred = ids[n % ids.length]!;
      this.next.set(provider, (n + 1) % ids.length);
      this.remember(provider, session, preferred);
    } else {
      // Touch for LRU order.
      this.sticky.delete(key);
      this.sticky.set(key, preferred);
    }
    const at = ids.indexOf(preferred);
    return [...ids.slice(at), ...ids.slice(0, at)];
  }

  /** Pin a session to the account that just served it. */
  remember(provider: string, session: string, id: string): void {
    const key = `${provider}\n${session}`;
    this.sticky.delete(key);
    this.sticky.set(key, id);
    if (this.sticky.size > STICKY_MAX) {
      const oldest = this.sticky.keys().next().value;
      if (oldest !== undefined) this.sticky.delete(oldest);
    }
  }
}

/**
 * Replace each route whose provider is served by two or more stored
 * subscription accounts (and no API key env, which takes precedence) with
 * one route per account, ordered for this session. Single-account and
 * API-key routes pass through untouched, so their keys and headers don't
 * change.
 */
export function expandAccounts(
  routes: Route[],
  session: string,
  rotation: AccountRotation,
): Route[] {
  return routes.flatMap((route) => {
    if (getApiKey(route.provider)) return [route];
    const ids = oauthAccounts(route.provider.name).map((a) => a.id);
    if (ids.length < 2) return [route];
    return rotation
      .order(route.provider.name, ids, session)
      .map((account) => ({ ...route, account }));
  });
}

/**
 * A stable fingerprint for the conversation a request belongs to. Harnesses
 * that label their sessions are believed (Codex's prompt_cache_key, Claude
 * Code's metadata.user_id, the OpenAI `user` field); otherwise the system
 * prompt plus the opening user turn stand in, since both are fixed for the
 * life of a conversation and differ between conversations.
 */
export function sessionKey(explicit: unknown, ...prefix: unknown[]): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const h = createHash("sha256");
  for (const part of prefix) h.update(JSON.stringify(part ?? null)).update("\0");
  return h.digest("hex").slice(0, 16);
}

/** The first user turn of an OpenAI-style message list. */
export function firstUserTurn<T extends { role: string }>(messages: T[]): T | undefined {
  return messages.find((m) => m.role === "user");
}
