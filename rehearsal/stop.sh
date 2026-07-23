#!/usr/bin/env bash
# Stop all harness processes.
HARNESS="$(cd "$(dirname "$0")" && pwd)"
RUN="$HARNESS/run"
for name in spotlight understudy gremlin gremlin-openai; do
  if [ -f "$RUN/$name.pid" ]; then
    pid=$(cat "$RUN/$name.pid")
    if kill "$pid" 2>/dev/null; then
      echo "stopped $name ($pid)"
    fi
    rm -f "$RUN/$name.pid"
  fi
done
# Belt and braces: anything still bound to the rehearsal-owned ports.
# (42986, the production default, is deliberately NOT swept.)
for port in 42900 42901 42902 42903; do
  pid=$(lsof -ti tcp:$port 2>/dev/null || true)
  [ -n "$pid" ] && kill $pid 2>/dev/null && echo "freed port $port ($pid)"
done
exit 0
