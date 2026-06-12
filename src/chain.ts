/**
 * The failover loop, shared by every front door: walk the resolved routes,
 * skip benched models, bench retryable failures, and hand back the first
 * success. Dialect-specific concerns (request translation, response shaping,
 * usage recording) stay in the handlers.
 */

import { config, isConfigured } from "./config.js";
import type { CooldownTracker } from "./cooldown.js";
import { routeKey, type Route } from "./router.js";

export interface DispatchError {
  type: "error";
  status: number;
  retryable: boolean;
  body: unknown;
  retryAfterS?: number;
}

export type ChainOutcome<R> =
  | { ok: true; route: Route; primary: Route; started: number; result: R }
  | { ok: false; reason: "no_keys"; neededEnv: string[] }
  | { ok: false; reason: "exhausted"; status: number; body: unknown };

export async function runChain<R extends { type: string }>(
  routes: Route[],
  cooldowns: CooldownTracker,
  dispatch: (route: Route) => Promise<R | DispatchError>,
  onAttemptError?: (route: Route, started: number) => void,
  /** Override which routes count as usable (default: provider has a key). */
  isUsable: (route: Route) => boolean = (r) => isConfigured(r.provider),
): Promise<ChainOutcome<R>> {
  const usable = routes.filter(isUsable);
  if (usable.length === 0) {
    return {
      ok: false,
      reason: "no_keys",
      neededEnv: [...new Set(routes.map((r) => r.provider.apiKeyEnv))],
    };
  }

  // Skip models the circuit breaker has benched — unless that would leave
  // nothing to try, in which case attempting a benched model beats failing.
  const ready = usable.filter((r) => !cooldowns.isBenched(routeKey(r)));
  const attempts = ready.length > 0 ? ready : usable;
  const primary = usable[0]!;

  let lastError: DispatchError | null = null;

  for (let i = 0; i < attempts.length; i++) {
    const route = attempts[i]!;
    const started = Date.now();
    const result = await dispatch(route);

    if (result.type === "error") {
      const err = result as DispatchError;
      lastError = err;
      onAttemptError?.(route, started);
      if (err.retryable) {
        cooldowns.bench(routeKey(route), err.retryAfterS ?? config.cooldownS);
        if (i < attempts.length - 1) {
          console.warn(
            `${routeKey(route)} failed (${err.status}); benched ${err.retryAfterS ?? config.cooldownS}s, failing over`,
          );
          continue;
        }
      }
      return { ok: false, reason: "exhausted", status: err.status, body: err.body };
    }

    return { ok: true, route, primary, started, result: result as R };
  }

  return {
    ok: false,
    reason: "exhausted",
    status: lastError?.status ?? 502,
    body: lastError?.body ?? { error: { message: "All providers failed" } },
  };
}

/** Standard x-understudy-* response headers for a served route. */
export function understudyHeaders(route: Route, primary: Route): Record<string, string> {
  return {
    "x-understudy-provider": route.provider.name,
    "x-understudy-model": route.model,
    ...(routeKey(route) !== routeKey(primary)
      ? { "x-understudy-fallback": `from ${routeKey(primary)}` }
      : {}),
  };
}
