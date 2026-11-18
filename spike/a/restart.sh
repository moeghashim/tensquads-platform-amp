#!/usr/bin/env bash
# SP-A3: start a run, kill the Workers runtime (workerd) with SIGKILL during the tool call,
# let wrangler start it again, and read the state. Usage: restart.sh <object name> <safe|unsafe>
set -u
B=http://127.0.0.1:8799/do/$1
curl -s -m 10 "$B/run?mode=$2"; echo
sleep 1.5
echo "during the tool: $(curl -s -m 10 "$B/state" | python3 -c "import json,sys;d=json.load(sys.stdin);print('runs',[r['tool'] for r in d['runs']])")"
for p in $(pgrep -f "workerd serve.*inspector-addr"); do kill -9 "$p"; done
echo "workerd killed with SIGKILL during the tool call"
for _ in $(seq 1 60); do sleep 0.5; curl -s -m 2 -o /dev/null http://127.0.0.1:8799/cordis && break; done
curl -s -m 10 "$B/state" > /dev/null
sleep 7
curl -s -m 10 "$B/state" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('tool runs', [(r['tool'], r['call_id']) for r in d['runs']])
for e in d['entries']: print(' ', e['kind'], e['text'])
"
