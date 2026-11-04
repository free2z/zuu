/**
 * The two ports the browser suite listens on -- and the single place that
 * decides them.
 *
 * WHY THIS EXISTS
 *
 * The suite runs `vite dev` on one port and `mock-api.mjs` on another, and
 * both used to be FIXED (4399 / 4400). Many agents work this repo at once,
 * each in its own worktree, and several of them are running the browser suite
 * at any moment -- so a fixed port is a machine-wide singleton that every
 * worktree fights over. The second run fails to bind, and the natural remedy
 * an agent reaches for is a repo-wide `pkill -f playwright`, which kills every
 * OTHER agent's browser run on the machine.
 *
 * That is the expensive part, because the damage is invisible and lands on the
 * wrong branch. A Playwright process killed out from under a spec produces
 * `Target closed`, `browserContext.newPage: Target page, context or browser
 * has been closed`, an abrupt timeout, or a refused mock-API connection -- all
 * indistinguishable from a real regression in the branch under test, and the
 * agent whose run was killed has no way to know it was killed. One night this
 * cost 18 phantom failures in a reviewer's shard and a second reviewer had to
 * be explicitly warned not to file findings against an innocent PR. Same
 * failure class as the shared scratchpad and the shared dev Postgres on:5433.
 *
 * So the ports are no longer a singleton:
 *
 *   * `PLAYWRIGHT_APP_PORT` / `PLAYWRIGHT_MOCK_API_PORT` still win when set.
 *     Agents were told to set them, and that has to keep working.
 *   * Otherwise the pair is DERIVED FROM THIS WORKTREE'S PATH, so two
 *     worktrees land on different ports without anybody coordinating.
 *   * The derived pair is probed before use and advances past an occupied one,
 *     which also covers the rare hash collision and an unrelated process.
 *   * An occupied EXPLICIT port is a hard failure with a message that names
 *     the port, says another agent may hold it, and gives the way out --
 *     never a dead end (the `bin/deploy-fence.sh` convention).
 *
 * `workers: 1, fullyParallel: false` is unrelated to any of this and stays:
 * the specs share one mock-API server *within a process tree*. What changed is
 * that two process trees in two worktrees no longer share one.
 *
 * WHO CALLS WHAT
 *
 *   * `playwright.config.ts` calls `resolveBrowserPorts()` exactly once, in
 *     the runner process. That call PUBLISHES the decision into
 *     `process.env`, and Playwright's worker processes inherit it.
 *   * Specs call `browserAppOrigin()` / `browserMockApiOrigin()` etc., which
 *     only READ that environment. They never re-derive: a spec that guessed a
 *     port the servers are not on would fail in exactly the way this change
 *     exists to prevent, so a missing variable throws instead of defaulting.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_PORT_ENV = "PLAYWRIGHT_APP_PORT";
export const MOCK_API_PORT_ENV = "PLAYWRIGHT_MOCK_API_PORT";
/**
 * Set by `resolveBrowserPorts` alongside the two ports, and the reason this
 * function is idempotent rather than merely deterministic.
 *
 * Playwright loads the config in the runner AND AGAIN in every worker process,
 * which inherits the runner's environment. Without this marker the second load
 * sees the two published ports, cannot tell them from an override the agent
 * asked for, probes them, finds them held -- by OUR OWN dev server and mock API
 * -- and refuses the run. (Observed while building: every spec failed at
 * config load with "port already in use" once the servers were up.)
 */
export const RESOLVED_ENV = "PLAYWRIGHT_PORTS_RESOLVED";

/**
 * Derived ports live in 20000-21999: above the range where dev tools cluster
 * (3000-9000), and BELOW the ephemeral range on both platforms we run on --
 * Linux allocates ephemeral ports from 32768 and macOS from 49152, so a port
 * picked here cannot be stolen by some unrelated outbound socket mid-run.
 */
export const PORT_BLOCK_BASE = 20000;
/** Each slot is a pair (app, app+1), so the block is 2 * PORT_BLOCK_SLOTS wide. */
export const PORT_BLOCK_SLOTS = 1000;
/** How many slots to try before giving up. 24 pairs is ~48 ports in one probe. */
const PROBE_SLOTS = 24;

export interface BrowserPorts {
  appPort: number;
  mockApiPort: number;
}

export interface ResolvedBrowserPorts extends BrowserPorts {
  appOrigin: string;
  mockApiOrigin: string;
  /** How we got here -- reported on stderr so a failing run says which ports it used. */
  source: "explicit" | "derived" | "mixed" | "inherited";
}

export function originFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * The seed the derived pair hangs off. The worktree path is the thing that
 * distinguishes two concurrent runs on this machine, so it is the seed.
 *
 * It comes from this file's own location rather than `process.cwd()`, because
 * cwd depends on how the runner was invoked and the worktree does not.
 *
 * `BROWSER_SHARD` joins the seed so that two shards started by hand in the
 * SAME worktree also get different ports. In CI each shard is a separate
 * runner, so it changes nothing there.
 *
 * Ports are only one part of invocation isolation. The Playwright config uses
 * a separately generated local artifact identifier (tests/browser/output.ts),
 * published into the environment just like these ports, so two runs in one
 * worktree do not clean up each other's traces or reports. CI keeps its fixed
 * upload paths; the local suffixes have matching root.gitignore globs.
 *
 * JSON rather than concatenation, so the two parts cannot run together into
 * one string two different ways. (The obvious separator, a NUL, does not
 * survive `prettier --write`: it rewrites the escape as a literal NUL byte
 * in this file.)
 */
export function portSeed(env: NodeJS.ProcessEnv = process.env): string {
  const appDir = resolvePath(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  return JSON.stringify([appDir, `shard=${env.BROWSER_SHARD ?? "1"}`]);
}

/**
 * The pair for a seed, `attempt` slots along. Deterministic: the same worktree
 * gets the same ports every run, which keeps a failure reproducible and makes
 * `lsof -nP -iTCP:<port>` meaningful twice in a row.
 */
export function derivePorts(seed: string, attempt = 0): BrowserPorts {
  const digest = createHash("sha256").update(seed).digest();
  const slot = (digest.readUInt32BE(0) + attempt) % PORT_BLOCK_SLOTS;
  const appPort = PORT_BLOCK_BASE + slot * 2;
  return { appPort, mockApiPort: appPort + 1 };
}

function parsePortEnv(
  name: string,
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${name}=${JSON.stringify(raw)} is not a TCP port. ` +
        `Set it to an integer in 1-65535, or unset it and let the suite derive ` +
        `a pair from this worktree's path.`,
    );
  }
  return port;
}

/**
 * Which of these ports are usable: bindable on 127.0.0.1 right now, or at least
 * not provably taken.
 *
 * Two non-answers are deliberately treated as "usable" rather than "occupied",
 * because only `EADDRINUSE` is evidence that somebody holds a port:
 *
 *   * the probe could not run at all (no node, timeout,...);
 *   * the probe ran but was not ALLOWED to bind -- `EPERM`/`EACCES` in a
 *     sandbox that forbids listening.
 *
 * Calling either of those "occupied" would make every port look contended and
 * send the reader off to hunt a colleague's process for a port nobody holds.
 * Misattributing an environment limitation to another agent's run is the exact
 * mistake this module exists to stop, so it says what happened on stderr and
 * lets the run proceed -- the servers' own bind errors then do the explaining.
 */
export function freeAmong(ports: number[]): Set<number> {
  const unique = [...new Set(ports)];
  if (unique.length === 0) return new Set();
  const probe = fileURLToPath(
    new URL("./probe-free-ports.mjs", import.meta.url),
  );
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [probe, ...unique.map(String)], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `playwright ports: could not probe for free ports (${reason}).\n` +
        `playwright ports: continuing without the check -- if a port is taken, ` +
        `the dev server or mock API will say which one.\n`,
    );
    return new Set(unique);
  }

  const verdicts = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const [rawPort, verdict] = line.trim().split(/\s+/);
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || !verdict) continue;
    verdicts.set(port, verdict);
  }

  const usable = new Set<number>();
  const unanswered = new Map<number, string>();
  for (const port of unique) {
    // A port the probe said nothing about is also not evidence of occupancy.
    const verdict = verdicts.get(port) ?? "ENOANSWER";
    if (verdict === "EADDRINUSE") continue;
    usable.add(port);
    if (verdict !== "free") unanswered.set(port, verdict);
  }

  if (unanswered.size > 0) {
    const codes = [...new Set(unanswered.values())].join(", ");
    process.stderr.write(
      `playwright ports: could not test ${unanswered.size} port(s) -- ` +
        `listening failed with ${codes}, which is not "in use".\n` +
        `playwright ports: that is usually a sandbox that forbids binding, not ` +
        `another agent holding the port; treating them as available.\n`,
    );
  }
  return usable;
}

/**
 * Every refusal from here names the port, says another agent may hold it, and
 * gives the way out. A message that only says "in use" sends the reader
 * looking for a kill command, which is the whole problem.
 */
function occupiedPortMessage(
  what: string,
  port: number,
  envName: string,
  suggestion: BrowserPorts,
): string {
  return [
    `Playwright ${what} port ${port} (from ${envName}) is already in use on 127.0.0.1.`,
    ``,
    `Another agent's browser run on this machine may be holding it. Many`,
    `worktrees run this suite in parallel, so a busy port is expected rather`,
    `than a bug -- and it is not yours to free.`,
    ``,
    `Pick one:`,
    `  * Unset ${APP_PORT_ENV} and ${MOCK_API_PORT_ENV}. The default pair is`,
    `    derived from THIS worktree's path (${suggestion.appPort}/${suggestion.mockApiPort}`,
    `    here) and auto-advances past anything occupied, so it will not collide`,
    `    with another worktree.`,
    `  * Or choose another pair explicitly:`,
    `      ${APP_PORT_ENV}=<n> ${MOCK_API_PORT_ENV}=<n+1> npm run test:browser`,
    `  * To see who holds it, without touching anyone else's processes:`,
    `      lsof -nP -iTCP:${port} -sTCP:LISTEN`,
    ``,
    `Do NOT free it with \`pkill -f playwright\` (or killall, or kill -9 by`,
    `name): that pattern is machine-wide, not worktree-scoped, and it kills`,
    `every other agent's browser run. The failures it causes look exactly like`,
    `regressions in whatever branch those agents were testing. See #1920.`,
  ].join("\n");
}

function exhaustedMessage(seed: string, tried: BrowserPorts[]): string {
  const first = tried[0];
  const last = tried[tried.length - 1];
  return [
    `Playwright could not find a free port pair for this worktree.`,
    ``,
    `Tried ${tried.length} pairs derived from this worktree's path, from`,
    `${first.appPort}/${first.mockApiPort} to ${last.appPort}/${last.mockApiPort},`,
    `and every one was occupied on 127.0.0.1. With ${PROBE_SLOTS} pairs taken,`,
    `either a great many browser suites are running on this machine or`,
    `something else owns the ${PORT_BLOCK_BASE}-${PORT_BLOCK_BASE + PORT_BLOCK_SLOTS * 2 - 1} block.`,
    ``,
    `Pick one:`,
    `  * Choose a pair outside that block:`,
    `      ${APP_PORT_ENV}=<n> ${MOCK_API_PORT_ENV}=<n+1> npm run test:browser`,
    `  * See what is holding them:`,
    `      lsof -nP -iTCP -sTCP:LISTEN | awk '$9 ~ /:2[01][0-9][0-9][0-9]$/'`,
    ``,
    `Do NOT clear them with \`pkill -f playwright\`: that is machine-wide and`,
    `kills other agents' runs, whose specs then fail in ways that look like`,
    `regressions on their branches. See #1920.`,
    ``,
    `(seed: ${JSON.stringify(seed)})`,
  ].join("\n");
}

/**
 * Decide the suite's ports and publish them into `process.env` for the worker
 * processes and the two servers. Call this exactly once, from
 * `playwright.config.ts`.
 *
 * `options.seed` exists for tests, which must not have to bind THIS worktree's
 * real ports to exercise the resolver -- doing that would make `npm test` fail
 * whenever the suite is also running, which is the class of false failure this
 * whole module removes.
 */
export function resolveBrowserPorts(
  env: NodeJS.ProcessEnv = process.env,
  options: { seed?: string } = {},
): ResolvedBrowserPorts {
  // Already decided in an ancestor process (a Playwright worker re-loading this
  // config): adopt it verbatim. Deciding twice is not merely wasteful -- the
  // second decision would probe ports our own servers are now holding and
  // refuse the run. See RESOLVED_ENV.
  if (env[RESOLVED_ENV]) {
    const app = parsePortEnv(APP_PORT_ENV, env[APP_PORT_ENV]);
    const mock = parsePortEnv(MOCK_API_PORT_ENV, env[MOCK_API_PORT_ENV]);
    if (app !== undefined && mock !== undefined) {
      return {
        appPort: app,
        mockApiPort: mock,
        appOrigin: originFor(app),
        mockApiOrigin: originFor(mock),
        source: "inherited",
      };
    }
    // A marker with no ports behind it can only come from a hand-edited
    // environment. Fall through and decide properly rather than guessing.
  }

  const explicitApp = parsePortEnv(APP_PORT_ENV, env[APP_PORT_ENV]);
  const explicitMock = parsePortEnv(MOCK_API_PORT_ENV, env[MOCK_API_PORT_ENV]);

  if (explicitApp !== undefined && explicitApp === explicitMock) {
    throw new Error(
      `${APP_PORT_ENV} and ${MOCK_API_PORT_ENV} are both ${explicitApp}. They are ` +
        `two different servers and must be two different ports -- and the mock API ` +
        `has to be a different ORIGIN from the app for the third-party-media specs ` +
        `to mean anything.`,
    );
  }

  const seed = options.seed ?? portSeed(env);
  const candidates: BrowserPorts[] = [];
  for (let attempt = 0; attempt < PROBE_SLOTS; attempt += 1) {
    const derived = derivePorts(seed, attempt);
    candidates.push({
      appPort: explicitApp ?? derived.appPort,
      mockApiPort: explicitMock ?? derived.mockApiPort,
    });
  }

  // One probe covers the explicit ports and every candidate slot.
  const free = freeAmong(
    candidates.flatMap((pair) => [pair.appPort, pair.mockApiPort]),
  );

  // An explicit port is a deliberate choice, so a busy one is refused rather
  // than quietly moved: silently testing against a different port than the one
  // the agent asked for is its own confusing failure.
  if (explicitApp !== undefined && !free.has(explicitApp)) {
    throw new Error(
      occupiedPortMessage("app", explicitApp, APP_PORT_ENV, derivePorts(seed)),
    );
  }
  if (explicitMock !== undefined && !free.has(explicitMock)) {
    throw new Error(
      occupiedPortMessage(
        "mock API",
        explicitMock,
        MOCK_API_PORT_ENV,
        derivePorts(seed),
      ),
    );
  }

  const chosen = candidates.find(
    (pair) =>
      pair.appPort !== pair.mockApiPort &&
      free.has(pair.appPort) &&
      free.has(pair.mockApiPort),
  );
  if (!chosen) throw new Error(exhaustedMessage(seed, candidates));

  const source =
    explicitApp !== undefined && explicitMock !== undefined
      ? "explicit"
      : explicitApp === undefined && explicitMock === undefined
        ? "derived"
        : "mixed";

  // Publish. Playwright's workers are child processes and inherit this, which
  // is how a spec reads the ports the servers actually bound -- and the marker
  // is what stops those workers from re-deciding.
  env[APP_PORT_ENV] = String(chosen.appPort);
  env[MOCK_API_PORT_ENV] = String(chosen.mockApiPort);
  env[RESOLVED_ENV] = `${chosen.appPort}/${chosen.mockApiPort}`;

  return {
    ...chosen,
    appOrigin: originFor(chosen.appPort),
    mockApiOrigin: originFor(chosen.mockApiPort),
    source,
  };
}

function requirePort(name: string, env: NodeJS.ProcessEnv): number {
  const port = parsePortEnv(name, env[name]);
  if (port === undefined) {
    throw new Error(
      `${name} is not set in this process.\n` +
        `\n` +
        `playwright.config.ts decides the browser suite's ports and publishes ` +
        `them into the environment; specs only read them. If you are seeing this ` +
        `from a spec, it was run outside that config -- use \`npm run test:browser\` ` +
        `(optionally with ${APP_PORT_ENV}/${MOCK_API_PORT_ENV} set). A spec must ` +
        `never fall back to a guessed port: it would test against a server that ` +
        `is not there and report it as a product failure (#1920).`,
    );
  }
  return port;
}

/** The port `vite dev` is serving the app on, for the current run. */
export function browserAppPort(env: NodeJS.ProcessEnv = process.env): number {
  return requirePort(APP_PORT_ENV, env);
}

/** The port `mock-api.mjs` is answering on, for the current run. */
export function browserMockApiPort(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return requirePort(MOCK_API_PORT_ENV, env);
}

/** `http://127.0.0.1:<app port>` -- also the suite's `baseURL`. */
export function browserAppOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return originFor(browserAppPort(env));
}

/**
 * `http://127.0.0.1:<mock api port>` -- deliberately a different origin from
 * the app, which is what makes the mock server genuinely third party to the
 * page under test.
 */
export function browserMockApiOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return originFor(browserMockApiPort(env));
}
