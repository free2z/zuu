import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      if (["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3))) return false;
    }
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes(error.code)) return false;
    throw error;
  }
}

test("aborting a hanging build reaps it and terminates its owned descendant", {
  timeout: 10_000,
  skip: process.platform === "win32" && "requires POSIX process groups",
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "recorder-abort-"));
  const marker = join(directory, "ready.json");
  const controller = new AbortController();
  const diagnostics = [];
  const processes = recorderBuildProcesses(
    AbortSignal.any([t.signal, controller.signal]), (message) => diagnostics.push(message),
  );
  const script = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    process.on('SIGTERM', () => {});
    const descendant = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"
    ], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    descendant.on('message', () => {
      writeFileSync(process.argv[1], JSON.stringify([process.pid, descendant.pid]));
      console.log('hanging fixture ready');
      console.error('descendant ignores SIGTERM');
    });
    setInterval(() => {}, 1000);
  `;
  const result = processes.run(["-e", script, marker], "hanging fixture")
    .then(() => null, (error) => error);
  try {
    let pids;
    const deadline = Date.now() + 4000;
    while (!pids && Date.now() < deadline) {
      try { pids = JSON.parse(await readFile(marker, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!pids) await delay(10);
    }
    assert.ok(pids, "both owned processes reached their SIGTERM-resistant wait");
    assert.equal(await alive(pids[0]), true);
    assert.equal(await alive(pids[1]), true);
    controller.abort();
    const failure = await result;
    assert.match(failure.message, /Aborted hanging fixture/);
    assert.equal(failure.signal, "SIGKILL");
    assert.equal(await alive(pids[0]), false, "direct child was reaped");
    assert.equal(await alive(pids[1]), false, "owned descendant stopped");
    assert.match(diagnostics.join("\n"), /hanging fixture ready/);
    assert.match(diagnostics.join("\n"), /descendant ignores SIGTERM/);
    await assert.rejects(processes.run(["-e", "process.exit(0)"]), /aborted/);
  } finally {
    await processes.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed build diagnostics retain bounded stdout and stderr tails", { timeout: 5000 }, async (t) => {
  const processes = recorderBuildProcesses(t.signal);
  try {
    await assert.rejects(processes.run(["-e", `
      process.stdout.write('x'.repeat(100000) + 'STDOUT-END');
      process.stderr.write('y'.repeat(100000) + 'STDERR-END');
      process.exitCode = 7;
    `], "noisy fixture"), (error) => {
      assert.equal(error.code, 7);
      assert.match(error.message, /STDOUT-END/);
      assert.match(error.message, /STDERR-END/);
      assert.ok(error.message.length < 17000, "output tails stay bounded");
      return true;
    });
  } finally {
    await processes.close();
  }
});
