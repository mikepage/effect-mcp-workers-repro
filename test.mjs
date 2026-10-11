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

// The same scenarios on Effect's default scheduler and on the sync
// (microtask) one, the workaround (src/worker.ts).
const scenarios = (variant) => {
  const p = variant === "sync" ? "/sync" : ""
  return [
    {
      name: "fiber: a second request uses the long-lived fiber",
      steps: [[`GET ${p}/fiber/wait`, () => send(`${p}/fiber/wait`)], [`GET ${p}/fiber/wait`, () => send(`${p}/fiber/wait`)]],
      expect: ["200", "200"]
    },
    {
      name: "fiber: first request answers before the fiber has run",
      steps: [[`GET ${p}/fiber/nowait`, () => send(`${p}/fiber/nowait`)], [`GET ${p}/fiber/wait`, () => send(`${p}/fiber/wait`)]],
      expect: ["200", "200"]
    },
    {
      name: "mcp: first request is tools/list (control)",
      steps: [[`POST ${p}/mcp tools/list`, () => send(`${p}/mcp`, toolsList(1))], [`POST ${p}/mcp tools/list`, () => send(`${p}/mcp`, toolsList(2))]],
      expect: ["200", "200"]
    },
    {
      name: "mcp: first request is a GET (405, never touches the server fiber)",
      steps: [[`GET ${p}/mcp`, () => send(`${p}/mcp`)], [`POST ${p}/mcp tools/list`, () => send(`${p}/mcp`, toolsList(1))]],
      expect: ["405", "200"]
    },
    {
      name: "mcp: first tools/list is cancelled by the client",
      steps: [
        [`POST ${p}/mcp tools/list, aborted after 1 ms`, () => send(`${p}/mcp`, toolsList(1), { abortAfterMs: 1 })],
        [`POST ${p}/mcp tools/list`, () => send(`${p}/mcp`, toolsList(2))]
      ],
      expect: ["aborted", "200"]
    }
  ].map((s) => ({ ...s, name: `[${variant}] ${s.name}` }))
}

// What the sync scheduler costs: how long a /ping waits while a busy fiber
// runs on the same isolate. Informational, not a pass or fail.
const fairness = async (variant) => {
  const p = variant === "sync" ? "/sync" : ""
  await send(`${p}/busy`) // warm up the isolate
  const busy = send(`${p}/busy`)
  await new Promise((r) => setTimeout(r, 20))
  const started = Date.now()
  await send("/ping")
  const ping = Date.now() - started
  const busyStarted = started - 20
  await busy
  return { ping, busyTotal: Date.now() - busyStarted }
}

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

let failed = { default: 0, sync: 0 }
for (const variant of ["default", "sync"]) {
  for (const scenario of scenarios(variant)) {
    const child = await startWrangler()
    try {
      const got = []
      for (const [, step] of scenario.steps) got.push(await step())
      const ok = got.every((g, i) => g === scenario.expect[i])
      if (!ok) failed[variant]++
      console.log(`${ok ? "ok  " : "FAIL"} ${scenario.name}`)
      scenario.steps.forEach(([label], i) => console.log(`       ${label.padEnd(47)} expected ${scenario.expect[i].padEnd(8)} got ${got[i]}`))
    } finally {
      process.kill(-child.pid)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

console.log("\nA /ping sent while a busy fiber (500k operations) runs on the same isolate:")
for (const variant of ["default", "sync"]) {
  const child = await startWrangler()
  try {
    const { ping, busyTotal } = await fairness(variant)
    console.log(`       [${variant}] /ping answered after ${ping} ms; the busy request took ${busyTotal} ms`)
  } finally {
    process.kill(-child.pid)
    await new Promise((r) => setTimeout(r, 500))
  }
}

console.log(
  `\nDefault scheduler: ${failed.default ? `${failed.default} scenario(s) reproduce the hang` : "no hang"}.` +
    ` Sync scheduler: ${failed.sync ? `${failed.sync} scenario(s) still hang` : "no hang"}.`
)
// Exits 1 while the bug reproduces on the default scheduler, or when the
// workaround stops working.
process.exit(failed.default || failed.sync ? 1 : 0)
