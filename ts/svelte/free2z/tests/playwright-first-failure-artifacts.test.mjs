import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import FirstFailureArtifactsReporter from "./browser/first-failure-artifacts-reporter.mjs";

const scratchRoot = join(tmpdir(), "tuzi-2573-d1521887-first-failure-");

function testCase(id, title = "owned auth expiry") {
  return {
    id,
    titlePath: () => ["billing", title],
  };
}

async function captureResult({ scratch, id, status, retry, title }) {
  const outputDir = join(scratch, "test-results");
  const attemptDir = join(outputDir, `test-attempt-${retry}`);
  const trace = join(attemptDir, "trace.zip");
  const context = join(attemptDir, "error-context.md");
  await mkdir(attemptDir, { recursive: true });
  await writeFile(trace, `${status} attempt trace bytes`);
  await writeFile(context, `${status} attempt error context`);

  const reporter = new FirstFailureArtifactsReporter();
  reporter.onBegin({ projects: [{ outputDir }] });
  const result = {
    status,
    retry,
    attachments: [
      { name: "trace", contentType: "application/zip", path: trace },
      {
        name: "error-context",
        contentType: "text/markdown",
        path: context,
      },
    ],
  };

  // The runner dispatches this callback without awaiting its return value.
  // Remove the source immediately after it returns to prove retention is done.
  const test = testCase(id, title);
  assert.equal(reporter.onTestEnd(test, result), undefined);
  await rm(attemptDir, { recursive: true });
  assert.equal(
    reporter.onTestEnd(test, { status: "passed", retry: 1, attachments: [] }),
    undefined,
  );
  const end = await reporter.onEnd({ status: "passed" });

  return { end, outputDir };
}

test("first failed attempt attachments survive source cleanup and a passing retry", async () => {
  const scratch = await mkdtemp(scratchRoot);
  try {
    const { end, outputDir } = await captureResult({
      scratch,
      id: "stable-playwright-test-id",
      status: "failed",
      retry: 0,
    });
    assert.equal(end, undefined);

    const retainedDir = join(outputDir, "first-failures");
    const id = createHash("sha256")
      .update("stable-playwright-test-id")
      .digest("hex")
      .slice(0, 16);
    const retained = join(retainedDir, `${id}-attempt-0`);
    assert.equal(
      await readFile(join(retained, "trace.zip"), "utf8"),
      "failed attempt trace bytes",
    );
    assert.equal(
      await readFile(join(retained, "error-context.md"), "utf8"),
      "failed attempt error context",
    );
    const manifest = JSON.parse(
      await readFile(join(retained, "manifest.json"), "utf8"),
    );
    assert.deepEqual(manifest, {
      test: ["billing", "owned auth expiry"],
      status: "failed",
      retry: 0,
      attachments: [
        { name: "trace.zip", contentType: "application/zip" },
        { name: "error-context.md", contentType: "text/markdown" },
      ],
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("first-attempt timeouts survive a later passing retry", async () => {
  const scratch = await mkdtemp(scratchRoot);
  try {
    const { end, outputDir } = await captureResult({
      scratch,
      id: "timed-out-playwright-test-id",
      status: "timedOut",
      retry: 0,
      title: "viewer hydration timeout",
    });
    assert.equal(end, undefined);

    const id = createHash("sha256")
      .update("timed-out-playwright-test-id")
      .digest("hex")
      .slice(0, 16);
    const retained = join(outputDir, "first-failures", `${id}-attempt-0`);
    assert.equal(
      await readFile(join(retained, "trace.zip"), "utf8"),
      "timedOut attempt trace bytes",
    );
    const manifest = JSON.parse(
      await readFile(join(retained, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.status, "timedOut");
    assert.equal(manifest.retry, 0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("passing attempts and failures after retry do not create first-failure artifacts", async () => {
  const scratch = await mkdtemp(scratchRoot);
  try {
    const outputDir = join(scratch, "test-results");
    const source = join(scratch, "trace.zip");
    await writeFile(source, "trace");
    const reporter = new FirstFailureArtifactsReporter();
    reporter.onBegin({ projects: [{ outputDir }] });
    const test = testCase("not-first-failure", "control");

    assert.equal(
      reporter.onTestEnd(test, {
        status: "passed",
        retry: 0,
        attachments: [{ name: "trace", path: source }],
      }),
      undefined,
    );
    assert.equal(
      reporter.onTestEnd(test, {
        status: "failed",
        retry: 1,
        attachments: [{ name: "trace", path: source }],
      }),
      undefined,
    );
    assert.equal(await reporter.onEnd({ status: "passed" }), undefined);
    await assert.rejects(readFile(join(outputDir, "first-failures")), {
      code: "ENOENT",
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("retention failures are recorded and fail an otherwise passing run", async () => {
  const scratch = await mkdtemp(scratchRoot);
  const originalError = console.error;
  const reported = [];
  console.error = (message) => reported.push(message);
  try {
    const outputDir = join(scratch, "test-results");
    const reporter = new FirstFailureArtifactsReporter();
    reporter.onBegin({ projects: [{ outputDir }] });
    reporter.onTestEnd(testCase("missing-attachment", "copy failure"), {
      status: "timedOut",
      retry: 0,
      attachments: [
        { name: "trace", path: join(scratch, "source-was-removed.zip") },
      ],
    });

    const end = await reporter.onEnd({ status: "passed" });
    assert.deepEqual(end, { status: "failed" });
    const errors = JSON.parse(
      await readFile(
        join(outputDir, "first-failures", "retention-errors.json"),
        "utf8",
      ),
    );
    assert.equal(errors[0].test.join(" › "), "billing › copy failure");
    assert.match(errors[0].error, /ENOENT/);
    assert.match(
      reported[0],
      /First-attempt browser diagnostics could not be retained/,
    );
  } finally {
    console.error = originalError;
    await rm(scratch, { recursive: true, force: true });
  }
});
