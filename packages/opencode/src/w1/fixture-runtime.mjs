import { createInterface } from "node:readline"

export async function serve() {
  process.stdout.write('@@READY@@{"pid":1}\n')
  const lines = createInterface({ input: process.stdin })
  lines.on("line", (line) => {
    const frame = JSON.parse(line)
    if (frame.type === "approval-response" || frame.type === "question-response") return
    process.stdout.write('@@EVT@@{"t":"say_delta","text":"W1 packaged runtime is alive."}\n')
    process.stdout.write('@@RESULT@@{"status":"model_finished","summary":"W1 packaged runtime is alive.","steps":1}\n')
    process.stdout.write("@@IDLE@@{}\n")
  })
  await new Promise((resolve) => lines.on("close", resolve))
}
