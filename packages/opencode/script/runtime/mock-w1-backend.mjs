import { createServer } from "node:http"

const port = Number(process.env.W1_MOCK_BACKEND_PORT || "43171")
const server = createServer(async (request, response) => {
  if (request.url === "/usage") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ weekUsed: 0, weeklyBudget: 100 }))
    return
  }
  if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
    response.writeHead(404)
    response.end()
    return
  }
  for await (const _chunk of request) {
    // Drain the complete actor request before responding.
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  response.write(`data: ${JSON.stringify({
    id: "w1-npm-depot-actor",
    choices: [{ delta: { content: "Packaged actor turn passed." }, finish_reason: null }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    id: "w1-npm-depot-actor",
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  })}\n\n`)
  response.end("data: [DONE]\n\n")
})

server.listen(port, "127.0.0.1", () => process.stdout.write(`ready:${port}\n`))
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)))
}
