import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { once } from "node:events";

const OUTER_PATH = "/..%2Fget-type%2Fscanner-proof%3Fx";
const DECODED_USERNAME = "../get-type/scanner-proof?x";
const ENCODED_USERNAME = encodeURIComponent(DECODED_USERNAME);
const UNSAFE_NORMALIZED_TARGET = "/api/get-type/scanner-proof?x/";

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
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    req.once("error", reject);
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
      if ((await rawRequest(port, "/healthz")) === 200) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("adapter did not become ready within 15 seconds");
}

const observed = [];
const backend = createServer((req, response) => {
  observed.push({
    method: req.method,
    url: req.url,
    forwardedFor: req.headers["x-forwarded-for"] || null,
  });
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

try {
  await waitForAdapter(appPort, adapter);
  const status = await rawRequest(appPort, OUTER_PATH, {
    "x-forwarded-for": "203.0.113.9, 34.102.196.190",
    "x-free2z-originating-client": "attacker-chosen-bucket",
  });
  assert.equal(status, 404);

  const unsafeTarget = (entry) => entry.url === UNSAFE_NORMALIZED_TARGET;
  assert.equal(
    unsafeTarget({ url: UNSAFE_NORMALIZED_TARGET }),
    true,
    "negative-control oracle must recognize the pre-fix escaped target",
  );
  assert.equal(
    observed.some(unsafeTarget),
    false,
    `outer ${OUTER_PATH} escaped its creator segment: ${JSON.stringify(observed)}`,
  );
  assert.deepEqual(
    observed.map(({ method, url }) => ({ method, url })),
    [
      { method: "GET", url: `/api/creator/${ENCODED_USERNAME}/` },
      { method: "GET", url: `/api/get-type/${ENCODED_USERNAME}` },
    ],
  );
  assert.equal(
    observed[1].forwardedFor,
    "203.0.113.9, 127.0.0.1",
    "admitted old-ingress traffic must preserve the real client for the downstream limiter",
  );
  console.log("built adapter root containment: PASS");
} catch (error) {
  if (transcript) process.stderr.write(transcript);
  throw error;
} finally {
  adapter.kill("SIGTERM");
  if (adapter.exitCode === null) await once(adapter, "exit");
  await new Promise((resolve) => backend.close(resolve));
}
