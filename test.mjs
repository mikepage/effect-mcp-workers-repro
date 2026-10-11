// Runs each scenario on a fresh `wrangler dev` (a fresh isolate) and reports
// which requests answer and which hang. Exits 1 while the bug reproduces.
import { spawn } from "node:child_process"

const PORT = 8790
const BASE = `http://127.0.0.1:${PORT}`
const HANG_MS = 5000

const toolsList = (id) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "tools/list"
  },
  // 2026-07-28 is the stateless revision: no initialize, no session.
  body: JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "repro", version: "0.0.0" }
      }
    }
  })
})

// Sends a request; "hang" if nothing answers within HANG_MS.
const send = async (path, init = {}, { abortAfterMs } = {}) => {
  const controller = new AbortController()
  const limit = abortAfterMs ?? HANG_MS
  const timer = setTimeout(() => controller.abort(), limit)
  try {
    const res = await fetch(BASE + path, { ...init, signal: controller.signal })
    const text = await res.text()
    // workerd's own hang detection answers 500 locally; in production the
    // request just sits until the client gives up ("canceled").
    if (res.status === 500 && text.includes("hung")) return "hang"
    return String(res.status)
  } catch {
    return abortAfterMs === undefined ? "hang" : "aborted"
  } finally {
    clearTimeout(timer)
  }
}

const SCENARIOS = [
  {
    name: "fiber: a second request uses the long-lived fiber",
    steps: [["GET /fiber/wait", () => send("/fiber/wait")], ["GET /fiber/wait", () => send("/fiber/wait")]],
    expect: ["200", "200"]
  },
  {
    name: "fiber: first request answers before the fiber has run",
    steps: [["GET /fiber/nowait", () => send("/fiber/nowait")], ["GET /fiber/wait", () => send("/fiber/wait")]],
    expect: ["200", "200"]
  },
  {
    name: "mcp: first request is tools/list (control)",
    steps: [["POST /mcp tools/list", () => send("/mcp", toolsList(1))], ["POST /mcp tools/list", () => send("/mcp", toolsList(2))]],
    expect: ["200", "200"]
  },
  {
    name: "mcp: first request is a GET (405, never touches the server fiber)",
    steps: [["GET /mcp", () => send("/mcp")], ["POST /mcp tools/list", () => send("/mcp", toolsList(1))]],
    expect: ["405", "200"]
  },
  {
    name: "mcp: first tools/list is cancelled by the client",
    steps: [
      ["POST /mcp tools/list, aborted after 1 ms", () => send("/mcp", toolsList(1), { abortAfterMs: 1 })],
      ["POST /mcp tools/list", () => send("/mcp", toolsList(2))]
    ],
    expect: ["aborted", "200"]
  }
]

const startWrangler = async () => {
  const child = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  })
  let log = ""
  child.stdout.on("data", (c) => (log += c))
  child.stderr.on("data", (c) => (log += c))
  for (let i = 0; i < 300; i++) {
    if (log.includes("Ready on")) return child
    await new Promise((r) => setTimeout(r, 100))
  }
  process.kill(-child.pid)
  throw new Error(`wrangler dev did not start:\n${log}`)
}

let failed = 0
for (const scenario of SCENARIOS) {
  const child = await startWrangler()
  try {
    const got = []
    for (const [, step] of scenario.steps) got.push(await step())
    const ok = got.every((g, i) => g === scenario.expect[i])
    if (!ok) failed++
    console.log(`${ok ? "ok  " : "FAIL"} ${scenario.name}`)
    scenario.steps.forEach(([label], i) => console.log(`       ${label.padEnd(42)} expected ${scenario.expect[i].padEnd(8)} got ${got[i]}`))
  } finally {
    process.kill(-child.pid)
    await new Promise((r) => setTimeout(r, 500))
  }
}

console.log(failed ? `\n${failed} scenario(s) reproduce the hang.` : "\nNo hang reproduced.")
process.exit(failed ? 1 : 0)
