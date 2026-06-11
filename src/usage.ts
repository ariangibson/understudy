import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import type { UsageRecord } from "./types.js";

let dirReady: Promise<void> | null = null;

function ensureDir(): Promise<void> {
  dirReady ??= mkdir(dirname(config.usageLogPath), { recursive: true }).then(
    () => undefined,
  );
  return dirReady;
}

/** Append one usage record to the JSONL log. Failures are logged, not thrown. */
export async function recordUsage(record: UsageRecord): Promise<void> {
  try {
    await ensureDir();
    await appendFile(config.usageLogPath, JSON.stringify(record) + "\n");
  } catch (err) {
    console.error("usage log write failed:", err);
  }
}

export interface UsageSummary {
  total_requests: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cost_usd: number;
  cached_requests: number;
  /** Spend avoided by cache hits, at the models' list prices. */
  cache_saved_usd: number;
  by_model: Record<
    string,
    {
      requests: number;
      prompt_tokens: number;
      completion_tokens: number;
      cost_usd: number;
    }
  >;
}

/** Aggregate the JSONL log into a summary, optionally since an ISO timestamp. */
export async function summarizeUsage(since?: string): Promise<UsageSummary> {
  const summary: UsageSummary = {
    total_requests: 0,
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_cost_usd: 0,
    cached_requests: 0,
    cache_saved_usd: 0,
    by_model: {},
  };

  let raw: string;
  try {
    raw = await readFile(config.usageLogPath, "utf8");
  } catch {
    return summary; // no log yet
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: UsageRecord;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (since && rec.ts < since) continue;

    const key = `${rec.provider}/${rec.model}`;
    const entry = (summary.by_model[key] ??= {
      requests: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
    });
    entry.requests += 1;
    entry.prompt_tokens += rec.prompt_tokens;
    entry.completion_tokens += rec.completion_tokens;
    entry.cost_usd += rec.cost_usd ?? 0;

    summary.total_requests += 1;
    summary.total_prompt_tokens += rec.prompt_tokens;
    summary.total_completion_tokens += rec.completion_tokens;
    summary.total_cost_usd += rec.cost_usd ?? 0;
    if (rec.cached) {
      summary.cached_requests += 1;
      summary.cache_saved_usd += rec.saved_usd ?? 0;
    }
  }
  return summary;
}
