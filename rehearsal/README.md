# The dress rehearsal

A chaos drill that proves the headline claim with **real, unmodified agent binaries**:
kill a provider mid-conversation and the agent never notices. Understudy benches the
failed provider, the fallback finishes the tool loop, and traffic returns to the
primary when it recovers - zero errors visible to the client.

Verified against Claude Code (Messages dialect), Codex + OpenClaw (Responses),
and OpenCode + Hermes Agent (chat completions) - all three front doors, live.

## Topology

```
agent (claude / codex / opencode / hermes / n8n / anything)
   │
   ▼
spotlight :42900   tracing proxy - one span per LLM call, viewer at /__ui
   │
   ▼
understudy :42903  the gateway under test (FALLBACK_CHAIN=synthetic/syn:large:text;
   │               its own port, so a production instance on :42986 is never touched)
   │
   ├── /v1/messages passthrough ──▶ gremlin :42901 ──▶ api.anthropic.com
   └── openai adapter ────────────▶ gremlin :42902 ──▶ api.openai.com/v1
```

The gremlins are chaos proxies spliced in via `UNDERSTUDY_ANTHROPIC_UPSTREAM` /
`UNDERSTUDY_OPENAI_UPSTREAM`. Normally they forward verbatim; on command they
return a wire-accurate `429 rate_limit_error` (correct dialect, `retry-after`
header). Understudy sees exactly what a real rate limit looks like - its real
bench/failover/cooldown code runs. Nothing is mocked.

## Quick start

```bash
rehearsal/run.sh              # start gremlins + understudy + spotlight
open http://127.0.0.1:42900/__ui

rehearsal/scenario.sh claude  # automated drill: failover → recovery, asserted
rehearsal/scenario.sh codex   # (see per-agent setup below)
rehearsal/scenario.sh opencode
rehearsal/scenario.sh hermes
rehearsal/scenario.sh openclaw

rehearsal/stop.sh
```

Each scenario launches the real agent with a multi-step shell task, waits for
its first successful primary-provider call, injects the 429, asserts synthetic
picked up the conversation mid-tool-loop, lifts the fault, asserts traffic
returned to the primary after the bench expired, and asserts the client saw
zero error responses and the task completed. A `sleep 8` inside the task gives
the bench (driven by the injected `retry-after: 5`) room to expire mid-run, so
the recovery leg is observable in a single pass.

Manual mode: point any agent at `:42900`, work normally, then pull the lever -
`rehearsal/trip.sh on anthropic` (or the 💥 buttons in the viewer) - and keep
working. `trip.sh overload` sends 529s instead; `trip.sh once 2 openai` faults
exactly the next two requests.

## Per-agent setup

Each agent needs its base URL pointed at spotlight (`:42900`). The scenarios
assume:

| agent | setup |
|---|---|
| **claude** | none - the scenario sets `ANTHROPIC_BASE_URL` itself. Claude Code's own OAuth passes through to Anthropic untouched. |
| **codex** | create `~/.codex/understudy.config.toml` (see below), then `codex --profile understudy` |
| **opencode** | none - the scenario writes a project-scoped `opencode.jsonc` into its sandbox workdir |
| **hermes** | set `OPENAI_BASE_URL=http://127.0.0.1:42900/v1` in `~/.hermes/.env` and `model.default: gpt-5.5` in `~/.hermes/config.yaml` (note: hermes' `.env` overrides its `config.yaml` base_url). Restore after. |
| **openclaw** | none - the scenario configures an isolated `understudy` profile (`~/.openclaw-understudy`), so the real `~/.openclaw` config is never touched. Runs `agent --local --json` with `skipBootstrap` and unattended exec. |
| **n8n** | start with `SPOTLIGHT_HOST=0.0.0.0 rehearsal/run.sh` (spotlight binds loopback by default - spans hold full conversation bodies), then point the LLM credential base URL at `http://<host-ip>:42900/v1`. Add an `x-trace-agent` header for clean attribution. |

`~/.codex/understudy.config.toml`:

```toml
model = "gpt-5.5"
model_provider = "understudy"

[model_providers.understudy]
name = "Understudy rehearsal"
base_url = "http://127.0.0.1:42900/v1"
wire_api = "responses"
```

## Observability

Spotlight records one span per LLM call to `traces/spans.jsonl` (gitignored):

- **routing truth** - requested model vs. the provider/model that actually
  served it, straight from Understudy's `x-understudy-provider/-model/-fallback`
  response headers
- **the agentic loop** - tool calls the model made (name + input), tool results
  the agent sent back, stop reasons, message counts; SSE streams are
  reassembled into readable final messages in all three dialects
- **latency** - total and time-to-first-byte per request
- **cost** - token usage priced by Understudy's own table (`src/pricing.ts`);
  flat-rate models get entries in `prices.local.json` (prefix-matched), unknown
  models show `-`, never a fabricated number
- **non-determinism forensics** - sha256 of the system prompt, tool list, and
  full request body, so two "identical" runs that drift are one `grep` apart

`traces/events.jsonl` logs every injected fault and chaos toggle;
`traces/usage.jsonl` is Understudy's own cost log for the rehearsal run.

The viewer at `/__ui` is a zero-dependency page served by spotlight: live span
table with agent/provider filters, fallback and error highlighting, cooldown
status, chaos toggles, and a detail drawer with the assembled response and the
conversation tail. (If you outgrow it, export spans as OTLP to Jaeger - but the
custom viewer understands tool calls and dialects, which generic tracers don't.)

## Files

| file | role |
|---|---|
| `run.sh` / `stop.sh` | start/stop the four-process stack (logs + pids in `run/`) |
| `gremlin.mjs` | chaos proxy - one binary, both flavors (`GREMLIN_FLAVOR`, `GREMLIN_FAULT_PATHS`) |
| `spotlight.ts` | tracing proxy + viewer server, run via tsx from the repo root |
| `viewer.html` | the span viewer UI |
| `trip.sh` | fault lever: `on\|overload\|off\|once [N]\|status  [anthropic\|openai]` |
| `scenario.sh` | the automated drill: `scenario.sh claude\|codex\|opencode\|hermes\|openclaw` |
| `traces/`, `run/` | runtime output - gitignored |
