import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, request } from "node:http";
import { test } from "node:test";

import { gracefulShutdown } from "./src/index.js";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const get = (port, path = "/", agent) =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, agent }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end();
  });

test("a running request finishes, new ones are refused, hooks run in order", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const server = createServer(async (req, res) => {
    if (req.url === "/slow") await gate;
    res.end("done");
  });
  const port = await listen(server);
  const order = [];
  const g = gracefulShutdown({ server, proc: new EventEmitter(), hooks: [() => order.push("a"), async () => order.push("b")], timeoutMs: 3000 });
  const slow = get(port, "/slow");
  await new Promise((r) => setTimeout(r, 50));
  const stopped = g.shutdown("test");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(g.isShuttingDown(), true);
  await assert.rejects(get(port, "/new"));
  release();
  assert.equal((await slow).text, "done");
  assert.deepEqual(await stopped, { code: 0, forced: false });
  assert.deepEqual(order, ["a", "b"]);
});

test("a request that never finishes is cut after the time limit", async () => {
  const server = createServer(() => {});
  const port = await listen(server);
  const g = gracefulShutdown({ server, proc: new EventEmitter(), timeoutMs: 200 });
  const stuck = get(port, "/").catch((e) => e);
  await new Promise((r) => setTimeout(r, 50));
  const result = await g.shutdown();
  assert.deepEqual(result, { code: 1, forced: true });
  assert.ok((await stuck) instanceof Error);
});

test("idle keep-alive connections do not hold the shutdown up", async () => {
  const server = createServer((_req, res) => res.end("ok"));
  const port = await listen(server);
  const { Agent } = await import("node:http");
  const agent = new Agent({ keepAlive: true });
  await get(port, "/", agent);
  const g = gracefulShutdown({ server, proc: new EventEmitter(), timeoutMs: 5000 });
  const started = Date.now();
  assert.deepEqual(await g.shutdown(), { code: 0, forced: false });
  assert.ok(Date.now() - started < 1000);
  agent.destroy();
});

test("a failing or hanging hook gives exit code 1 but the others still run", async () => {
  const server = createServer();
  await listen(server);
  const ran = [];
  const logs = [];
  const g = gracefulShutdown({
    server, proc: new EventEmitter(), timeoutMs: 300, log: (m) => logs.push(m),
    hooks: [() => { throw new Error("db busy"); }, () => ran.push("second"), () => new Promise(() => {})]
  });
  const result = await g.shutdown();
  assert.equal(result.code, 1);
  assert.deepEqual(ran, ["second"]);
  assert.ok(logs.some((l) => l.includes("db busy")));
  assert.ok(logs.some((l) => l.includes("did not finish")));
});

test("readiness answers 200 and then 503", async () => {
  const server = createServer();
  const g = gracefulShutdown({ server, proc: new EventEmitter(), drainMs: 0 });
  const probe = createServer((req, res) => g.readiness(req, res));
  const port = await listen(probe);
  assert.deepEqual(JSON.parse((await get(port)).text), { status: "ok" });
  await listen(server);
  await g.shutdown();
  const after = await get(port);
  assert.equal(after.status, 503);
  assert.deepEqual(JSON.parse(after.text), { status: "shutting-down" });
  probe.close();
});

test("signals start the shutdown and exit with its code; a second signal exits at once", async () => {
  const server = createServer();
  await listen(server);
  const proc = new EventEmitter();
  const exits = [];
  const g = gracefulShutdown({ server, proc, exit: (c) => exits.push(c), hooks: [() => new Promise((r) => setTimeout(r, 100))] });
  proc.emit("SIGTERM");
  proc.emit("SIGINT");
  assert.deepEqual(exits, [1]);
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(exits, [1, 0]);
  g.dispose();
  assert.equal(proc.listenerCount("SIGTERM"), 0);
});

test("shutdown is only run once and bad options are rejected", async () => {
  const server = createServer();
  await listen(server);
  let n = 0;
  const g = gracefulShutdown({ server, proc: new EventEmitter(), hooks: [() => n++] });
  await Promise.all([g.shutdown(), g.shutdown()]);
  assert.equal(n, 1);
  assert.throws(() => gracefulShutdown({}), TypeError);
  assert.throws(() => gracefulShutdown({ server, timeoutMs: 0 }), RangeError);
  assert.throws(() => gracefulShutdown({ server, drainMs: -1 }), RangeError);
});

// ---- review additions ----

test("after shutdown() has resolved no timer is left that keeps the process alive", async () => {
  const server = createServer((req, res) => res.end("ok"));
  await listen(server);
  const timers = () => process.getActiveResourcesInfo().filter((n) => n === "Timeout").length;
  const before = timers();
  const g = gracefulShutdown({ server, proc: new EventEmitter(), timeoutMs: 30_000, hooks: [() => {}, async () => {}] });
  assert.deepEqual(await g.shutdown(), { code: 0, forced: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(timers(), before, "timers for the time limit are still running");
});

test("a shutdown started from code does not turn the first signal into 'a second signal'", async () => {
  const server = createServer((req, res) => res.end("ok"));
  await listen(server);
  const proc = new EventEmitter();
  const exits = [];
  const g = gracefulShutdown({ server, proc, exit: (code) => exits.push(code), hooks: [() => new Promise((r) => setTimeout(r, 100))] });
  const done = g.shutdown("fatal error");
  proc.emit("SIGTERM"); // Docker stops the container while we are already stopping
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [], "it must wait for the hooks");
  await done;
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(exits, [0]);
  proc.emit("SIGTERM"); // now it really is the second one
  assert.deepEqual(exits, [0, 1]);
});

test("a log function that throws cannot break the shutdown or leave a rejection behind", async () => {
  const server = createServer((req, res) => res.end("ok"));
  await listen(server);
  const proc = new EventEmitter();
  const exits = [];
  const g = gracefulShutdown({ server, proc, exit: (code) => exits.push(code), log: () => { throw new Error("disk full"); }, hooks: [() => {}] });
  proc.emit("SIGINT");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(exits, [0]);
  assert.deepEqual(await g.shutdown(), { code: 0, forced: false });
});

test("hooks must be an array of functions, drainMs must leave time for the rest", () => {
  const server = createServer(() => {});
  assert.throws(() => gracefulShutdown({ server, proc: new EventEmitter(), hooks: () => {} }), TypeError);
  assert.throws(() => gracefulShutdown({ server, proc: new EventEmitter(), hooks: ["x"] }), TypeError);
  assert.throws(() => gracefulShutdown({ server, proc: new EventEmitter(), timeoutMs: 1000, drainMs: 1000 }), RangeError);
  assert.throws(() => gracefulShutdown({ server, proc: new EventEmitter(), timeoutMs: 1000, drainMs: 5000 }), RangeError);
  assert.throws(() => gracefulShutdown({ server, proc: new EventEmitter(), signals: "SIGTERM" }), TypeError);
});

// A real process with real signals (Windows has no SIGTERM to send, so it is skipped there).
const real = (hookMs) => `
import { createServer } from "node:http";
import { gracefulShutdown } from ${JSON.stringify(new URL("./src/index.js", import.meta.url).href)};
const server = createServer((req, res) => res.end("ok"));
gracefulShutdown({ server, timeoutMs: 5000, log: (m) => console.log(m), hooks: [() => new Promise((r) => setTimeout(r, ${hookMs}))] });
server.listen(0, "127.0.0.1", () => console.log("ready"));
`;

const runChild = async (hookMs, signals) => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--input-type=module", "-e", real(hookMs)], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, out })));
  await new Promise((resolve) => child.stdout.on("data", (d) => { out += d; if (out.includes("ready")) resolve(); }));
  child.stdout.on("data", (d) => (out += d));
  for (const [signal, delay] of signals) {
    await new Promise((r) => setTimeout(r, delay));
    child.kill(signal);
  }
  return closed;
};

test("a real SIGTERM stops the process cleanly with exit code 0", { skip: process.platform === "win32" }, async () => {
  const result = await runChild(50, [["SIGTERM", 0]]);
  assert.deepEqual([result.code, result.signal], [0, null]);
  assert.match(result.out, /stopped cleanly/);
});

test("a real second signal exits at once with code 1, while a hook hangs", { skip: process.platform === "win32" }, async () => {
  const started = Date.now();
  const result = await runChild(60_000, [["SIGTERM", 0], ["SIGINT", 200]]);
  assert.deepEqual([result.code, result.signal], [1, null]);
  assert.ok(Date.now() - started < 3000);
});
