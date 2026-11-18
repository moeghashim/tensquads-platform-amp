// SP-A4 and SP-A5: one alarm serves pi-durable and the work list; a WebSocket gets a message after a wake.
const B = `http://127.0.0.1:8799/do/a4-${Date.now()}`;
const got = [];
const ws = new WebSocket(`${B.replace("http", "ws")}/ws`);
await new Promise((resolve) => ws.addEventListener("open", resolve));
ws.addEventListener("message", (e) => got.push({ data: String(e.data), at: Date.now() }));
const work = await (await fetch(`${B}/work?ms=1500`)).json();
const sleep = await (await fetch(`${B}/sleep?ms=3500`)).json();
const work2 = await (await fetch(`${B}/work?ms=5000`)).json();
await new Promise((r) => setTimeout(r, 7000));
const state = await (await fetch(`${B}/state`)).json();
console.log(JSON.stringify({ work, sleep, work2, wakes: state.wakes, work: state.work, wake: state.wake, sockets: state.sockets, got }, null, 1));
const late = state.wakes.map((w) => w.at - w.due);
const pi = await (await fetch(`${B}/state`)).json();
console.log("work list wake delays (ms):", late.join(", "));
console.log("websocket messages after a wake:", got.length);
ws.close();
