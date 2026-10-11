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

```
FAIL fiber: a second request uses the long-lived fiber
       GET /fiber/wait     expected 200  got 200
       GET /fiber/wait     expected 200  got hang
FAIL fiber: first request answers before the fiber has run
       GET /fiber/nowait   expected 200  got 200
       GET /fiber/wait     expected 200  got hang
ok   mcp: first request is tools/list (control)
ok   mcp: first request is a GET (405, never touches the server fiber)
ok   mcp: first tools/list is cancelled by the client
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

- Don't put a long-lived fiber behind a Worker's fetch handler. Put the MCP
  server in a Durable Object, or keep every tool call inside the request's
  own fiber.
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
