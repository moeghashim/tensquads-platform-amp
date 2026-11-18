# Task 01 spike

Code that proves the main libraries work together. It can be thrown away. The report is `docs/evidence/01-spike/report.md`.

Setup, from this folder:

1. `npm ci`
2. A local Postgres 17 on `127.0.0.1:5433`, user `postgres`, password `spike`, with the table and role of `docs/evidence/01-spike/report.md`, section SP-A7.
3. `npm run a:fake-model` and `npm run a:dev` in two terminals.
4. `./run-all.sh`

SP-B8 needs a clone of `earendil-works/pi` at `/tmp/pi-src/pi`, with its packages built, because pi-durable 1.5.2 has no signals.
