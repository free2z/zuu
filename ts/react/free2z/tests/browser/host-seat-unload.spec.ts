import { expect, test } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import path from "node:path";
import webpack from "webpack";

let bundle: string;

// Delay delivery outside the browser's request interception machinery. An
// intercepted keepalive request can lose its document before Playwright invokes
// the route handler. This proxy instead observes real connection cancellation:
// only a connection that survives navigation delivers its buffered release.
async function delayedReleaseProxy(targetPort: number) {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closing = false;
  const proxy = createTcpServer((client) => {
    if (closing) return client.destroy();
    const upstream = connect(targetPort, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    let buffer = Buffer.alloc(0);
    let delayed = false;
    let ended = false;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    const retire = () => {
      ended = true;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        timers.delete(pendingTimer);
      }
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    for (const socket of [client, upstream]) {
      socket.on("error", retire);
      socket.on("end", retire);
      socket.on("close", retire);
    }
    upstream.pipe(client);

    // The fixture sends HTTP/1.1 GETs and bounded JSON POSTs with Content-Length.
    // Preserve frame order if a subsequent request shares the same connection.
    const forward = () => {
      while (!ended && !delayed) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const headers = buffer.subarray(0, headerEnd).toString();
        const length = Number(headers.match(/content-length: (\d+)/i)?.[1] || 0);
        if (/transfer-encoding:/i.test(headers) || length > 65_536) return retire();
        const end = headerEnd + 4 + length;
        if (buffer.length < end) return;
        const frame = buffer.subarray(0, end);
        buffer = buffer.subarray(end);
        let release = false;
        if (headers.startsWith("POST /api/dyte/Alice/host-session ")) {
          try {
            release =
              JSON.parse(frame.subarray(headerEnd + 4).toString()).action ===
              "release";
          } catch {
            return retire();
          }
        }
        if (release) {
          delayed = true;
          const timer = setTimeout(() => {
            timers.delete(timer);
            pendingTimer = undefined;
            delayed = false;
            if (!ended) {
              upstream.write(frame);
              forward();
            }
          }, 250);
          pendingTimer = timer;
          timers.add(timer);
        } else upstream.write(frame);
      }
    };
    client.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 65_536) return retire();
      forward();
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (proxy.address() as AddressInfo).port,
    close: async () => {
      closing = true;
      // Stop accepting before destroying connections, including late keepalive
      // cleanup requests. Reversing this order can strand server.close().
      const closed = new Promise<void>((resolve) => proxy.close(() => resolve()));
      timers.forEach(clearTimeout);
      sockets.forEach((socket) => socket.destroy());
      await closed;
    },
  };
}

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
      let proxy: Awaited<ReturnType<typeof delayedReleaseProxy>> | undefined;
      let failed = false;
      try {
        proxy = await delayedReleaseProxy(
          (server.address() as AddressInfo).port
        );
        const origin = `http://127.0.0.1:${proxy.port}`;
        await test.step("Start the original host seat", async () => {
          await page.goto(`${origin}/host?surface=${surface}`);
          await expect
            .poll(() => page.evaluate(() => (window as any).hostContract.ready))
            .toBe(true);
          expect(starts).toHaveLength(1);
        });
        const oldSession = starts[0];
        // The TCP proxy delays release bytes before the real HTTP server can
        // receive them. No browser request interception participates in unload.
        await test.step("Unload the host document", async () => {
          if (exit === "reload") {
            await page.reload();
          } else {
            await page.evaluate(() => {
              (window as any).hostContract.close();
              window.location.href = "/away";
            });
            await page.waitForURL(`${origin}/away`);
          }
        });
        await test.step("Receive the exact authenticated release", async () => {
          await expect
            .poll(() => releases)
            .toContainEqual({ session: oldSession, authenticated: true });
        });
        // Reload can race a still-in-flight release; once received, a fresh
        // intent must start immediately, without waiting for lease expiry.
        await test.step("Start a fresh seat after the release", async () => {
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
        });
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        try {
          try {
            await test.step("Leave the final host document", () =>
              page.goto("about:blank")
            );
          } finally {
            await test.step("Close the owned TCP and HTTP listeners", async () => {
              const closed = new Promise<void>((resolve) =>
                server.close(() => resolve())
              );
              await proxy?.close();
              server.closeAllConnections();
              await closed;
            });
          }
        } catch (error) {
          if (!failed) throw error;
          // Preserve the original behavioral failure if cleanup also fails.
          test.info().annotations.push({
            type: "cleanup_failure",
            description: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
  }
}
