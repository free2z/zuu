import { expect, test } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import webpack from "webpack";

let bundle: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const out = path.join(root, "test-results/host-seat-unload");
  mkdirSync(out, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const compiler = webpack({
      mode: "development",
      entry: path.join(root, "tests/browser/host-seat-unload-harness.ts"),
      output: { path: out, filename: "harness.js" },
      devtool: false,
      // This contract exercises the native app's browser transport only.
      plugins: [
        new webpack.DefinePlugin({
          "import.meta.env": JSON.stringify({ DEV: true }),
        }),
      ],
      resolve: {
        extensions: [".ts", ".js"],
        alias: { "@tauri-apps/plugin-http": false },
      },
      module: {
        rules: [
          {
            test: /\.ts$/,
            exclude: /node_modules/,
            use: {
              loader: require.resolve("babel-loader"),
              options: {
                babelrc: false,
                configFile: false,
                presets: [require.resolve("@babel/preset-typescript")],
              },
            },
          },
        ],
      },
    });
    compiler.run((error, stats) =>
      compiler.close(() => {
        if (error || stats?.hasErrors())
          reject(
            error || new Error(stats?.toString({ all: false, errors: true }))
          );
        else resolve();
      })
    );
  });
  bundle = readFileSync(path.join(out, "harness.js"), "utf8");
});

for (const surface of ["classic", "native"] as const) {
  for (const exit of ["reload", "close-then-navigate"] as const) {
    test(`${surface} exact-seat release reaches the server during real ${exit}`, async ({
      page,
      context,
    }) => {
      let held: string | null = null;
      const starts: string[] = [];
      const releases: Array<{ session: string; authenticated: boolean }> = [];
      const server: Server = createServer((req, res) => {
        const url = new URL(req.url!, "http://localhost");
        if (req.method === "GET") {
          res.setHeader("Cache-Control", "no-store");
          if (url.pathname === "/harness.js") {
            res.setHeader("Content-Type", "application/javascript");
            res.end(bundle);
          } else if (url.pathname === "/host") {
            if (surface === "classic")
              res.setHeader("Set-Cookie", [
                "sessionid=synthetic-owner; Path=/; SameSite=Lax",
                "csrftoken=synthetic-csrf; Path=/; SameSite=Lax",
              ]);
            res.setHeader("Content-Type", "text/html");
            res.end('<script src="/harness.js"></script>');
          } else res.end("Away from the host document");
          return;
        }
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          const body = JSON.parse(raw);
          const authenticated =
            surface === "classic"
              ? !!req.headers.cookie?.includes("sessionid=synthetic-owner") &&
                req.headers["x-csrftoken"] === "synthetic-csrf"
              : req.headers.authorization === "Token synthetic-native-owner";
          res.setHeader("Content-Type", "application/json");
          if (!authenticated) {
            res.writeHead(403).end("{}");
            return;
          }
          if (body.role === "host") {
            if (held && held !== body.host_session) {
              res
                .writeHead(409)
                .end(JSON.stringify({ code: "already_live_elsewhere" }));
              return;
            }
            held = body.host_session;
            starts.push(held!);
            res.end(
              JSON.stringify({
                host_session: held,
                auth_token: "synthetic-provider-token",
              })
            );
          } else if (body.action === "release") {
            releases.push({ session: body.host_session, authenticated });
            if (held === body.host_session) held = null;
            res.end("{}");
          } else res.end("{}");
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
      );
      const origin = `http://127.0.0.1:${
        (server.address() as AddressInfo).port
      }`;
      try {
        await page.goto(`${origin}/host?surface=${surface}`);
        await expect
          .poll(() => page.evaluate(() => (window as any).hostContract.ready))
          .toBe(true);
        expect(starts).toHaveLength(1);
        const oldSession = starts[0];
        // Delay the release before network delivery. The destination is a real
        // local HTTP server; a mocked response cannot satisfy the receipt check.
        await context.route(
          `${origin}/api/dyte/Alice/host-session`,
          async (route) => {
            if (route.request().postDataJSON()?.action === "release")
              await new Promise((resolve) => setTimeout(resolve, 250));
            await route.continue().catch(() => {});
          }
        );
        if (exit === "reload") {
          await page.reload();
        } else {
          await page.evaluate(() => {
            (window as any).hostContract.close();
            window.location.href = "/away";
          });
          await page.waitForURL(`${origin}/away`);
        }
        await expect
          .poll(() => releases)
          .toContainEqual({ session: oldSession, authenticated: true });
        // Reload can race a still-in-flight release; once received, a fresh
        // intent must start immediately, without waiting for lease expiry.
        if (exit === "reload")
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  (window as any).hostContract.ready ||
                  (window as any).hostContract.error
              )
            )
            .toBe(true);
        if (
          exit !== "reload" ||
          !(await page.evaluate(() => (window as any).hostContract.ready))
        )
          await page.goto(`${origin}/host?surface=${surface}`);
        await expect
          .poll(() => page.evaluate(() => (window as any).hostContract.ready))
          .toBe(true);
        expect(starts.at(-1)).not.toBe(oldSession);
        expect(held).toBe(starts.at(-1));
      } finally {
        await page.goto("about:blank");
        await context.unrouteAll({ behavior: "wait" });
          // Assertions above cover the release receipt. Shutdown must also
          // close a final navigation's partially dispatched cleanup request.
          server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
}
