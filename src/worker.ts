import { Deferred, Effect, Layer, Queue, Scheduler, Schema } from "effect"
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai"
import { HttpRouter, HttpServer } from "effect/http"

// The workaround under test: a scheduler that runs a fiber's next turn in a
// microtask instead of a setImmediate/setTimeout(0). A microtask is never
// left pending in a request's timer list, so no request takes it along when
// it ends.
const syncScheduler = new Scheduler.MixedScheduler("sync")
const SyncSchedulerLive = Layer.succeed(Scheduler.Scheduler, syncScheduler)

type Variant = "default" | "sync"

const withVariant = <A, E, R>(variant: Variant) => (effect: Effect.Effect<A, E, R>) =>
  variant === "sync" ? Effect.provideService(effect, Scheduler.Scheduler, syncScheduler) : effect

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

const mcp = {
  default: HttpRouter.toWebHandler(McpLive.pipe(Layer.provide(HttpServer.layerServices))),
  // The whole app on the sync scheduler: provided to the layer, so the
  // server fiber and every request fiber get it.
  sync: HttpRouter.toWebHandler(
    McpLive.pipe(Layer.provide(HttpServer.layerServices), Layer.provideMerge(SyncSchedulerLive))
  )
}

// 2. The same failure without MCP: one long-lived fiber that serves
//    requests from a queue, like McpServer's RPC server fiber.

type Job = Deferred.Deferred<string>

const makeServer = (variant: Variant) => {
  const jobs = Effect.runSync(Queue.unbounded<Job>())
  Effect.runFork(
    Effect.forever(
      Queue.take(jobs).pipe(Effect.flatMap((job) => Deferred.succeed(job, "served")))
    ).pipe(withVariant(variant))
  )
  // Hands a job to the server fiber. With `wait` false the request answers
  // before the fiber has run, so the fiber's next turn is a timer owned by a
  // request that already ended.
  return (wait: boolean) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const job = yield* Deferred.make<string>()
        yield* Queue.offer(jobs, job)
        return wait ? yield* Deferred.await(job) : "queued"
      }).pipe(withVariant(variant))
    )
}

const servers = { default: makeServer("default"), sync: makeServer("sync") }

// 3. The price of the workaround: a busy fiber. Effect yields every 2048
//    operations; on the default scheduler other requests on the isolate run
//    in between, on the sync one they wait until the fiber is done.
const busy = (variant: Variant) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const started = Date.now()
      let sum = 0
      for (let i = 0; i < 500_000; i++) {
        sum += yield* Effect.sync(() => i % 7)
      }
      return `busy ${Date.now() - started} ms (${sum})`
    }).pipe(withVariant(variant))
  )

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    const [, first, ...rest] = pathname.split("/")
    const variant: Variant = first === "sync" ? "sync" : "default"
    const route = "/" + (first === "sync" ? rest : [first, ...rest]).join("/")
    if (route === "/mcp") {
      const url = new URL(request.url)
      url.pathname = "/mcp"
      return mcp[variant].handler(new Request(url, request))
    }
    if (route === "/fiber/wait") return new Response(await servers[variant](true))
    if (route === "/fiber/nowait") return new Response(await servers[variant](false))
    if (route === "/busy") return new Response(await busy(variant))
    if (route === "/ping") return new Response("pong")
    return new Response("Not Found", { status: 404 })
  }
} satisfies ExportedHandler
