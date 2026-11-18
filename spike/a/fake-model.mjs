// A fake OpenAI chat completions server for SP-A6. It answers each request with one streamed text.
import { createServer } from "node:http";
let requests = 0;
createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		requests += 1;
		console.log(`request ${requests}: ${req.method} ${req.url} auth=${req.headers.authorization ? "present" : "none"}`);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta, finish) =>
			`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		res.write(chunk({ role: "assistant", content: "hello from the fake model" }, null));
		res.write(chunk({}, "stop"));
		res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
}).listen(8791, "127.0.0.1");
