# Understudy: runbook for agents

This file is for an AI agent (Claude Code, Codex, OpenCode, Hermes, OpenClaw, or anything similar) that has been asked to install, configure, or fix understudy on someone's machine. Every step is a plain command with a machine-readable form. Nothing below needs a browser except the subscription login, and that step is explicitly a handoff to the person.

Understudy is a local LLM gateway. Agent harnesses point at it instead of at a provider; when the provider rate-limits or fails, the gateway retries on a fallback model, benches the failed one, and streams the reply back in whatever dialect the harness speaks. The person's harness never restarts.

## Install

```bash
curl -fsSL https://understudy.cc/install.sh | bash
```

Non-interactive. Requires Node 20+, curl or wget, tar. Installs to `~/.understudy` (config, data, logs) and `~/.understudy/app` (code), and links `understudy` into `~/.local/bin`. Re-running updates to the latest main. If `understudy` is not on PATH afterwards in your shell, call it as `~/.local/bin/understudy`.

Do not run bare `understudy` from an agent: with no `.env` and a TTY it starts an interactive wizard. Use `setup --yes` below.

## Configure

```bash
understudy setup --yes --json \
  --anthropic-key sk-ant-... \
  --openai-key sk-... \
  --chain anthropic/claude-sonnet-4-6,openai/gpt-5.5 \
  --enable all
```

Flags:

| Flag | Meaning |
|---|---|
| `--yes` | never prompt; also implied when stdin is not a TTY |
| `--json` | print a report instead of prose (shape below) |
| `--anthropic-key`, `--openai-key`, `--google-key`, `--xai-key`, `--groq-key`, `--deepseek-key`, `--mistral-key`, `--synthetic-key` | provider API keys, written to `.env` |
| `--chain a,b,c` | `FALLBACK_CHAIN`: models tried in order when the requested one fails, as `provider/model`. Omitted: a sensible chain is derived from the keys present |
| `--gateway-key VALUE` or `--gateway-key generate` | `GATEWAY_API_KEYS`: clients must present it. Recommended if the port is reachable from other machines; unnecessary for localhost |
| `--port N` | default 42986 |
| `--set KEY=VALUE` | any other `.env` key (`COOLDOWN_S`, `CACHE_TTL_S`, `MODEL_OVERRIDES`, ...) |
| `--enable all` / `--enable claude,codex` / `--enable none` | which installed harnesses to route through the gateway. Default none |

Provider keys already exported in the environment (`ANTHROPIC_API_KEY=... understudy setup --yes`) are picked up without flags. Setup is idempotent: re-running with no flags changes nothing; re-running with a flag updates that key only. Every file it touches gets a timestamped `.bak` first.

`--json` report:

```json
{
  "env_path": "/Users/x/.understudy/.env",
  "wrote": ["ANTHROPIC_API_KEY", "FALLBACK_CHAIN", "PORT"],
  "providers": ["anthropic", "openai"],
  "fallback_chain": "anthropic/claude-sonnet-4-6,openai/gpt-5.5",
  "gateway_key": "",
  "base_url": "http://localhost:42986",
  "harnesses": { "claude": "routed", "codex": "direct", "opencode": "not installed", "openclaw": "not installed", "hermes": "not installed" },
  "next": ["start the gateway with `understudy start`"]
}
```

Act on `next` until it is empty.

## Run it as a service

```bash
understudy start            # install + start; returns once /health answers (exit 1 if not within 15s)
understudy stop             # stop and uninstall the service; harness routing is left as is
understudy restart
understudy logs -n 100      # or: understudy logs -f
```

`start` uses launchd on macOS (`~/Library/LaunchAgents/cc.understudy.gateway.plist`), a systemd user unit on Linux (`~/.config/systemd/user/understudy.service`), and a detached process with a pidfile anywhere else or when `UNDERSTUDY_SERVICE=pidfile` is set (containers, CI). The service survives logout and restarts on crash. Add `--json` to `start` or `stop` for a status object.

`understudy serve` runs in the foreground instead. Do not leave an agent-spawned foreground gateway behind; it dies with your shell and the person's harnesses are then pointed at nothing. If you must run it in the foreground, run `understudy disable` before you exit.

## Verify

```bash
understudy doctor --json
```

Returns `{ "ok": bool, "checks": [ { "id", "level": "ok|warn|fail", "detail", "fix"? } ] }` and exits 1 while any check is `fail`. Each non-ok check carries the exact command that fixes it. Loop: run doctor, run the fix for the first `fail`, run doctor again. `warn` items are judgment calls for the person (no gateway key on localhost, a harness left direct on purpose); mention them, don't force them.

```bash
understudy status --json
```

Returns `{ "gateway": { "up", "base_url", "providers", "cooldowns", "accounts", "uptime_s" }, "service": { "manager", "installed", "running", "pid", "log" }, "harnesses": { "<name>": "routed|direct|not installed" } }`.

`curl http://localhost:42986/health` is the same gateway view without the CLI, unauthenticated.

To prove a request goes through, send one to the first model in the chain and read the `x-understudy-*` response headers (add `-H 'authorization: Bearer <gateway key>'` if one is set):

```bash
curl -s -D - -o /dev/null http://localhost:42986/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-5.5","messages":[{"role":"user","content":"ping"}],"max_tokens":8}' \
  | grep -i x-understudy
```

`x-understudy-provider` and `x-understudy-model` name who served it. During a real outage the same headers show the understudy, and `x-understudy-fallback: from <lead>` names who could not go on. `GET /health` lists benched models under `cooldowns`.

## Route and un-route harnesses

```bash
understudy enable            # every installed harness
understudy enable claude     # one of: claude codex opencode openclaw hermes
understudy disable           # hand every harness back its direct connection
```

Each harness's previous configuration is recorded at enable time and restored exactly on disable. Claude Code is routed by setting `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`; its own login still passes through to Anthropic untouched, so routing it costs nothing until a fallback actually fires. Codex needs `UNDERSTUDY_API_KEY` exported when a gateway key is set; setup prints the line.

If the gateway is down and harnesses are routed, `understudy disable` is the recovery. It works without the gateway.

## Subscription logins (needs the person)

```bash
understudy login chatgpt     # ChatGPT Plus/Pro, drives GPT-5.x on their plan
understudy login anthropic   # Claude Pro/Max
understudy login copilot     # GitHub Copilot
```

These open an OAuth flow: the command prints a URL and waits for the browser callback or a pasted code. An agent cannot complete this. Run the command, relay the URL to the person verbatim, and wait. Do not try to automate the browser. When it returns, the seat is stored in `~/.understudy/data/auth.json` and the provider is usable in `--chain` as `chatgpt/gpt-5.5`, `anthropic/claude-sonnet-4-6`, or `copilot/<model>` without an API key.

Repeating a login for the same provider adds another seat (a second ChatGPT Pro account, say). Sessions are dealt across seats and stick to one, and each seat is benched on its own when it hits a limit. `--reset` forgets a provider's seats first. `status --json` lists seats under `gateway.accounts`.

## Where things are

| Path | What |
|---|---|
| `~/.understudy/.env` | all configuration; `understudy setup` writes it, `serve` reads it |
| `~/.understudy/data/auth.json` | subscription seats (mode 0600; never copy or print it) |
| `~/.understudy/data/usage.jsonl` | one line per request: provider, model, tokens, cost, latency |
| `~/.understudy/logs/understudy.log` | service log |
| `~/.understudy/harnesses.json` | what `enable` replaced, for `disable` to restore |
| `~/.understudy/app` | the code; `install.sh` replaces it on update |

Every subcommand works in the gateway home: `UNDERSTUDY_HOME` if set, else the current directory when it holds a `.env`, else `~/.understudy`. When it hops to `~/.understudy` it says so on stderr. Set `UNDERSTUDY_HOME` explicitly when running more than one gateway or testing in a scratch directory.

Treat `.env` and `auth.json` as secrets. Do not paste their contents into a chat, a commit, or a ticket.

## Ready checklist

Report success only when all of these hold:

1. `understudy doctor --json` returns `"ok": true`.
2. `understudy status --json` shows `service.running: true` and every harness the person asked for as `routed`.
3. The curl above returns an `x-understudy-provider` header.
4. The person has been told the one-line off switch: `understudy disable`.
