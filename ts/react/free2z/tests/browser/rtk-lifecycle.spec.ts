import { expect, test } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import webpack from "webpack";

let bundle: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const mock = path.join(root, "tests/browser/rtk-sdk-mock.jsx");
  const out = path.join(root, "test-results/rtk-harness");
  mkdirSync(out, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const compiler = webpack({
      mode: "development",
      entry: path.join(root, "tests/browser/rtk-harness.jsx"),
      output: { path: out, filename: "harness.js" },
      devtool: false,
      resolve: {
        extensions: [".tsx", ".ts", ".jsx", ".js"],
        alias: {
          "@cloudflare/realtimekit-react$": mock,
          "@cloudflare/realtimekit-react-ui$": mock,
          [path.join(root, "src/state/global")]: mock,
          [path.join(root, "src/hooks/useTransitionNavigate")]: mock,
        },
      },
      module: {
        rules: [
          {
            test: /\.[jt]sx?$/,
            exclude: /node_modules/,
            use: {
              loader: require.resolve("babel-loader"),
              options: {
                babelrc: false,
                configFile: false,
                presets: [
                  [
                    require.resolve("@babel/preset-react"),
                    { runtime: "automatic" },
                  ],
                  require.resolve("@babel/preset-typescript"),
                ],
              },
            },
          },
        ],
      },
    });
    compiler.run((err, stats) =>
      compiler.close(() =>
        err || stats?.hasErrors()
          ? reject(
              err || new Error(stats?.toString({ all: false, errors: true }))
            )
          : resolve()
      )
    );
  });
  bundle = readFileSync(path.join(out, "harness.js"), "utf8");
});

test("classic wrapper retains the room during reconnect and releases lifecycle listeners", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/__rtk_contract", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="root"></div><script src="/__rtk_contract.js"></script>',
    })
  );
  await page.route("**/__rtk_contract.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: bundle })
  );
  await page.goto("/__rtk_contract");
  await expect(
    page.getByTestId("meeting-boundary"),
    errors.join("\n")
  ).toBeVisible();
  await page.evaluate(() => (window as any).rtkContract.emit("roomJoined"));
  await page.evaluate(() =>
    (window as any).rtkContract.emit("roomLeft", { state: "disconnected" })
  );
  expect(
    await page.evaluate(() => (window as any).rtkContract.navigate)
  ).toEqual([]);
  await page.evaluate(() => (window as any).rtkContract.emit("roomJoined"));
  expect(
    await page.evaluate(() => (window as any).rtkContract.uiLeaveOnUnmount)
  ).toBe(false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.dispatchEvent(new Event("pagehide"));
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).rtkContract.leaves))
    .toBe(1);
  await page.evaluate(() =>
    (window as any).rtkContract.emit("roomLeft", { state: "left" })
  );
  await page.evaluate(() =>
    (window as any).rtkContract.emit("roomLeft", { state: "ended" })
  );
  expect(
    await page.evaluate(() => (window as any).rtkContract.navigate)
  ).toEqual(["/profile", "/profile"]);
  await page.evaluate(() => (window as any).rtkRoot.unmount());
  await page.evaluate(() => {
    (window as any).rtkContract.emit("roomLeft", { state: "ended" });
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(
    await page.evaluate(() => (window as any).rtkContract.navigate)
  ).toEqual(["/profile", "/profile"]);
  expect(await page.evaluate(() => (window as any).rtkContract.leaves)).toBe(1);
  // A fresh meeting effect also releases on unmount without a pagehide event.
  await page.evaluate(() => (window as any).mountRtk());
  await expect(page.getByTestId("meeting-boundary")).toBeVisible();
  await page.evaluate(() => (window as any).rtkRoot.unmount());
  await expect
    .poll(() => page.evaluate(() => (window as any).rtkContract.leaves))
    .toBe(2);
  // A provider UI leave event also suppresses a second leave during unmount.
  await page.evaluate(() => (window as any).mountRtk());
  await expect(page.getByTestId("meeting-boundary")).toBeVisible();
  await page.evaluate(async () => {
    await (window as any).rtkContract.meeting.leave();
    (window as any).rtkContract.emit("roomLeft", { state: "left" });
    (window as any).rtkRoot.unmount();
  });
  expect(await page.evaluate(() => (window as any).rtkContract.leaves)).toBe(3);
  // A failed media join is not a completed teardown: Core does not release
  // captured media for it, so unmount must still leave exactly once.
  await page.evaluate(() => (window as any).mountRtk());
  await expect(page.getByTestId("meeting-boundary")).toBeVisible();
  await page.evaluate(() => {
    (window as any).rtkContract.emit("roomLeft", { state: "failed" });
    (window as any).rtkRoot.unmount();
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).rtkContract.leaves))
    .toBe(4);
});

test("published Core 2.0.3 surfaces a mocked participant-token rejection before join", async ({
  page,
}) => {
  let attempts = 0;
  await page.routeWebSocket(
    /wss:\/\/[^/]*realtime\.cloudflare\.com\//,
    (socket) => socket.close()
  );
  await page.route("https://api.realtime.cloudflare.com/**", (route) => {
    attempts++;
    return route.fulfill({ status: 401, body: "" });
  });
  await page.route("**/__rtk_sdk.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: readFileSync(
        path.join(
          process.cwd(),
          "node_modules/@cloudflare/realtimekit/dist/browser.js"
        ),
        "utf8"
      ),
    })
  );
  await page.route("**/__rtk_init", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<script src="/__rtk_sdk.js"></script>',
    })
  );
  await page.goto("/__rtk_init");
  const failure = await page.evaluate(async () => {
    const encode = (data: object) =>
      btoa(JSON.stringify(data))
        .replaceAll("=", "")
        .replaceAll("+", "-")
        .replaceAll("/", "_");
    const token = [
      encode({ alg: "none" }),
      encode({
        meetingId: crypto.randomUUID(),
        orgId: crypto.randomUUID(),
        participantId: crypto.randomUUID(),
      }),
      "fake",
    ].join(".");
    try {
      await (window as any).RealtimeKitClient.init({ authToken: token });
      return null;
    } catch (error) {
      return { code: (error as any).code, message: (error as Error).message };
    }
  });
  expect(attempts).toBe(1);
  expect(failure?.code).toBe("0004");
  expect(failure?.message).toContain("Unauthorized");
});
