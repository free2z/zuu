import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { stop } from "esbuild";

const [script, output, mode] = process.argv.slice(2);
const children = [];
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  if (args[0].endsWith("/esbuild") || args[0].endsWith("\\esbuild.exe")) {
    children.push(child);
  }
  return child;
};
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
try {
  // Run the actual direct-entrypoint branch, while retaining the probe long
  // enough to observe compiler cleanup before process exit could hide a leak.
  process.argv[1] = mode === "exported" ? "importing-build-recorder" : script;
  process.argv[2] = output;
  let failure;
  let builder;
  try {
    builder = await import(pathToFileURL(script));
  } catch (error) {
    failure = error;
  }
  if (mode === "error") {
    assert.match(
      failure?.message ?? "",
      /Existing recorder generation is incomplete/,
    );
  } else {
    assert.ifError(failure);
  }
  if (mode === "exported") {
    await builder.buildRecorder(output);
    assert.equal(children.length, 1, "a real compiler service was started");
    assert.equal(
      exited(children[0]),
      false,
      "the importing caller owns the service",
    );
    await builder.buildRecorder(output);
    assert.equal(
      children.length,
      1,
      "repeated builds reuse the caller's service",
    );
    assert.equal(exited(children[0]), false);
  } else {
    assert.equal(children.length, 1, "a real compiler service was started");
    const deadline = Date.now() + 2_000;
    while (!children.every(exited) && Date.now() < deadline) await delay(10);
    assert.ok(
      children.every(exited),
      "the CLI must stop its compiler before returning",
    );
  }
} finally {
  childProcess.spawn = spawn;
  // Test cleanup runs after the assertions, so it cannot make them pass.
  await stop();
}
