#!/usr/bin/env node
/**
 * Reports, one line per port given on argv, whether it can be bound on
 * 127.0.0.1 right now:
 *
 *   20518 free            -- bound and released, it is available
 *   20519 EADDRINUSE      -- something else holds it
 *   20520 EPERM           -- we were not ALLOWED to find out
 *
 * The third case is the one worth spelling out. Any error used to mean
 * "occupied", so a sandbox that denies socket binds outright made every port
 * look contended and the suite then blamed another agent for holding a port
 * nobody held. Misattributing an environment limitation to a colleague's run is
 * the exact mistake  is about, so the caller gets the errno and decides.
 *
 * This is a separate process on purpose. `playwright.config.ts` is evaluated
 * synchronously -- the default export has to be a config object, not a promise
 * -- and Node has no synchronous way to ask whether a port is free. So the
 * config shells out with `execFileSync` and gets every answer in one round trip
 * of ~60ms, rather than binding ports one at a time.
 *
 * It answers only for 127.0.0.1, which is where both suite servers bind
 * (`vite dev --host 127.0.0.1` and `mock-api.mjs`). A port occupied on some
 * other interface is irrelevant to us and is correctly reported free.
 *
 * The answer is inherently point-in-time: another agent on this machine can
 * take a port between the probe and the bind. That is why the servers keep
 * their own loud EADDRINUSE messages -- the probe makes the collision rare, it
 * does not make it impossible.
 */
import { createServer } from "node:net";

const ports = process.argv.slice(2).map((value) => Number(value));

/** "free", or the errno that stopped us finding out. */
function probe(port) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve("EINVAL");
      return;
    }
    const server = createServer();
    server.once("error", (error) => resolve(error.code || "EUNKNOWN"));
    // `exclusive` matters: without it a port already bound by another process
    // with SO_REUSEADDR semantics can look bindable and then fail for real.
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve("free"));
    });
  });
}

const verdicts = await Promise.all(ports.map((port) => probe(port)));

process.stdout.write(
  ports.map((port, index) => `${port} ${verdicts[index]}`).join("\n") +
    (ports.length ? "\n" : ""),
);
