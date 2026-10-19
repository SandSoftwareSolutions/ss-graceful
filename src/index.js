// A timer that can be cancelled, so none is left running (and keeping the process alive) after the work is done.
function timer(ms, value) {
  let id;
  const promise = new Promise((resolve) => {
    id = setTimeout(resolve, ms, value);
  });
  return { promise, cancel: () => clearTimeout(id) };
}

/**
 * Shuts a Node HTTP server down politely, for Docker, systemd and a Raspberry Pi that is switched off.
 *
 * On SIGTERM or SIGINT: readiness turns to "shutting down" (so a load balancer stops sending traffic), the server stops
 * accepting connections, idle keep-alive connections are closed, running requests get time to finish, then your hooks run
 * (close the database, flush logs), and the process exits. A second signal exits at once.
 *
 * Options: `server` (http.Server or https.Server), `hooks` (array of functions, run one by one), `timeoutMs` (budget for the
 * drain, the requests and the hooks together, default 10000), `drainMs` (wait this long after readiness turns to "shutting
 * down", default 0; must be less than `timeoutMs`), `signals`, `log(message)` (an error thrown by it is ignored), and for tests
 * `proc` and `exit`. Only signals count as "again": a shutdown started with `shutdown()` is not interrupted by the first signal.
 */
export function gracefulShutdown({
  server,
  hooks = [],
  timeoutMs = 10_000,
  drainMs = 0,
  signals = ["SIGTERM", "SIGINT"],
  log = () => {},
  proc = process,
  exit = (code) => process.exit(code)
} = {}) {
  if (!server || typeof server.close !== "function") throw new TypeError("gracefulShutdown: pass the server");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("gracefulShutdown: timeoutMs must be a positive number");
  if (!Number.isFinite(drainMs) || drainMs < 0) throw new RangeError("gracefulShutdown: drainMs cannot be negative");
  if (drainMs >= timeoutMs) throw new RangeError("gracefulShutdown: drainMs must be less than timeoutMs, or nothing is left for the requests and hooks");
  if (!Array.isArray(hooks) || hooks.some((hook) => typeof hook !== "function")) throw new TypeError("gracefulShutdown: hooks must be an array of functions");
  if (!Array.isArray(signals)) throw new TypeError("gracefulShutdown: signals must be an array of signal names");
  const say = (message) => {
    try {
      log(message);
    } catch {
      // A failing logger must not stop the shutdown.
    }
  };

  let running = null;
  let stopping = false;

  async function run(reason) {
    stopping = true;
    say(`shutting down (${reason})`);
    const started = Date.now();
    const left = () => Math.max(0, timeoutMs - (Date.now() - started));
    let code = 0;
    let forced = false;

    if (drainMs > 0) {
      const drain = timer(drainMs);
      await drain.promise;
    }

    const closed = new Promise((resolve) => server.close(() => resolve(true)));
    // A request that finishes while we wait leaves an idle keep-alive connection behind, which would hold the close up
    // until the time limit. So keep sweeping idle connections until the server is closed.
    const sweep = setInterval(() => server.closeIdleConnections?.(), 25);
    server.closeIdleConnections?.();
    const limit = timer(left(), false);
    const finished = await Promise.race([closed, limit.promise]);
    limit.cancel();
    clearInterval(sweep);
    if (!finished) {
      forced = true;
      code = 1;
      say("requests did not finish in time; closing their connections");
      server.closeAllConnections?.();
    }

    for (const hook of hooks) {
      try {
        const limit = timer(Math.max(left(), 1), false);
        const done = await Promise.race([Promise.resolve().then(hook).then(() => true), limit.promise]).finally(limit.cancel);
        if (!done) {
          forced = true;
          code = 1;
          say("a shutdown hook did not finish in time");
        }
      } catch (error) {
        code = 1;
        say(`a shutdown hook failed: ${error?.message ?? error}`);
      }
    }
    say(forced ? "stopped, but not everything finished cleanly" : "stopped cleanly");
    return { code, forced };
  }

  const shutdown = (reason = "requested") => (running ??= run(reason));

  let signalsSeen = 0;
  const listeners = signals.map((signal) => {
    const listener = () => {
      if (++signalsSeen > 1) {
        say(`${signal} again: exiting now`);
        exit(1);
        return;
      }
      shutdown(signal).then((result) => exit(result.code), () => exit(1));
    };
    proc.on(signal, listener);
    return [signal, listener];
  });

  return {
    /** Starts the shutdown (once) and resolves with `{ code, forced }`. Does not exit the process. */
    shutdown,
    isShuttingDown: () => stopping,
    /** A request handler for a readiness endpoint: 200 while running, 503 once shutting down. */
    readiness(_req, res) {
      const body = JSON.stringify({ status: stopping ? "shutting-down" : "ok" });
      res.writeHead(stopping ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
    },
    /** Removes the signal listeners again (useful in tests). */
    dispose() {
      for (const [signal, listener] of listeners) proc.off(signal, listener);
    }
  };
}
