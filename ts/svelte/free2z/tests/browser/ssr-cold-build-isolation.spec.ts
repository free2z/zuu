import { expect, test } from "@playwright/test";
import { fork, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { browserMockApiOrigin } from "./ports";

test.skip(process.env.FREE2Z_PILOT_TEST !== "1", "requires pilot test server");
function message(child: ChildProcess, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: any) => {
      if (value?.type === type) {
        child.off("exit", onExit);
        child.off("message", onMessage);
        resolve();
      }
    };
    const onExit = () => reject(new Error(`server exited before ${type}`));
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  if (child.connected) child.send({ type: "stop" });
  else child.kill("SIGTERM");
  await exited;
}

test("cold Arabic request survives concurrent production generated-tree sync", async ({
  request,
}) => {
  test.setTimeout(90_000);
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = fork(
    "node_modules/vite/bin/vite.js",
    ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: {
        ...process.env,
        FREE2Z_BROWSER_TEST: "1",
        FREE2Z_BROWSER_OUTPUT_NAME: "",
        FREE2Z_PILOT_TEST: "1",
        FREE2Z_SSR_BOUNDARY_CONTROL: "1",
        VITE_API_PROXY_TARGET: browserMockApiOrigin(),
        PRIVATE_API_BASE_URL: browserMockApiOrigin(),
      },
    },
  );
  try {
    await message(child, "boundary-ready");
    const held = message(child, "boundary-held");
    const response = request.get(`http://127.0.0.1:${port}/login?lang=ar`);
    await held;
    const sourcePath = "src/lib/i18n.ts";
    const original = await readFile(sourcePath);
    const env = { ...process.env };
    delete env.FREE2Z_BROWSER_TEST;
    delete env.FREE2Z_PILOT_TEST;
    delete env.FREE2Z_SSR_BOUNDARY_CONTROL;
    const invalidated =
      process.env.FREE2Z_EXPECT_INVALIDATION === "1"
        ? message(child, "source-invalidated")
        : null;
    const probe = Buffer.concat([
      original,
      Buffer.from("\n// Controlled SSR source-change probe.\n"),
    ]);
    let wroteProbe = false;
    try {
      await writeFile(sourcePath, probe);
      wroteProbe = true;
      if (invalidated) await invalidated;
      await promisify(execFile)(
        process.execPath,
        ["node_modules/@sveltejs/kit/svelte-kit.js", "sync"],
        { env, timeout: 30000 },
      );
    } finally {
      if (wroteProbe) {
        if (!(await readFile(sourcePath)).equals(probe))
          throw new Error(
            "Source changed during the probe; preserved without restoring",
          );
        await writeFile(sourcePath, original);
      }
    }
    child.send({ type: "release" });
    const result = await response;
    expect(result.status()).toBe(200);
    expect(existsSync(`.svelte-kit-test-${child.pid}`)).toBe(true);
    expect(await result.text()).toContain('<html lang="ar" dir="rtl">');
  } finally {
    await stop(child);
  }
  expect(existsSync(`.svelte-kit-test-${child.pid}`)).toBe(false);
});
