import { createServer } from "node:http";

const port = Number(process.env.MOCK_AI_PORT || 4300);

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Not found" } }));
    return;
  }
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      id: "mock-chat-completion",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model || "mock-model",
      choices: [{ index: 0, message: { role: "assistant", content: "MOCK_OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    }));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock AI provider ready at http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
