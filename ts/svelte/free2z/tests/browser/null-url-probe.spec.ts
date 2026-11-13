import { expect, test, type Browser } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";

test.describe.configure({ timeout: 90_000 });
const UA = "Googlebot/2.1 (+http://www.google.com/bot.html)"; // controlled public token
const paths = ["/", "/profile", "/profile/article", "/converse/thread"];

async function fixture(testInfo: { outputPath: (name: string) => string }) {
  const counts = {
    http: 0,
    posts: 0,
    upgrades: 0,
    messages: 0,
    workerScripts: 0,
    events: 0,
  };
  const sockets = new Set<Duplex>();
  const modes = ["ready", "ready", "ready", "ready"];
  let port = 0;
  const server = createServer((req, res) => {
    counts.http++;
    if (req.method === "POST") counts.posts++;
    if (req.url === "/worker.js") counts.workerScripts++;
    if (req.url === "/events") counts.events++;
    const mode = modes[paths.indexOf(req.url || "")];
    res.setHeader("content-type", "text/html");
    // The result is genuinely introduced by a working client event handler.
    // Inert/stalled pages have identical 200 SSR and no uncaught errors.
    res.end(`<!doctype html><body><button type="button" class="probe-trigger">Open</button>
      <a href="/search?q=null">null</a><script type="application/json">{"url":null}</script>
      ${mode === "static" ? '<div class="probe-ready">Static SSR result</div>' : ""}
      <script>
      const ready = () => document.querySelector('button').addEventListener('click', () => {
        if (!document.querySelector('.probe-ready')) {
          const result = document.createElement('div'); result.className = 'probe-ready';
          result.textContent = 'Client result'; document.body.append(result);
        }
      });
      ${mode === "inert" ? "" : mode === "stalled" ? "new Promise(() => {}).then(ready);" : "ready();"}
      try {
        ${mode === "WebSocket" ? `const ws = new WebSocket('ws://127.0.0.1:${port}/socket'); ws.onopen = () => ws.send('control');` : ""}
        ${mode === "WebTransport" ? `new WebTransport('https://127.0.0.1:${port}/transport');` : ""}
        ${mode === "RTCPeerConnection" ? "const pc = new RTCPeerConnection(); pc.createDataChannel('control');" : ""}
        ${mode === "Worker" ? "new Worker('/worker.js');" : ""}
        ${mode === "SharedWorker" ? "new SharedWorker('/worker.js');" : ""}
        ${mode === "EventSource" ? "new EventSource('/events');" : ""}
        ${mode === "sendBeacon" ? "navigator.sendBeacon('/beacon', 'control');" : ""}
        ${mode === "serviceWorker" ? "navigator.serviceWorker.register('/worker.js').catch(() => {});" : ""}
      } catch {}
      ${mode === "null" ? 'setTimeout(() => { const image = new Image(); image.src = "null"; document.body.append(image); }, 100);' : ""}
      </script></body>`);
  });
  // Actual WebSocket endpoint, using only Node built-ins. It accepts a short
  // masked text frame; no production host, TLS weakening or new dependency.
  server.on("upgrade", (req, socket) => {
    counts.upgrades++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const accept = createHash("sha1")
      .update(
        String(req.headers["sec-websocket-key"]) +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (frame: Buffer) => {
      if ((frame[0] & 0x0f) === 1) counts.messages++;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  const readinessFile = testInfo.outputPath("readiness.json");
  await writeFile(
    readinessFile,
    JSON.stringify(
      paths.map(() => ({
        selector: ".probe-ready",
        trigger: ".probe-trigger",
      })),
    ),
  );
  const command = [
    "scripts/probe-null-urls.mjs",
    "--origin",
    `http://127.0.0.1:${port}`,
    "--readiness-file",
    readinessFile,
    "--readiness-timeout-ms",
    "300",
    ...paths.flatMap((path) => ["--path", path]),
  ];
  const run = async (ua = UA) => {
    try {
      const result = await promisify(execFile)(process.execPath, command, {
        env: { ...process.env, FREE2Z_PROBE_USER_AGENT: ua },
        timeout: 60_000,
      });
      return { code: 0, report: JSON.parse(result.stdout) };
    } catch (error) {
      const failure = error as { code: number; stdout: string };
      return {
        code: failure.code,
        report: failure.stdout ? JSON.parse(failure.stdout) : undefined,
      };
    }
  };
  return {
    counts,
    modes,
    command,
    run,
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("CLI: actual client readiness succeeds; delayed null URL and missing configuration fail", async ({}, testInfo) => {
  const f = await fixture(testInfo);
  try {
    const good = await f.run();
    expect(good.code).toBe(0);
    expect(good.report.renders).toHaveLength(8);
    expect(
      good.report.renders.filter(
        (r: any) => r.phase === "client-ready-scrolled",
      ),
    ).toHaveLength(4);
    expect(
      good.report.renders
        .filter((r: any) => r.phase === "client-ready-scrolled")
        .every((r: any) => r.readiness.status === "observed" && !r.incomplete),
    ).toBe(true);
    const before = f.counts.http;
    expect((await f.run("")).code).toBe(2);
    expect(f.counts.http).toBe(before);
    const readinessIndex = f.command.indexOf("--readiness-file");
    const removed = f.command.splice(readinessIndex, 2);
    expect((await f.run()).code).toBe(2);
    expect(f.counts.http).toBe(before);
    f.command.splice(readinessIndex, 0, ...removed);
    f.modes[2] = "null";
    const bad = await f.run();
    expect(bad.code).toBe(1);
    expect(
      bad.report.renders.some((r: any) => r.badRequests?.includes("image")),
    ).toBe(true);
    expect(JSON.stringify(bad.report)).not.toContain("/profile/article");
    await testInfo.attach("null-probe-control", {
      body: JSON.stringify({
        control: "ready-and-null",
        readyRenders: 4,
        goodExit: good.code,
        nullExit: bad.code,
      }),
      contentType: "application/json",
    });
  } finally {
    await f.close();
  }
});

for (const mode of ["inert", "stalled", "static"]) {
  test(`CLI: ${mode} 200 response cannot be accepted as client-ready`, async ({}, testInfo) => {
    const f = await fixture(testInfo);
    try {
      f.modes.fill(mode);
      const result = await f.run();
      expect(result.code).toBe(1);
      expect(
        result.report.renders.filter((r: any) => r.phase === "ssr-no-js"),
      ).toHaveLength(4);
      const clients = result.report.renders.filter(
        (r: any) => r.javaScriptEnabled,
      );
      expect(clients).toHaveLength(4);
      expect(
        clients.every(
          (r: any) =>
            r.incomplete &&
            r.status === 200 &&
            r.readiness.status !== "observed",
        ),
      ).toBe(true);
      await testInfo.attach("null-probe-control", {
        body: JSON.stringify({
          control: mode,
          exit: result.code,
          independentSsrRenders: 4,
          incompleteClientRenders: clients.length,
        }),
        contentType: "application/json",
      });
    } finally {
      await f.close();
    }
  });
}

test("CLI: real WebSocket endpoint receives zero connections/frames; other available transports fail closed", async ({
  browser,
}, testInfo) => {
  const f = await fixture(testInfo);
  let control: Awaited<ReturnType<Browser["newContext"]>> | undefined;
  try {
    f.modes[0] = "WebSocket";
    // Positive control proves the endpoint and the page's real socket send.
    control = await browser.newContext();
    const page = await control.newPage();
    await page.goto(f.origin);
    await expect.poll(() => f.counts.messages).toBeGreaterThan(0);
    const positiveMessages = f.counts.messages;
    expect(await page.evaluate(() => typeof WebTransport)).toBe("function");
    expect(await page.evaluate(() => typeof RTCPeerConnection)).toBe(
      "function",
    );
    await control.close();
    control = undefined;
    f.counts.upgrades = 0;
    f.counts.messages = 0;
    f.modes.splice(
      0,
      4,
      "WebSocket",
      "WebTransport",
      "RTCPeerConnection",
      "Worker",
    );
    const result = await f.run();
    expect(result.code).toBe(1);
    const clients = result.report.renders.filter(
      (r: any) => r.javaScriptEnabled,
    );
    expect(clients).toHaveLength(4);
    for (const [index, kind] of f.modes.entries())
      expect(clients[index].blockedTransports[kind]).toBeGreaterThan(0);
    expect(clients.every((r: any) => r.incomplete)).toBe(true);
    expect(f.counts.upgrades).toBe(0);
    expect(f.counts.messages).toBe(0);
    expect(f.counts.workerScripts).toBe(0);
    f.modes.splice(
      0,
      4,
      "SharedWorker",
      "EventSource",
      "sendBeacon",
      "serviceWorker",
    );
    const more = await f.run();
    expect(more.code).toBe(1);
    const denied = more.report.renders.filter((r: any) => r.javaScriptEnabled);
    for (const [index, kind] of f.modes.entries())
      expect(denied[index].blockedTransports[kind]).toBeGreaterThan(0);
    expect(f.counts.posts).toBe(0);
    expect(f.counts.events).toBe(0);
    expect(f.counts.workerScripts).toBe(0);
    await testInfo.attach("null-probe-control", {
      body: JSON.stringify({
        control: "transports",
        positiveWebSocketMessages: positiveMessages,
        guardedCounts: f.counts,
        exit: [result.code, more.code],
        deniedKinds: [
          ...new Set(
            [...clients, ...denied].flatMap((r: any) =>
              Object.keys(r.blockedTransports),
            ),
          ),
        ].sort(),
      }),
      contentType: "application/json",
    });
  } finally {
    await control?.close();
    await f.close();
  }
});
