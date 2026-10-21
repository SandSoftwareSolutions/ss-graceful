# @sandsoftwaresolutions/graceful

[![CI](https://github.com/SandSoftwareSolutions/ss-graceful/actions/workflows/ci.yml/badge.svg)](https://github.com/SandSoftwareSolutions/ss-graceful/actions/workflows/ci.yml)

Stop a Node HTTP server politely. When Docker, systemd or a Raspberry Pi says "stop", requests that are running get time to finish, idle connections are closed, your database is closed properly, and the process ends, with a time limit so it can never hang. No dependencies.

## Install

```bash
npm install @sandsoftwaresolutions/graceful
```

Works with `import` and `require()`, and ships TypeScript types for both.

## Usage

```js
import { createServer } from "node:http";
import { gracefulShutdown } from "@sandsoftwaresolutions/graceful";

const server = createServer(app);
const g = gracefulShutdown({
  server,
  timeoutMs: 10_000,
  hooks: [() => db.close(), () => logger.flush()],
  log: console.log
});

// A readiness endpoint for the load balancer or Docker health check:
//   200 {"status":"ok"} while running, 503 {"status":"shutting-down"} afterwards
app.get("/ready", g.readiness);

server.listen(3000);
```

## What happens on SIGTERM or SIGINT

1. Readiness turns to 503 (`drainMs`, if set, gives a load balancer time to notice; it counts against `timeoutMs` and must be smaller than it).
2. The server stops accepting connections and closes the idle keep-alive ones.
3. Running requests get time to finish. After `timeoutMs` the rest are cut.
4. Your `hooks` run one by one. A hook that fails or hangs is logged and does not stop the others.
5. The process exits with 0, or with 1 if anything had to be forced or failed.

A second *signal* while this is going on exits at once (with code 1). A shutdown you started yourself with `g.shutdown()` does not count as a first signal: a SIGTERM that arrives while it runs waits for it and exits with its code.

## Good to know

- `g.shutdown()` starts the same sequence from code (for example after a fatal error) and resolves with `{ code, forced }`. It does not exit the process itself.
- `g.isShuttingDown()` for your own checks; `g.dispose()` removes the signal listeners (tests).
- `hooks` must be an array of functions and `log` may throw without harm. No timer is left running after the shutdown, so the process can end by itself if you do not call `process.exit`.
- Docker waits 10 seconds by default before it kills a container; keep `timeoutMs` below your `stop_grace_period`.
- Works with `http` and `https` servers, and with frameworks that give you the server (Express: `app.listen` returns it).
