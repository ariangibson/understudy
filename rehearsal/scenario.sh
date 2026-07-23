#!/usr/bin/env bash
# End-to-end failover + recovery drill, parameterized per agent harness:
#   scenario.sh claude|codex|opencode|hermes
#
# Five acts:
#   1. launch the real agent binary headlessly with a task needing ~6
#      round-trips (including a `sleep 8` so the bench can expire mid-run)
#   2. after the first successful primary-provider call, trip a 429
#   3. assert the conversation kept going on synthetic (fallback spans)
#   4. lift the chaos as soon as failover is observed
#   5. assert traffic RETURNED to the primary after the bench expired,
#      the client saw zero error responses, and the task finished (exit 0,
#      exact final output)
set -uo pipefail

HARNESS="$(cd "$(dirname "$0")" && pwd)"
SPANS="$HARNESS/traces/spans.jsonl"
WORKDIR="$HARNESS/run/agent-home"
mkdir -p "$WORKDIR"

AGENT="${1:-}"
PROMPT='Use the shell to run exactly these five commands, ONE PER TOOL CALL, in this order: `echo step-one`, then `echo step-two`, then `echo step-three`, then `sleep 8`, then `echo step-five`. Never combine commands into one call. After all five have run, reply with exactly: CURTAIN CALL'

# Per-agent: span agent name, chaos target (= primary provider), launch fn.
case "$AGENT" in
  claude)
    SPAN_AGENT="claude-code"; TARGET="anthropic"
    launch() {
      ANTHROPIC_BASE_URL=http://127.0.0.1:42900 \
      perl -e 'alarm 300; exec @ARGV' claude -p "$PROMPT" \
        --allowedTools 'Bash(echo:*)' 'Bash(sleep:*)'
    } ;;
  codex)
    SPAN_AGENT="codex"; TARGET="openai"
    launch() {
      perl -e 'alarm 300; exec @ARGV' codex --profile understudy exec \
        --skip-git-repo-check "$PROMPT" </dev/null
    } ;;
  opencode)
    SPAN_AGENT="opencode"; TARGET="openai"
    # Project-scoped provider config — OpenCode picks it up from the workdir,
    # so the user's global OpenCode setup is never touched.
    cat > "$WORKDIR/opencode.jsonc" <<'JSONC'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "understudy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Understudy rehearsal",
      "options": { "baseURL": "http://127.0.0.1:42900/v1", "apiKey": "rehearsal" },
      "models": {
        "gpt-5.5": { "name": "gpt-5.5 (via understudy)", "options": { "reasoningEffort": "none" } }
      }
    }
  }
}
JSONC
    launch() {
      perl -e 'alarm 300; exec @ARGV' opencode run -m understudy/gpt-5.5 "$PROMPT"
    } ;;
  hermes)
    SPAN_AGENT="hermes"; TARGET="openai"
    launch() {
      perl -e 'alarm 300; exec @ARGV' hermes -z "$PROMPT" </dev/null
    } ;;
  *)
    echo "usage: scenario.sh claude|codex|opencode|hermes" >&2; exit 2 ;;
esac

# The guard must prove the whole stack, not just spotlight — /__health fills
# nulls for dead components rather than failing.
curl -sf http://127.0.0.1:42900/__health 2>/dev/null | python3 -c "
import json,sys
h=json.load(sys.stdin)
ok=(h.get('understudy') or {}).get('status')=='ok' and h.get('gremlin') and h.get('gremlin_openai')
sys.exit(0 if ok else 1)" || { echo "stack not (fully) running — ./run.sh first" >&2; exit 1; }
"$HARNESS/trip.sh" off anthropic >/dev/null
"$HARNESS/trip.sh" off openai >/dev/null

BASELINE=$(wc -l < "$SPANS" 2>/dev/null | tr -d ' ' || echo 0)

new_spans() { tail -n +"$((BASELINE + 1))" "$SPANS" 2>/dev/null; }

q() { # q <python filter over span dict s> — counts this run's SPAN_AGENT spans
  new_spans | python3 -c "
import json,sys
n=0
for line in sys.stdin:
    try: s=json.loads(line)
    except: continue
    if s.get('agent')!='$SPAN_AGENT': continue
    if $1: n+=1
print(n)"
}

recovered() { # primary-ok span appearing after the first fallback-ok span
  new_spans | python3 -c "
import json,sys
fell=False; rec=False
for line in sys.stdin:
    try: s=json.loads(line)
    except: continue
    if s.get('agent')!='$SPAN_AGENT' or s.get('status')!=200: continue
    if s.get('fallback'): fell=True
    elif fell and s.get('provider')=='$TARGET': rec=True
print(1 if (fell and rec) else 0)"
}

echo "── [$AGENT] launching through spotlight (real $AGENT binary, primary: $TARGET)"
(
  cd "$WORKDIR"
  launch > "$HARNESS/run/$AGENT-out.txt" 2> "$HARNESS/run/$AGENT-err.txt"
  echo $? > "$HARNESS/run/$AGENT-exit.txt"
) &
AGENT_PID=$!

# Poll a predicate (a command) once a second until it passes, the agent
# exits, or 180s elapse. Returns 0 only if the predicate passed.
await_until() {
  for i in $(seq 1 180); do
    eval "$1" && return 0
    kill -0 $AGENT_PID 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

echo "── act I: waiting for the first successful $TARGET span..."
await_until "[ \"\$(q \"s.get('provider')=='$TARGET' and s.get('status')==200\")\" -ge 1 ]"

echo "── act II: 💥 tripping simulated $TARGET 429"
"$HARNESS/trip.sh" on "$TARGET" >/dev/null

if await_until "[ \"\$(q \"s.get('fallback') and s.get('provider')=='synthetic' and s.get('status')==200\")\" -ge 1 ]"; then
  echo "   🎭 the understudy is on — synthetic is serving the conversation"
fi

echo "── act III: restoring $TARGET; bench expires ~5s later (retry-after)"
"$HARNESS/trip.sh" off "$TARGET" >/dev/null

RECOVERED=0
if await_until "[ \"\$(recovered)\" = 1 ]"; then
  RECOVERED=1
  echo "   🌟 the star is back — $TARGET serving again after cooldown"
fi

echo "── waiting for $AGENT to finish..."
wait $AGENT_PID 2>/dev/null
[ "$(recovered)" = 1 ] && RECOVERED=1
EXIT=$(cat "$HARNESS/run/$AGENT-exit.txt" 2>/dev/null || echo "?")

echo
echo "════════ TIMELINE [$AGENT] ════════"
new_spans | python3 -c "
import json,sys
for line in sys.stdin:
    try: s=json.loads(line)
    except: continue
    if s.get('agent')!='$SPAN_AGENT': continue
    tools=','.join(t['name'] for t in s.get('tool_calls',[])) or '-'
    fb=' 🎭FALLBACK' if s.get('fallback') else ''
    print(f\"{s['ts'][11:23]} {s['status']} {(s.get('provider') or '—')+'/'+(s.get('model_served') or '?'):<42} {s['latency_ms']:>6}ms stop={s.get('stop_reason') or '-':<12} tools=[{tools}]{fb}\")"

echo
echo "════════ RESULTS [$AGENT] ════════"
P_OK=$(q "s.get('provider')=='$TARGET' and s.get('status')==200")
FB=$(q "s.get('fallback') and s.get('status')==200")
ERRS=$(q "s.get('status',0)>=400")
echo "agent exit code:                  $EXIT"
echo "$TARGET spans (ok):               $P_OK"
echo "fallback spans (ok):              $FB"
echo "client-visible error responses:   $ERRS"
echo "recovered to $TARGET:             $([ "$RECOVERED" = 1 ] && echo yes || echo NO)"
echo "final output (tail):"
tail -3 "$HARNESS/run/$AGENT-out.txt" | sed 's/^/  │ /'
echo

PASS=1
[ "$EXIT" = 0 ] || { echo "✗ agent exited non-zero ($EXIT)"; PASS=0; }
[ "$P_OK" -ge 1 ] || { echo "✗ no successful $TARGET span before the trip"; PASS=0; }
[ "$FB" -ge 1 ] || { echo "✗ no successful fallback span — failover did not happen"; PASS=0; }
[ "$RECOVERED" = 1 ] || { echo "✗ traffic never returned to $TARGET after chaos lifted"; PASS=0; }
[ "$ERRS" = 0 ] || { echo "✗ the client saw $ERRS error response(s) — failover was not seamless"; PASS=0; }
grep -q "CURTAIN CALL" "$HARNESS/run/$AGENT-out.txt" || { echo "✗ task did not complete (no CURTAIN CALL in output)"; PASS=0; }

if [ "$PASS" = 1 ]; then
  echo "✅ PASS [$AGENT] — 429 mid-conversation: failover, recovery, zero client-visible errors"
else
  echo "❌ FAIL [$AGENT] — see $HARNESS/run/$AGENT-*.txt and the viewer"
  exit 1
fi
