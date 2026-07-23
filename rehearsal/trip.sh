#!/usr/bin/env bash
# The fault lever. Toggle a simulated provider outage on a gremlin.
#   trip.sh on        [anthropic|openai]   # 429 every request until off
#   trip.sh overload  [anthropic|openai]   # 529 instead
#   trip.sh once [N]  [anthropic|openai]   # fault only the next N (default 1)
#   trip.sh off       [anthropic|openai]
#   trip.sh status    [anthropic|openai]
# Target defaults to anthropic.
set -euo pipefail

CMD="${1:-status}"
shift || true
N=1
if [ "$CMD" = "once" ] && [[ "${1:-}" =~ ^[0-9]+$ ]]; then
  N="$1"
  shift
fi
TARGET="${1:-anthropic}"

case "$TARGET" in
  anthropic) CTRL="http://127.0.0.1:42901/__chaos" ;;
  openai)    CTRL="http://127.0.0.1:42902/__chaos" ;;
  *) echo "unknown target: $TARGET (anthropic|openai)" >&2; exit 1 ;;
esac

case "$CMD" in
  on)       curl -s -X POST "$CTRL" -d '{"mode":"on","status":429}' ;;
  overload) curl -s -X POST "$CTRL" -d '{"mode":"on","status":529}' ;;
  once)     curl -s -X POST "$CTRL" -d "{\"mode\":\"count\",\"count\":$N}" ;;
  off)      curl -s -X POST "$CTRL" -d '{"mode":"off"}' ;;
  status)   curl -s "$CTRL" ;;
  *) echo "usage: trip.sh on|overload|off|once [N]|status [anthropic|openai]" >&2; exit 1 ;;
esac
echo
