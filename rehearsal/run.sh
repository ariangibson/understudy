#!/usr/bin/env bash
# Start the full test stack: gremlin (chaos) → understudy → spotlight (traces).
# Idempotent: kills any previous harness processes first.
set -euo pipefail

# CDPATH= so a CDPATH in the user's shell can't make `cd` echo the target
# and poison the captured path; pwd -P for a clean physical dir either way.
HARNESS="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(CDPATH= cd -- "$HARNESS/.." && pwd -P)"
RUN="$HARNESS/run"
mkdir -p "$RUN" "$HARNESS/traces"

# All rehearsal processes live on their own ports — notably the gateway runs
# on 42903, NOT the production default 42986, so a real Understudy instance
# on this machine is never touched.
SPOTLIGHT_PORT=42900
GREMLIN_PORT=42901          # chaos in front of api.anthropic.com
GREMLIN_OPENAI_PORT=42902   # chaos in front of api.openai.com
UNDERSTUDY_PORT=42903

"$HARNESS/stop.sh" 2>/dev/null || true

cd "$REPO"

echo "── starting gremlin (chaos anthropic upstream) on :$GREMLIN_PORT"
GREMLIN_PORT=$GREMLIN_PORT node "$HARNESS/gremlin.mjs" >"$RUN/gremlin.log" 2>&1 &
echo $! > "$RUN/gremlin.pid"

echo "── starting gremlin-openai (chaos openai upstream) on :$GREMLIN_OPENAI_PORT"
GREMLIN_PORT=$GREMLIN_OPENAI_PORT \
GREMLIN_UPSTREAM="https://api.openai.com/v1" \
GREMLIN_FLAVOR=openai \
GREMLIN_FAULT_PATHS="/chat/completions" \
node "$HARNESS/gremlin.mjs" >"$RUN/gremlin-openai.log" 2>&1 &
echo $! > "$RUN/gremlin-openai.pid"

echo "── starting understudy on :$UNDERSTUDY_PORT (anthropic+openai upstreams → gremlins, fallback → synthetic)"
PORT=$UNDERSTUDY_PORT \
UNDERSTUDY_ANTHROPIC_UPSTREAM="http://127.0.0.1:$GREMLIN_PORT" \
UNDERSTUDY_OPENAI_UPSTREAM="http://127.0.0.1:$GREMLIN_OPENAI_PORT" \
FALLBACK_CHAIN="${FALLBACK_CHAIN:-synthetic/syn:large:text}" \
COOLDOWN_S="${COOLDOWN_S:-20}" \
CACHE_TTL_S=0 \
USAGE_LOG="$HARNESS/traces/usage.jsonl" \
npx tsx src/index.ts >"$RUN/understudy.log" 2>&1 &
echo $! > "$RUN/understudy.pid"

echo "── starting spotlight (tracing proxy + viewer) on :$SPOTLIGHT_PORT"
SPOTLIGHT_PORT=$SPOTLIGHT_PORT \
SPOTLIGHT_UPSTREAM="http://127.0.0.1:$UNDERSTUDY_PORT" \
GREMLIN_CONTROL="http://127.0.0.1:$GREMLIN_PORT" \
GREMLIN_OPENAI_CONTROL="http://127.0.0.1:$GREMLIN_OPENAI_PORT" \
npx tsx "$HARNESS/spotlight.ts" >"$RUN/spotlight.log" 2>&1 &
echo $! > "$RUN/spotlight.pid"

echo "── waiting for the stack to come up..."
for i in $(seq 1 30); do
  ok=0
  curl -sf "http://127.0.0.1:$GREMLIN_PORT/__chaos" >/dev/null 2>&1 && ok=$((ok+1))
  curl -sf "http://127.0.0.1:$GREMLIN_OPENAI_PORT/__chaos" >/dev/null 2>&1 && ok=$((ok+1))
  curl -sf "http://127.0.0.1:$UNDERSTUDY_PORT/health" >/dev/null 2>&1 && ok=$((ok+1))
  curl -sf "http://127.0.0.1:$SPOTLIGHT_PORT/__health" >/dev/null 2>&1 && ok=$((ok+1))
  [ "$ok" = 4 ] && break
  sleep 0.5
done
if [ "${ok:-0}" != 4 ]; then
  echo "✗ stack failed to start ($ok/4 up) — check $RUN/*.log" >&2
  exit 1
fi

curl -s "http://127.0.0.1:$UNDERSTUDY_PORT/health" | python3 -m json.tool

cat <<EOF

✅ stack is up

  viewer      http://127.0.0.1:$SPOTLIGHT_PORT/__ui
  trace file  $HARNESS/traces/spans.jsonl
  logs        $RUN/{gremlin,understudy,spotlight}.log

point agents at spotlight:

  Claude Code   ANTHROPIC_BASE_URL=http://127.0.0.1:$SPOTLIGHT_PORT claude
  Codex         codex --profile understudy   (see rehearsal/README.md)
  OpenCode      baseURL http://127.0.0.1:$SPOTLIGHT_PORT/v1
  Hermes        OPENAI_BASE_URL=http://127.0.0.1:$SPOTLIGHT_PORT/v1 in ~/.hermes/.env
  n8n           SPOTLIGHT_HOST=0.0.0.0 rehearsal/run.sh, then http://<host-ip>:$SPOTLIGHT_PORT/v1

run the automated drills:

  $HARNESS/scenario.sh claude|codex|opencode|hermes

or pull the fault lever yourself:

  $HARNESS/trip.sh on [anthropic|openai]      # 429 every request until 'off'
  $HARNESS/trip.sh once 2 openai              # fault only the next 2
  $HARNESS/trip.sh overload anthropic         # 529 instead
  $HARNESS/trip.sh off; $HARNESS/trip.sh status
EOF
