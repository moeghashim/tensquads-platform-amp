#!/usr/bin/env bash
# Runs the task 01 spike tests. Part A needs the test Worker on port 8799 (npm run a:dev),
# the fake model server (npm run a:fake-model) and a local Postgres on port 5433 (see README.md).
set -u
cd "$(dirname "$0")"
export GIT_PAGER=cat
step() { echo; echo "\$ $*"; "$@"; }
A=http://127.0.0.1:8799

echo "== Versions"
node -e 'for (const p of ["cordis","@earendil-works/pi-durable","@earendil-works/pi-ai","pg","postgres"]) console.log(p, require("./node_modules/"+p+"/package.json").version)'
node -v

echo; echo "== SP-A2: type check with TypeScript 7"
step ../node_modules/.bin/tsc --version
step ../node_modules/.bin/tsc -p tsconfig.node.json && echo "node: no errors"
step ../node_modules/.bin/tsc -p tsconfig.worker.json && echo "worker: no errors"

echo; echo "== Part B, in Node: SP-B1, SP-B4 and the hook points"
step node b/basic.ts

echo; echo "== Part B: SP-B2 to SP-B11, journal copies to the test Worker (R2)"
JOURNAL=$A node b/driver.ts 2>&1 | sed -n '/^$/,$p'

echo; echo "== SP-B8: a tool parks on a signal"
echo "\$ node -e '<does pi-durable 1.5.2 export defineSignal?>'"
node -e 'import("@earendil-works/pi-durable").then((m) => console.log("pi-durable 1.5.2 exports defineSignal:", "defineSignal" in m))'
if [ -d /tmp/pi-src/pi/packages/durable ]; then
	echo "\$ (in a clone of earendil-works/pi at $(git -C /tmp/pi-src/pi log -1 --format=%h), main, not released) node park-main.ts"
	cp main-source/park-main.ts /tmp/pi-src/pi/packages/durable/park-main.ts
	(cd /tmp/pi-src/pi/packages/durable && node --conditions=source --experimental-strip-types park-main.ts 2>&1 | grep -v -i experimental)
fi

echo; echo "== Part A, in the Workers runtime (wrangler dev, workerd)"
echo "\$ curl $A/cordis   # SP-A1"; curl -s -m 10 "$A/cordis"; echo
echo "\$ curl $A/model    # SP-A6"; curl -s -m 10 "$A/model"; echo
echo "\$ curl $A/do/x/pg  # SP-A7 from the Durable Object"; curl -s -m 30 "$A/do/x/pg"; echo
echo "\$ curl $A/pg       # SP-A7 from the Worker"; curl -s -m 30 "$A/pg"; echo
S="a3s-$RANDOM"
echo; echo "SP-A3 with replay safe:"; timeout 50 a/restart.sh "$S" safe
echo; echo "SP-A3 with replay unsafe:"; timeout 50 a/restart.sh "a3u-$RANDOM" unsafe | cut -c1-220
echo; echo "SP-A4 and SP-A5:"; node a/alarm-ws.mjs | grep -E '"source"|delays|websocket messages'
echo; echo "SP-A8: reset() on the conversation of the SP-A3 object, which had 5 entries"; echo "\$ curl $A/do/$S/reset"; curl -s -m 10 "$A/do/$S/reset"; echo
