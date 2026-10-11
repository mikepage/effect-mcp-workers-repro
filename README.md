# effect-mcp-workers-repro

Effect 4 on Cloudflare Workers: a long-lived fiber that more than one request
uses hangs. Written up after
[recranet/console](https://github.com/recranet/console) dropped its Effect
`McpServer` for a CLI (October 2026).

## Run

```sh
npm install
npm test
```

Each scenario gets a fresh `wrangler dev` isolate. Locally workerd detects
the hang and answers 500 ("would never generate a response"); in production
the request just sits until the client gives up, logged as `canceled` with
~1 ms CPU.

## Result (effect 4.0.0, wrangler 4.147.0)

Every scenario runs twice: on Effect's default scheduler and on the sync
scheduler, the workaround below (`/sync/...` routes).

```
FAIL [default] fiber: a second request uses the long-lived fiber
       GET /fiber/wait          expected 200  got 200
       GET /fiber/wait          expected 200  got hang
FAIL [default] fiber: first request answers before the fiber has run
       GET /fiber/nowait        expected 200  got 200
       GET /fiber/wait          expected 200  got hang
ok   [default] mcp: first request is tools/list (control)
ok   [default] mcp: first request is a GET (405, never touches the server fiber)
ok   [default] mcp: first tools/list is cancelled by the client
ok   [sync] fiber: a second request uses the long-lived fiber
ok   [sync] fiber: first request answers before the fiber has run
ok   [sync] mcp: first request is tools/list (control)
ok   [sync] mcp: first request is a GET (405, never touches the server fiber)
ok   [sync] mcp: first tools/list is cancelled by the client

A /ping sent while a busy fiber (500k operations) runs on the same isolate:
       [default] /ping answered after 8 ms; the busy request took 429 ms
       [sync] /ping answered after 12 ms; the busy request took 32 ms
```

The minimal `McpServer` here does not hang. The console's did, on the same
Effect version, with more around it: two servers built with `Layer.fresh`,
four protocol revisions, auth middleware and per-request services, ~70
tools. The mechanism below is what the console found and what the `fiber`
scenarios show.

## Mechanism

- A fiber has one dispatcher (`Scheduler.ts`, `MixedSchedulerDispatcher`).
  It queues work behind a single `setImmediate`/`setTimeout(0)` and sets
  `running` until that timer fires.
- On Workers a timer belongs to the request that set it. When that request
  finishes or is cancelled, the timer never fires.
- A long-lived fiber (a queue consumer, `McpServer`'s RPC server, anything
  `forkScoped` in a layer) is driven by whichever request happens to touch
  it. If its pending timer was set by a request that has since ended,
  `running` stays set, no new timer is ever scheduled, and every later
  request that waits on the fiber hangs until the isolate is recycled.

`McpServer.layerHttp` forks its RPC server with `Effect.forkScoped`, so it
has exactly this shape. The console worked around it with a warm-up: one
`tools/list` per endpoint before the isolate's first `/mcp` request, with a
10 s bound on waiting for another request's warm-up.

## Workaround: the sync scheduler

```ts
import { Layer, Scheduler } from "effect"

const SyncSchedulerLive = Layer.succeed(
  Scheduler.Scheduler,
  new Scheduler.MixedScheduler("sync")
)

// The whole app: provided to the layer, so the McpServer fiber and every
// request fiber get it.
const app = HttpRouter.toWebHandler(
  AppLive.pipe(Layer.provideMerge(SyncSchedulerLive))
)

// A single run: Effect.provideService(effect, Scheduler.Scheduler, sync)
```

`MixedScheduler("sync")` runs a fiber's next turn in a microtask instead of
a `setImmediate`/`setTimeout(0)`. A microtask is never left pending in a
request's timer list, so no request takes it along when it ends. With it all
scenarios pass.

What it costs, from the `/ping` measurement:

- A fiber no longer hands the isolate back between its turns: a request that
  arrives while another runs a CPU-heavy fiber waits until that fiber is
  done or does I/O. Above, `/ping` waited for the rest of the busy run.
- The same fiber runs much faster: 32 ms instead of 429 ms for 500k
  operations, since workerd's `setImmediate`/`setTimeout(0)` per yield is
  slow.
- `Effect.sleep`, timeouts and schedules still use real timers, which belong
  to the request that set them. A long-lived fiber that sleeps still dies with
  that request. The workaround fixes the scheduler, not the shape.

Use it as a safety net; a Worker should still keep nothing alive past its
request (below).

## Wrong shape for Workers

A long-lived fiber behind a Worker's fetch handler is bad practice. A Worker
has no lifetime of its own beyond a request: nothing should outlive the
request that started it, and nothing should be driven by whichever request
happens to come along next.

`McpServer` has that shape because Effect built one server for every
transport. It sits on `RpcServer`, which was made for long connections
(stdio, websockets): one loop reads messages, dispatches them and writes
replies for as long as the connection lives. It also owns what happens
between requests: progress notifications, server-to-client requests
(sampling, elicitation), cancellation by request id. `layerHttp` is an
adapter on top: each POST drops its message into the loop's inbox
(`RpcServer.makeProtocolWithHttpEffect`) and waits for the reply to come back
out. The request only waits; the shared loop does the work.

That shape is fine in Node, Bun or a Durable Object, where the loop has
somewhere to live. On a Worker it isn't. A stateless `tools/list` or
`tools/call` could run start to finish in the request's own fiber, with no
inbox and no shared loop, but Effect doesn't offer that mode. So either:

- keep the loop somewhere that outlives requests: a Durable Object, or
- write your own request-scoped handler for the JSON-RPC methods you need,
  running each tool call in the request's fiber.

A warm-up that sends a request first, like the console's, only hides the
problem; it doesn't change the shape.

Removing MCP didn't fix the scheduler. It removed the only fiber that
outlived a request: every `/api` request runs in its own fiber, which starts
and finishes inside that request.

## The same class of bug, without fibers

Both hit the console on the same days and look identical in Observability:
every request on one isolate hangs, `/api/health` and static pages still
answer.

- **A promise one request starts and others await.** A Workers request
  can't settle a promise another request started. jose's
  `createRemoteJWKSet`, kept per isolate, shares one pending key fetch; when
  the request that began it was cancelled, every later request waited
  forever. The console's app start (`makeHandler` plus the MCP warm-up) was
  the same pattern. Fix: keep only settled values per isolate, never a
  pending promise; build the router at module load.
- **Startup CPU.** Workers allow 1 s of CPU for global scope. Each
  module-level `Effect.fn("name")` captures its definition stack with
  `new Error()`, which is expensive in workerd: ~800 of them cost ~200 ms.
  The console sets `Error.stackTraceLimit = 0` while its modules load and
  restores it after. Building `McpServer` and its toolkits on every isolate,
  also those that never served MCP, added to cold-start CPU.

## For the next Effect project with an MCP server

- Don't use `McpServer.layerHttp` in a Worker's fetch handler, and don't put
  any other long-lived fiber there (see Wrong shape for Workers). Put the MCP
  server in a Durable Object, or write a request-scoped handler.
- Or skip MCP: a CLI generated from the `HttpApi` contract
  (`HttpApi.reflect`) gave every endpoint as a command with the web app's
  auth and roles, and nothing extra to run.
- Give MCP its own Worker if it stays, so a stuck isolate can't take the UI
  API with it and the UI doesn't pay its startup.
- Never store a pending promise per isolate. Cache results, not fetches.
- Run `wrangler check startup` in CI and watch startup CPU as the codebase
  grows.
- Add a per-request time limit that answers 503 and logs what it waited on,
  so a hang shows up as an error instead of a silent `canceled`.

## References

recranet/console (private): issues #22, #26, #27; commits `dcfb80f`
(Access keys), `33a82c7` (module-load router, bounded MCP warm-up),
`aa7435c` (startup CPU), `a3a7bba` (MCP replaced by the CLI).
