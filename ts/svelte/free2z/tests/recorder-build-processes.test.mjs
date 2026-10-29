import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { recorderBuildProcesses } from "./helpers/recorder-build-processes.mjs";

async function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      if (
        ["Z", "X"].includes(
          stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3),
        )
      )
        return false;
    }
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes(error.code)) return false;
    throw error;
  }
}

async function readReady(marker) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(marker, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  assert.fail("owned processes did not reach readiness");
}

async function stopped(pids) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (!(await Promise.all(pids.map(alive))).some(Boolean)) return;
    await delay(10);
  }
  assert.fail("owned process survived cleanup");
}

async function killFixture(pids) {
  if (!pids || !(await Promise.all(pids.map(alive))).some(Boolean)) return;
  try {
    process.kill(-pids[0], "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

for (const parentIgnoresTerm of [true, false]) {
  test(
    `aborting a build terminates its descendant when the leader ${parentIgnoresTerm ? "ignores" : "exits on"} SIGTERM`,
    {
      timeout: 10_000,
      skip: process.platform === "win32" && "requires POSIX process groups",
    },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "recorder-abort-"));
      const marker = join(directory, "ready.json");
      const controller = new AbortController();
      const diagnostics = [];
      const processes = recorderBuildProcesses(
        AbortSignal.any([t.signal, controller.signal]),
        (message) => diagnostics.push(message),
      );
      const script = `
    const { spawn } = require('node:child_process');
    const { writeFileSync, renameSync } = require('node:fs');
    ${parentIgnoresTerm ? "process.on('SIGTERM', () => {});" : ""}
    const descendant = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"
    ], { stdio: ['ignore', '${parentIgnoresTerm ? "inherit" : "ignore"}', '${parentIgnoresTerm ? "inherit" : "ignore"}', 'ipc'] });
    descendant.on('message', () => {
      process.stdout.write('hanging fixture ready\\n', () => {
        process.stderr.write('descendant ignores SIGTERM\\n', () => {
          const temporary = process.argv[1] + '.tmp';
          writeFileSync(temporary, JSON.stringify([process.pid, descendant.pid]));
          renameSync(temporary, process.argv[1]);
        });
      });
    });
    setInterval(() => {}, 1000);
  `;
      const result = processes
        .run(["-e", script, marker], "hanging fixture")
        .then(
          () => null,
          (error) => error,
        );
      let pids;
      try {
        pids = await readReady(marker);
        assert.equal(await alive(pids[0]), true);
        assert.equal(await alive(pids[1]), true);
        controller.abort();
        const failure = await result;
        assert.match(failure.message, /Aborted hanging fixture/);
        assert.equal(failure.signal, parentIgnoresTerm ? "SIGKILL" : "SIGTERM");
        await stopped(pids);
        // close fires after both pipes drain, unlike the initial abort snapshot.
        const reaped = diagnostics.find((message) =>
          message.startsWith("Reaped "),
        );
        assert.match(reaped, /hanging fixture ready/);
        assert.match(reaped, /descendant ignores SIGTERM/);
        await assert.rejects(
          processes.run(["-e", "process.exit(0)"]),
          /aborted/,
        );
      } finally {
        await processes.close();
        await killFixture(pids);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

for (const interruption of ["SIGINT", "SIGTERM", "exit"]) {
  test(
    `runner ${interruption} terminates detached owned builds`,
    {
      timeout: 10_000,
      skip: process.platform === "win32" && "requires POSIX process groups",
    },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "recorder-interrupt-"));
      const marker = join(directory, "ready.json");
      const helper = new URL(
        "./helpers/recorder-build-processes.mjs",
        import.meta.url,
      ).href;
      const fixture = `
      const { spawn } = require('node:child_process');
      const { writeFileSync, renameSync } = require('node:fs');
      process.on('SIGTERM', () => {});
      const descendant = spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"
      ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      descendant.on('message', () => {
        writeFileSync(process.argv[1] + '.tmp', JSON.stringify([process.pid, descendant.pid]));
        renameSync(process.argv[1] + '.tmp', process.argv[1]);
      });
      setInterval(() => {}, 1000);
    `;
      const runner = `
      import { recorderBuildProcesses } from ${JSON.stringify(helper)};
      import { test } from 'node:test';
      test('controlled hanging build', { timeout: 8000 }, async (t) => {
        const exitTimer = setInterval(() => {
          if (existsSync(marker + '.exit')) process.exit(17);
        }, 10);
        const builds = recorderBuildProcesses(t.signal, () => {});
        try { await builds.run(['-e', ${JSON.stringify(fixture)}, ${JSON.stringify(marker)}]); }
        finally { clearInterval(exitTimer); await builds.close(); }
      });
    `;
      const processes = recorderBuildProcesses(t.signal, () => {});
      // Capture the runner separately from its detached build group so the
      // interruption targets only the runner this test created.
      const wrapped = `
      import { writeFileSync, renameSync, existsSync } from 'node:fs';
      const marker = ${JSON.stringify(marker)};
      writeFileSync(marker + '.runner.tmp', JSON.stringify(process.ppid));
      renameSync(marker + '.runner.tmp', marker + '.runner');
      ${runner}
    `;
      const runnerPath = join(directory, "runner.test.mjs");
      await writeFile(runnerPath, wrapped);
      // A fresh test coordinator must not inherit this worker's IPC context.
      const environment = { ...process.env };
      delete environment.NODE_TEST_CONTEXT;
      const result = processes
        .run(["--test", runnerPath], "test runner fixture", environment)
        .then(
          () => null,
          (error) => error,
        );
      let pids;
      try {
        pids = await Promise.race([
          readReady(marker),
          result.then((failure) => {
            throw failure;
          }),
        ]);
        const runnerPid = await readReady(marker + ".runner");
        // Terminal interruption reaches the runner and test worker's group.
        if (interruption === "exit") await writeFile(marker + ".exit", "exit");
        else process.kill(-runnerPid, interruption);
        const failure = await result;
        assert.ok(
          failure.code === 1 || failure.signal === interruption,
          failure.message,
        );
        await stopped(pids);
      } finally {
        await processes.close();
        await killFixture(pids);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test(
  "failed build diagnostics retain bounded stdout and stderr tails",
  { timeout: 5000 },
  async (t) => {
    const processes = recorderBuildProcesses(t.signal);
    try {
      await assert.rejects(
        processes.run(
          [
            "-e",
            `
      process.stdout.write('x'.repeat(100000) + 'STDOUT-END');
      process.stderr.write('y'.repeat(100000) + 'STDERR-END');
      process.exitCode = 7;
    `,
          ],
          "noisy fixture",
        ),
        (error) => {
          assert.equal(error.code, 7);
          assert.match(error.message, /STDOUT-END/);
          assert.match(error.message, /STDERR-END/);
          assert.ok(error.message.length < 17000, "output tails stay bounded");
          return true;
        },
      );
    } finally {
      await processes.close();
    }
  },
);
