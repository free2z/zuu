import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { once } from "node:events";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function rawRequest(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.once("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy(
        new Error(`request exceeded the harness's 15s bound: ${path}`),
      );
    });
    req.end();
  });
}

async function waitForAdapter(port, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`adapter exited before readiness (${child.exitCode})`);
    }
    try {
      if ((await rawRequest(port, "/healthz")).status === 200) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("adapter did not become ready within 15 seconds");
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function article(creator, vanity, free2zaddr) {
  return { creator: { username: creator }, vanity, free2zaddr };
}

const observed = [];
let timedOutLookupClosed = false;
let stalledErrorBodyClosed = false;
const backend = createServer((req, response) => {
  observed.push(req.url);

  if (req.url === "/api/zpage/broadcast/") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(article("alice", "broadcast", "collision-safe-address")),
    );
    return;
  }
  if (req.url === "/api/zpage/legacy-address/") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(article("real-owner", "pretty-name", "legacy-address")),
    );
    return;
  }
  if (req.url === "/api/zpage/kyc/") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(article("profile", "kyc", "profile-safe")));
    return;
  }
  if (req.url === "/api/zpage/gated/") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        show_modal: true,
        page: article("subscriber", "dashboard", "gated-safe"),
      }),
    );
    return;
  }
  if (req.url === "/api/zpage/missing/") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"detail":"Not found"}');
    return;
  }
  if (req.url === "/api/zpage/error/") {
    response.writeHead(502, { "content-type": "application/json" });
    response.end('{"detail":"upstream failed"}');
    return;
  }
  if (req.url === "/api/zpage/error-body-stall/") {
    response.writeHead(502, { "content-type": "application/json" });
    response.flushHeaders();
    response.once("close", () => {
      stalledErrorBodyClosed = true;
    });
    return;
  }
  if (req.url === "/api/zpage/busy/") {
    response.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "7",
    });
    response.end('{"detail":"slow down"}');
    return;
  }
  if (req.url === "/api/zpage/bad-json/") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("not json");
    return;
  }
  if (req.url === "/api/zpage/hang/") {
    response.once("close", () => {
      timedOutLookupClosed = true;
    });
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end('{"detail":"Not found"}');
});

const backendPort = await listen(backend);
const reservation = createServer();
const appPort = await listen(reservation);
await new Promise((resolve) => reservation.close(resolve));

let transcript = "";
const adapter = spawn(process.execPath, ["build"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(appPort),
    ORIGIN: `http://127.0.0.1:${appPort}`,
    PRIVATE_API_BASE_URL: `http://127.0.0.1:${backendPort}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
adapter.stdout.on("data", (chunk) => {
  transcript += chunk;
});
adapter.stderr.on("data", (chunk) => {
  transcript += chunk;
});
let missingBaseAdapter;

try {
  await waitForAdapter(appPort, adapter);

  const legacyPersonas = [
    [
      "cookieless",
      {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0",
      },
    ],
    [
      "crawler",
      {
        "user-agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    ],
    ["social", { "user-agent": "facebookexternalhit/1.1" }],
  ];
  for (const [persona, headers] of legacyPersonas) {
    for (const path of [
      "/alice/zpage/broadcast?probe=1502&lang=es",
      "/alice/zpage/broadcast/?probe=1502&lang=es",
    ]) {
      const collision = await rawRequest(appPort, path, headers);
      assert.equal(collision.status, 301, `${persona}: ${path}`);
      assert.equal(
        collision.headers.location,
        "/alice/collision-safe-address?probe=1502&lang=es",
        `${persona}: ${path}`,
      );
      assert.equal(
        collision.headers["cache-control"],
        "no-store",
        `${persona}: ${path}`,
      );
      assert.notEqual(
        collision.headers.location,
        "/article/broadcast?probe=1502&lang=es",
        `negative control: ${persona} ${path} must resolve identity, not derive the destination from the legacy slug`,
      );
    }
  }

  const address = await rawRequest(
    appPort,
    "/wrong-owner/zpage/legacy-address?from=historic",
  );
  assert.equal(address.status, 301);
  assert.equal(
    address.headers.location,
    "/real-owner/pretty-name?from=historic",
  );

  const reservedPair = await rawRequest(
    appPort,
    "/profile/zpage/kyc?probe=pair",
  );
  assert.equal(reservedPair.status, 301);
  assert.equal(
    reservedPair.headers.location,
    "/article/profile-safe?probe=pair",
  );

  const gated = await rawRequest(appPort, "/subscriber/zpage/gated");
  assert.equal(gated.status, 301);
  assert.equal(gated.headers.location, "/subscriber/gated-safe");

  const hostile = await rawRequest(
    appPort,
    "/alice/zpage/broadcast?probe=hostile",
    { Host: "attacker.example" },
  );
  assert.equal(hostile.status, 301);
  assert.equal(
    hostile.headers.location,
    "/alice/collision-safe-address?probe=hostile",
  );
  assert.doesNotMatch(hostile.headers.location, /attacker\.example/i);

  for (const slug of ["null", "undefined"]) {
    const response = await rawRequest(appPort, `/alice/zpage/${slug}`);
    assert.equal(response.status, 404, slug);
    assert.equal(response.headers.location, undefined, slug);
  }
  assert.equal(observed.includes("/api/zpage/null/"), false);
  assert.equal(observed.includes("/api/zpage/undefined/"), false);

  for (const [slug, expectedStatus] of [
    ["missing", 404],
    ["error", 503],
    ["bad-json", 503],
  ]) {
    const response = await rawRequest(appPort, `/alice/zpage/${slug}`);
    assert.equal(response.status, expectedStatus, slug);
    assert.equal(response.headers.location, undefined, slug);
  }

  const stalledErrorStarted = Date.now();
  const stalledError = await rawRequest(
    appPort,
    "/alice/zpage/error-body-stall",
  );
  assert.equal(stalledError.status, 503);
  assert.ok(
    Date.now() - stalledErrorStarted < 5_000,
    "error headers must produce a bounded answer without waiting for the body",
  );
  assert.equal(
    await waitFor(() => stalledErrorBodyClosed),
    true,
    "the adapter must cancel a non-OK body that stalls after its headers",
  );

  const busy = await rawRequest(appPort, "/alice/zpage/busy");
  assert.equal(busy.status, 429);
  assert.equal(busy.headers["retry-after"], "7");
  assert.equal(busy.headers["cache-control"], "no-store");

  const scannerHeaders = {
    "X-Forwarded-For": "198.51.100.17, 34.102.0.1",
  };
  const scannerWave = await Promise.all(
    Array.from({ length: 11 }, async (_, index) => ({
      index,
      response: await rawRequest(
        appPort,
        `/scanner/zpage/scan-${index}`,
        scannerHeaders,
      ),
    })),
  );
  assert.equal(
    scannerWave.filter(({ response }) => response.status === 404).length,
    10,
  );
  const refused = scannerWave.find(({ response }) => response.status === 429);
  assert.ok(refused, "one request beyond the 10-token burst must be refused");
  assert.equal(refused.response.headers["retry-after"], "1");
  assert.equal(refused.response.headers["cache-control"], "no-store");
  assert.equal(
    observed.includes(`/api/zpage/scan-${refused.index}/`),
    false,
    "the per-client bucket must refuse before the expensive resolver",
  );

  const timeoutStarted = Date.now();
  const timeout = await rawRequest(appPort, "/alice/zpage/hang");
  const timeoutElapsed = Date.now() - timeoutStarted;
  assert.equal(timeout.status, 503);
  assert.equal(timeout.headers.location, undefined);
  assert.ok(
    timeoutElapsed >= 9_000 && timeoutElapsed < 15_000,
    `lookup timeout must be bounded near 10s, observed ${timeoutElapsed}ms`,
  );
  assert.equal(timedOutLookupClosed, true);

  const scannerObserved = observed.filter((path) =>
    path.startsWith("/api/zpage/scan-"),
  );
  assert.equal(scannerObserved.length, 10);
  assert.deepEqual(
    observed.filter((path) => !path.startsWith("/api/zpage/scan-")),
    [
      ...Array(6).fill("/api/zpage/broadcast/"),
      "/api/zpage/legacy-address/",
      "/api/zpage/kyc/",
      "/api/zpage/gated/",
      "/api/zpage/broadcast/",
      "/api/zpage/missing/",
      "/api/zpage/error/",
      "/api/zpage/bad-json/",
      "/api/zpage/error-body-stall/",
      "/api/zpage/busy/",
      "/api/zpage/hang/",
    ],
  );

  const missingBaseReservation = createServer();
  const missingBasePort = await listen(missingBaseReservation);
  await new Promise((resolve) => missingBaseReservation.close(resolve));
  missingBaseAdapter = spawn(process.execPath, ["build"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(missingBasePort),
      ORIGIN: `http://127.0.0.1:${missingBasePort}`,
      PRIVATE_API_BASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  missingBaseAdapter.stdout.on("data", (chunk) => {
    transcript += chunk;
  });
  missingBaseAdapter.stderr.on("data", (chunk) => {
    transcript += chunk;
  });
  await waitForAdapter(missingBasePort, missingBaseAdapter);
  const observedBeforeMissingBase = observed.length;
  const missingBase = await rawRequest(
    missingBasePort,
    "/alice/zpage/configuration-miss",
  );
  assert.equal(missingBase.status, 503);
  assert.equal(missingBase.headers.location, undefined);
  assert.equal(missingBase.headers["cache-control"], "no-store");
  assert.equal(
    observed.length,
    observedBeforeMissingBase,
    "missing API configuration must fail before fetching or self-recursing",
  );
  console.log("built adapter legacy zPage redirect: PASS");
} catch (error) {
  if (transcript) process.stderr.write(transcript);
  throw error;
} finally {
  for (const child of [adapter, missingBaseAdapter]) {
    if (!child) continue;
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
  }
  await new Promise((resolve) => backend.close(resolve));
}
