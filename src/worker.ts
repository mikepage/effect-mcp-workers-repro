import { Deferred, Effect, Fiber, Layer, Queue, Schema } from "effect"
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai"
import { HttpRouter, HttpServer } from "effect/http"

// 1. The MCP server, wired like any Effect 4 HTTP app: one McpServer on
//    /mcp, served through HttpRouter.toWebHandler, built at module load.

const Ping = Tool.make("ping", {
  description: "Answers pong.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ pong: Schema.Boolean })
})

const PingToolkit = Toolkit.make(Ping)

const PingToolkitLive = PingToolkit.toLayer({
  ping: () => Effect.succeed({ pong: true })
})

const McpLive = McpServer.toolkit(PingToolkit).pipe(
  Layer.provide(PingToolkitLive),
  Layer.provideMerge(
    McpServer.layerHttp({
      name: "repro",
      version: "0.0.0",
      path: "/mcp",
      protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_06_18]
    })
  )
)

const mcp = HttpRouter.toWebHandler(
  McpLive.pipe(Layer.provide(HttpServer.layerServices))
)

// 2. The same failure without MCP: one long-lived fiber that serves
//    requests from a queue, like McpServer's RPC server fiber.

type Job = Deferred.Deferred<string>
const jobs = Effect.runSync(Queue.unbounded<Job>())
const server: Fiber.Fiber<never> = Effect.runFork(
  Effect.forever(
    Queue.take(jobs).pipe(
      Effect.flatMap((job) => Deferred.succeed(job, "served"))
    )
  )
)
void server

// Hands a job to the server fiber. With `wait` false the request answers
// before the fiber has run, so the fiber's next turn is a timer owned by a
// request that already ended.
const callServer = (wait: boolean) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const job = yield* Deferred.make<string>()
      yield* Queue.offer(jobs, job)
      return wait ? yield* Deferred.await(job) : "queued"
    })
  )

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === "/mcp") return mcp.handler(request)
    if (pathname === "/fiber/wait") return new Response(await callServer(true))
    if (pathname === "/fiber/nowait") return new Response(await callServer(false))
    return new Response("Not Found", { status: 404 })
  }
} satisfies ExportedHandler
