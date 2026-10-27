/**
 * The browser suite's ports must not be a machine-wide singleton.
 *
 * Two agents in two worktrees used to fight over 4399/4400, and the remedy one
 * of them reached for was `pkill -f playwright` -- which is repo-wide, killed
 * every other agent's browser run, and produced 18 failures in a reviewer's
 * shard that were indistinguishable from regressions on the branch under test.
 *
 * Every assertion here is paired with its negative control, because each one is
 * about something NOT happening: the ports not colliding, a spec not silently
 * falling back to a port nothing is listening on, a busy port not producing a
 * dead-end message.
 *
 * THESE TESTS MUST NOT ASSUME A PORT IS FREE. This file runs under `npm test`
 * on the same machines the suite runs on, so it resolves against random seeds
 * rather than this worktree's real pair, takes the ports it needs to hold from
 * the OS (`listen(0)`), releases them at the end of each test, and SKIPS with a
 * reason when the machine will not give it a socket. A test that went red
 * because a colleague's suite held a port would be this very failure mode,
 * reintroduced by its own test (codex review of this change caught exactly that
 * in the first draft: two cases could hash to one port and collide with each
 * other).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  APP_PORT_ENV,
  MOCK_API_PORT_ENV,
  PORT_BLOCK_BASE,
  PORT_BLOCK_SLOTS,
  RESOLVED_ENV,
  browserAppOrigin,
  browserMockApiOrigin,
  derivePorts,
  freeAmong,
  portSeed,
  resolveBrowserPorts,
} from "./browser/ports.ts";
import {
  cleanupAfterLocalRun,
  cleanupSuccessfulLocalOutput,
  OUTPUT_ID_ENV,
  resolveBrowserOutputPaths,
} from "./browser/output.ts";

const BROWSER_DIR = fileURLToPath(new URL("./browser/", import.meta.url));
const CONFIG = fileURLToPath(
  new URL("../playwright.config.ts", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Env with no port override or per-run marker, so derivation is exercised.
 * Keep local-output tests independent of the environment running npm test:
 * CI=true and an inherited marker describe the parent suite, not this test's
 * simulated fresh local invocation.
 */
function derivedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env[APP_PORT_ENV];
  delete env[MOCK_API_PORT_ENV];
  delete env[RESOLVED_ENV];
  delete env.CI;
  delete env[OUTPUT_ID_ENV];
  return env;
}

/** A seed no real worktree has, so these tests never touch anyone's ports. */
function throwawaySeed() {
  return `test-seed-${randomUUID()}`;
}

function gitIgnores(relativePath) {
  try {
    execFileSync(
      "git",
      ["check-ignore", "--no-index", "-q", "--", relativePath],
      { cwd: REPO_ROOT },
    );
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

/**
 * Listen on `port`, releasing it when this test ends. `port` 0 asks the OS for
 * one that is definitely free. Returns null when the machine refuses, so the
 * caller can skip rather than fail.
 */
async function hold(t, port) {
  const server = createServer();
  const bound = await new Promise((resolve) => {
    server.once("error", () => resolve(null));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      resolve(server.address().port),
    );
  });
  if (bound === null) return null;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return bound;
}

test("the derived pair is a function of the worktree, so two worktrees differ", () => {
  // The seeds real parallel agents produce: sibling worktrees under
  //.claude/worktrees or.worktrees, plus the primary checkout.
  const seeds = [
    '["/workspace/free2z/zuu/ts/svelte/free2z","shard=1"]',
    '["/workspace/free2z/.worktrees/fix-a/ts/svelte/free2z","shard=1"]',
    '["/workspace/free2z/.worktrees/fix-b/ts/svelte/free2z","shard=1"]',
    '["/workspace/free2z/zuu/.claude/worktrees/agent-1/ts/svelte/free2z","shard=1"]',
    '["/workspace/free2z/zuu/.claude/worktrees/agent-2/ts/svelte/free2z","shard=1"]',
    '["/home/runner/work/tuzi/tuzi/ts/svelte/free2z","shard=1"]',
  ];
  const pairs = seeds.map((seed) => derivePorts(seed));
  const appPorts = new Set(pairs.map((pair) => pair.appPort));
  assert.equal(
    appPorts.size,
    seeds.length,
    `two of these worktrees derive the same app port: ${JSON.stringify(pairs)}`,
  );

  for (const pair of pairs) {
    assert.equal(pair.mockApiPort, pair.appPort + 1);
    assert.ok(
      pair.appPort >= PORT_BLOCK_BASE &&
        pair.mockApiPort < PORT_BLOCK_BASE + PORT_BLOCK_SLOTS * 2,
      `${pair.appPort}/${pair.mockApiPort} is outside the reserved block`,
    );
    // Below the ephemeral range on Linux (32768+) and macOS (49152+): an
    // unrelated outbound socket must not be able to take the suite's port
    // mid-run.
    assert.ok(
      pair.mockApiPort < 32768,
      `${pair.mockApiPort} is in ephemeral range`,
    );
  }

  // Negative control for the whole mechanism: the same worktree must be
  // STABLE, or a failure is not reproducible and `lsof` tells you nothing
  // twice in a row.
  assert.deepEqual(derivePorts(seeds[0]), derivePorts(seeds[0]));
  //...and two shards started by hand in ONE worktree must still differ.
  assert.notEqual(
    derivePorts(seeds[0]).appPort,
    derivePorts(seeds[0].replace("shard=1", "shard=2")).appPort,
  );
});

test("every shard of a matrix gets its own pair, however many shards there are", () => {
  // The matrix went 4-way → 5-way on main  while this change was in
  // review, and a new shard index is a slot nothing had probed. Asserting a
  // range well past the current count means the next shard cannot land on a
  // port another shard of the same tree is already using.
  const MAX = 12;
  for (const tree of [
    "/workspace/free2z/zuu/.claude/worktrees/agent-x/ts/svelte/free2z",
    "/home/runner/work/tuzi/tuzi/ts/svelte/free2z",
  ]) {
    const pairs = [];
    for (let shard = 1; shard <= MAX; shard += 1) {
      pairs.push(derivePorts(JSON.stringify([tree, `shard=${shard}`])));
    }
    const ports = pairs.flatMap((pair) => [pair.appPort, pair.mockApiPort]);
    assert.equal(
      new Set(ports).size,
      ports.length,
      `two shards of ${tree} share a port: ${JSON.stringify(pairs)}`,
    );
    for (const port of ports) {
      assert.ok(
        port >= PORT_BLOCK_BASE &&
          port < PORT_BLOCK_BASE + PORT_BLOCK_SLOTS * 2 &&
          port < 32768,
        `${port} is outside the reserved block or inside the ephemeral range`,
      );
    }
  }
});

test("the seed is this worktree's path plus the shard", () => {
  const seed = portSeed(derivedEnv({ BROWSER_SHARD: "3" }));
  assert.ok(
    seed.includes(BROWSER_DIR.replace(/\/tests\/browser\/$/, "")),
    seed,
  );
  assert.ok(seed.includes('"shard=3"'), seed);
  assert.ok(
    portSeed(derivedEnv()).includes('"shard=1"'),
    "shard defaults to 1",
  );
});

test("resolving publishes the decision so workers and specs read it", () => {
  const env = derivedEnv();
  const resolved = resolveBrowserPorts(env, { seed: throwawaySeed() });

  assert.equal(resolved.source, "derived");
  assert.equal(env[APP_PORT_ENV], String(resolved.appPort));
  assert.equal(env[MOCK_API_PORT_ENV], String(resolved.mockApiPort));
  assert.equal(
    env[RESOLVED_ENV],
    `${resolved.appPort}/${resolved.mockApiPort}`,
  );
  assert.equal(resolved.appOrigin, `http://127.0.0.1:${resolved.appPort}`);
  assert.notEqual(resolved.appPort, resolved.mockApiPort);
  // Specs read only the environment -- never a re-derivation, which could
  // disagree with the port the servers actually bound.
  assert.equal(browserAppOrigin(env), resolved.appOrigin);
  assert.equal(browserMockApiOrigin(env), resolved.mockApiOrigin);
});

test("local Playwright outputs stay local under a CI test process", () => {
  const env = derivedEnv();
  assert.equal(env.CI, undefined);
  assert.equal(env[OUTPUT_ID_ENV], undefined);

  const resolved = resolveBrowserOutputPaths(env, {
    identifier: "ci-test-process-must-still-be-local",
  });
  assert.equal(resolved.source, "local");
  assert.match(resolved.outputDir, /^\.\/test-results-local-/);
  assert.match(resolved.reportDir, /^\.\/playwright-report-local-/);
});

test("local Playwright outputs are unique and stable within an invocation", () => {
  const firstEnv = derivedEnv();
  const secondEnv = derivedEnv();
  const first = resolveBrowserOutputPaths(firstEnv);
  const second = resolveBrowserOutputPaths(secondEnv);

  assert.equal(first.source, "local");
  assert.equal(second.source, "local");
  assert.notEqual(first.identifier, second.identifier);
  assert.notEqual(first.outputDir, second.outputDir);
  assert.notEqual(first.reportDir, second.reportDir);
  assert.match(first.outputDir, /^\.\/test-results-local-/);
  assert.match(first.reportDir, /^\.\/playwright-report-local-/);

  const reloaded = resolveBrowserOutputPaths(firstEnv, {
    identifier: "a-different-run-must-not-win",
  });
  assert.equal(reloaded.source, "inherited");
  assert.deepEqual(reloaded, { ...first, source: "inherited" });
  assert.equal(firstEnv[OUTPUT_ID_ENV], first.identifier);
});

test("a passing local run removes only its own output directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "playwright-output-cleanup-"));
  try {
    const env = derivedEnv({ [OUTPUT_ID_ENV]: "pid-123-local-test" });
    const output = resolveBrowserOutputPaths(env);
    const ownDir = path.resolve(root, output.outputDir);
    const siblingDir = path.resolve(root, "test-results-local-pid-456-sibling");
    await Promise.all([mkdir(ownDir), mkdir(siblingDir)]);

    assert.equal(
      await cleanupSuccessfulLocalOutput({
        status: "passed",
        env,
        configuredOutputDir: ownDir,
        cwd: root,
      }),
      true,
    );
    assert.deepEqual(await readdir(root), [path.basename(siblingDir)]);

    await mkdir(ownDir);
    assert.equal(
      await cleanupSuccessfulLocalOutput({
        status: "failed",
        env,
        configuredOutputDir: ownDir,
        cwd: root,
      }),
      false,
    );
    assert.deepEqual(
      new Set(await readdir(root)),
      new Set([path.basename(ownDir), path.basename(siblingDir)]),
    );

    assert.equal(
      await cleanupSuccessfulLocalOutput({
        status: "passed",
        env,
        configuredOutputDir: siblingDir,
        cwd: root,
      }),
      false,
      "a different invocation's output path is never removed",
    );
    assert.deepEqual(
      new Set(await readdir(root)),
      new Set([path.basename(ownDir), path.basename(siblingDir)]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a passing run started from another directory still removes its own output", async () => {
  // Playwright resolves `outputDir` relative to the config file, so a run
  // started elsewhere (`-c ts/svelte/free2z/playwright.config.ts` from the
  // repo root) must still clean up after itself. `root` is a temp dir and this
  // process's cwd is not, which is exactly that shape.
  const root = await mkdtemp(
    path.join(tmpdir(), "playwright-output-config-dir-"),
  );
  try {
    assert.notEqual(path.resolve(process.cwd()), path.resolve(root));
    const env = derivedEnv({ [OUTPUT_ID_ENV]: "pid-789-config-dir-test" });
    const ownDir = path.resolve(root, resolveBrowserOutputPaths(env).outputDir);
    await mkdir(ownDir);

    assert.equal(
      await cleanupAfterLocalRun({
        status: "passed",
        env,
        configFile: path.join(root, "playwright.config.ts"),
        configuredOutputDir: ownDir,
      }),
      true,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CI keeps the artifact directories that the workflow uploads", () => {
  const env = { CI: "true" };
  const resolved = resolveBrowserOutputPaths(env, {
    identifier: "this-must-not-change-ci-paths",
  });

  assert.deepEqual(resolved, {
    outputDir: "./test-results",
    reportDir: "./playwright-report",
    source: "ci",
  });
  assert.equal(env[OUTPUT_ID_ENV], undefined);
});

test("the ignore rules cover every locally derived output path", () => {
  const paths = resolveBrowserOutputPaths(derivedEnv(), {
    identifier: "1949-test-run",
  });
  assert.equal(paths.source, "local");
  const relative = (path) =>
    `ts/svelte/free2z/${path.replace(/^\.\//, "")}/artifact`;

  assert.equal(gitIgnores(relative(paths.outputDir)), true);
  assert.equal(gitIgnores(relative(paths.reportDir)), true);

  // Negative controls: the exact CI names remain covered by their existing
  // rules, but an unconfigured sibling must not be covered by the local globs.
  assert.equal(
    gitIgnores("ts/svelte/free2z/test-results-1949-test-run/artifact"),
    false,
  );
  assert.equal(
    gitIgnores("ts/svelte/free2z/playwright-report-1949-test-run/artifact"),
    false,
  );
  assert.equal(gitIgnores("ts/svelte/free2z/test-results/artifact"), true);
  assert.equal(gitIgnores("ts/svelte/free2z/playwright-report/artifact"), true);
});

test("a worker re-loading the config adopts the decision instead of re-making it", async (t) => {
  // Playwright loads playwright.config.ts in the runner AND in every worker
  // process. The worker inherits the published ports -- which by then our own
  // dev server and mock API are HOLDING. Re-deciding there refused every spec
  // with "port already in use" (observed while building this change).
  const runnerEnv = derivedEnv();
  const seed = throwawaySeed();
  const resolved = resolveBrowserPorts(runnerEnv, { seed });
  const heldApp = await hold(t, resolved.appPort);
  const heldMock = await hold(t, resolved.mockApiPort);
  if (heldApp === null || heldMock === null) {
    t.skip(
      `could not hold ${resolved.appPort}/${resolved.mockApiPort} to stand in ` +
        `for the suite's own servers; that is the machine, not the resolver`,
    );
    return;
  }

  // The worker's environment is a copy of the runner's, marker included.
  const inherited = resolveBrowserPorts({ ...runnerEnv }, { seed });
  assert.equal(inherited.appPort, resolved.appPort);
  assert.equal(inherited.mockApiPort, resolved.mockApiPort);
  assert.equal(inherited.source, "inherited");

  // Negative control: it is the MARKER doing that work, not luck. Strip it and
  // the very same environment refuses, which is the bug this test pins.
  const unmarked = { ...runnerEnv };
  delete unmarked[RESOLVED_ENV];
  assert.throws(
    () => resolveBrowserPorts(unmarked, { seed }),
    /already in use/i,
  );
});

test("an explicit override still wins -- agents were told to set these", async (t) => {
  // Two ports the OS has just confirmed free, rather than two we hope are: it
  // hands them out, we release them, and nothing in the derived block is
  // touched.
  const scout = createServer();
  const pair = await new Promise((resolve) => {
    scout.once("error", () => resolve(null));
    scout.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () =>
      resolve(scout.address().port),
    );
  });
  await new Promise((resolve) => scout.close(resolve));
  if (pair === null) {
    t.skip("the machine would not give us an ephemeral port to borrow");
    return;
  }

  const env = derivedEnv();
  env[APP_PORT_ENV] = String(pair);
  env[MOCK_API_PORT_ENV] = String(pair + 1);
  let resolved;
  try {
    resolved = resolveBrowserPorts(env, { seed: throwawaySeed() });
  } catch (error) {
    // Something took one of them in the microseconds since: that is the
    // refusal path, covered by its own test below, not a failure here.
    t.skip(`the borrowed ports were taken again: ${error.message}`);
    return;
  }
  assert.equal(resolved.appPort, pair);
  assert.equal(resolved.mockApiPort, pair + 1);
  assert.equal(resolved.source, "explicit");
  // The override must survive verbatim: not nudged into the derived block.
  assert.equal(env[APP_PORT_ENV], String(pair));
});

test("an occupied EXPLICIT port refuses, and the refusal names the way out", async (t) => {
  const env = derivedEnv();
  const victim = await hold(t, 0);
  if (victim === null) {
    t.skip("the machine would not give us a socket to occupy");
    return;
  }
  env[APP_PORT_ENV] = String(victim);

  assert.throws(
    () => resolveBrowserPorts(env, { seed: throwawaySeed() }),
    (error) => {
      const message = String(error.message);
      // It must say WHICH port and WHICH variable...
      assert.match(message, new RegExp(`\\b${victim}\\b`));
      assert.match(message, new RegExp(APP_PORT_ENV));
      assert.match(message, /already in use/i);
      //...that another agent may hold it, rather than implying a bug...
      assert.match(message, /another agent/i);
      //...and how to get out of it. A refusal with no escape hatch is what
      // sends an agent looking for a kill command.
      assert.match(message, /lsof/);
      assert.match(message, /PLAYWRIGHT_MOCK_API_PORT=/);
      //...including the rule that caused the incident.
      assert.match(message, /pkill/);
      assert.match(message, /#1920/);
      return true;
    },
  );
});

test("a derived pair that is occupied advances instead of failing", async (t) => {
  const env = derivedEnv();
  const seed = throwawaySeed();
  const first = derivePorts(seed, 0);
  // Stand in for another agent's run holding this seed's first choice.
  if ((await hold(t, first.appPort)) === null) {
    t.skip(
      `could not hold ${first.appPort}; that is the machine, not the code`,
    );
    return;
  }

  const resolved = resolveBrowserPorts(env, { seed });
  assert.notEqual(
    resolved.appPort,
    first.appPort,
    "resolution returned a port another process is holding",
  );
  assert.equal(resolved.source, "derived");
  assert.equal(
    freeAmong([resolved.appPort, resolved.mockApiPort]).size,
    2,
    "the advanced-to pair is not usable",
  );
});

test("a port we were not ALLOWED to test is not reported as occupied", () => {
  // EPERM is not evidence that anybody holds a port. Collapsing every errno
  // into "occupied" made every port look contended inside a sandbox that
  // forbids listening, and the refusal then blamed a colleague for a port
  // nobody held -- the same misattribution this change exists to stop. Found
  // by the codex review of this change. Only EADDRINUSE means occupied.
  const source = readFileSync(
    fileURLToPath(new URL("./browser/probe-free-ports.mjs", import.meta.url)),
    "utf8",
  );
  assert.match(source, /error\.code \|\| "EUNKNOWN"/);
  assert.doesNotMatch(
    source,
    /resolve\(false\)/,
    "the probe collapsed every errno into one verdict again",
  );

  assert.equal(freeAmong([]).size, 0);
  // 70000 comes back with an errno rather than "free", and 0 comes back with no
  // line at all (it means "pick one for me"). Neither is EADDRINUSE, so both
  // must be reported usable -- the two halves of the non-answer path.
  assert.equal(
    freeAmong([70000, 0]).size,
    2,
    "a port the probe could not answer for was called occupied",
  );
});

test("a malformed override fails loudly rather than defaulting", () => {
  const env = derivedEnv();
  env[APP_PORT_ENV] = "not-a-port";
  assert.throws(() => resolveBrowserPorts(env), /not a TCP port/);

  const same = derivedEnv();
  same[APP_PORT_ENV] = "20500";
  same[MOCK_API_PORT_ENV] = "20500";
  assert.throws(() => resolveBrowserPorts(same), /two different ports/);
});

test("a spec that reads a port outside the config gets an error, not a guess", () => {
  const empty = derivedEnv();
  assert.throws(() => browserAppOrigin(empty), /is not set in this process/);
  assert.throws(
    () => browserMockApiOrigin(empty),
    /is not set in this process/,
  );
  // Negative control: with the variable present it must not throw.
  assert.equal(
    browserAppOrigin({ ...empty, [APP_PORT_ENV]: "20404" }),
    "http://127.0.0.1:20404",
  );
});

test("no browser-suite file hardcodes a port", () => {
  // This is the guard that keeps the class from creeping back one spec at a
  // time. A single spec pinned to 4399 is invisible until the day the derived
  // port differs, and then it fails like a product bug.
  const files = readdirSync(BROWSER_DIR)
    .filter((name) => /\.(ts|mjs)$/.test(name))
    .map((name) => `${BROWSER_DIR}${name}`)
    .concat([CONFIG]);

  // Deliberately narrow: a spec legitimately quotes OTHER services' ports --
  // `http://127.0.0.1:8000/...` appears in a DRF pagination fixture. What must
  // never appear is a suite port.
  const RULES = [
    {
      // The two ports the suite used to be pinned to.
      pattern: /\b(4399|4400)\b/,
      why: "is the old fixed suite port; call browserAppOrigin()/browserMockApiOrigin() from ./ports instead",
    },
    {
      // Either spelling of the loopback host, and only ports that could be
      // ours: `localhost:8000` is the Django dev server and appears in
      // comments.
      pattern: /(127\.0\.0\.1|localhost):2[01]\d{3}\b/,
      why: "hardcodes a port from the derived block; the pair changes per worktree",
    },
    {
      // Dotted and bracketed access, so `process.env["PLAYWRIGHT_APP_PORT"]`
      // does not slip past the historical idiom.
      pattern: /process\.env\s*(\.|\[\s*["'])PLAYWRIGHT_(APP|MOCK_API)_PORT/,
      why: "reads the port environment directly, which invites a `|| 4400` fallback; use ./ports, whose accessors throw rather than guess",
    },
    {
      //...and destructuring it out of process.env, which reads nothing like
      // the line above.
      pattern: /PLAYWRIGHT_(APP|MOCK_API)_PORT[^\n]*\}\s*=\s*process\.env/,
      why: "destructures the port environment; use ./ports, whose accessors throw rather than guess",
    },
  ];

  const offenders = [];
  for (const file of files) {
    // ports.ts is the module that implements and documents these rules, so it
    // is the one place allowed to name the numbers.
    if (file.endsWith("/ports.ts")) continue;
    const source = readFileSync(file, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      const where = `${file.replace(BROWSER_DIR, "")}:${index + 1}`;
      for (const rule of RULES) {
        if (rule.pattern.test(line)) {
          offenders.push(`${where} ${rule.why}: ${line.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));

  // Negative control for the scanner itself: it must flag every shape it
  // exists to catch, or the empty result above means nothing at all.
  const samples = [
    "const origin = `http://127.0.0.1:${process.env.PLAYWRIGHT_APP_PORT || 4399}`;",
    '  url: "http://127.0.0.1:4399",',
    "const mock = `http://127.0.0.1:20404`;",
    'const mock = "http://localhost:20404";',
    "const port = process.env.PLAYWRIGHT_MOCK_API_PORT;",
    'const port = process.env["PLAYWRIGHT_APP_PORT"] ?? 5000;',
    "const { PLAYWRIGHT_APP_PORT } = process.env;",
  ];
  for (const sample of samples) {
    assert.ok(
      RULES.some((rule) => rule.pattern.test(sample)),
      `the scanner would not have caught: ${sample}`,
    );
  }
  //...and it must NOT flag the legitimate lines, or it gets disabled: other
  // services' ports are quoted on purpose in fixtures and comments.
  const allowed = [
    "next: `http://127.0.0.1:8000/api/comments/?cursor=x`,",
    "// server proxies the browser's `/api/**` to `localhost:8000`, which",
    "const port = Number(process.env.MOCK_API_PORT);",
  ];
  for (const line of allowed) {
    assert.ok(
      !RULES.some((rule) => rule.pattern.test(line)),
      `the scanner flags a legitimate line: ${line}`,
    );
  }
});
