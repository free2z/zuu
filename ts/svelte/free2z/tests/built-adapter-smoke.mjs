// Run after `npm run build`, against the same production output CI ships.
// Keep this outside *.test.mjs: Node's parallel source tests own isolated Kit
// output directories and must never rebuild or mutate this adapter output.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function send(port, path, { method = "GET", headers = {}, body = "" } = {}) {
  // Raw HTTP avoids fetch's automatic redirects, decompression and caching.
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.once("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error(`timeout: ${path}`)));
    req.end(body);
  });
}

const observed = [];
const backend = createServer((req, res) => {
  observed.push({ method: req.method, url: req.url });
  res.writeHead(401, { "content-type": "application/json" });
  res.end('{"detail":"Not authenticated"}');
});
let adapter;
let transcript = "";
try {
  const backendPort = await listen(backend);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  // Adapter-node 6 derives its self-origin from Host and defaults to HTTPS
  // (TLS terminates upstream in production); ORIGIN is no longer an env knob.
  const origin = `https://127.0.0.1:${port}`;
  adapter = spawn(process.execPath, ["build"], {
    cwd: appRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PRIVATE_API_BASE_URL: `http://127.0.0.1:${backendPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  adapter.stdout.on("data", (chunk) => (transcript += chunk));
  adapter.stderr.on("data", (chunk) => (transcript += chunk));
  let spawnError;
  adapter.on("error", (error) => (spawnError = error));
  const deadline = Date.now() + 15_000;
  while (true) {
    if (spawnError) throw spawnError;
    assert.equal(adapter.exitCode, null, "adapter exited before readiness");
    try {
      if ((await send(port, "/healthz")).status === 200) break;
    } catch {
      // Wait for the owned adapter listener, not a development server.
    }
    assert.ok(Date.now() < deadline, "adapter readiness exceeded 15s");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const login = await send(port, "/login?next=%2Fconverse");
  assert.equal(login.status, 200);
  assert.match(login.headers["content-type"], /text\/html/);
  const html = login.body.toString("utf8");
  assert.match(html, /<title>Log in · Free2Z<\/title>/);
  assert.match(html, /<h1\b[^>]*>\s*Welcome to Free2Z\s*<\/h1>/);
  assert.equal(login.headers.location, undefined);
  assert.equal(login.headers["cache-control"], "private, no-cache");
  assert.match(login.headers.vary, /\bCookie\b/i);
  assert.deepEqual(observed, [], "anonymous login SSR must not need a backend");

  // Current login deliberately has no actions. An EMPTY same-origin form must
  // produce the framework's 405 error, never an accidental success or 500.
  // Exercise both enhanced (JSON) and native (HTML) form response negotiation.
  for (const accept of ["application/json", "text/html"]) {
    const empty = await send(port, "/login", {
      method: "POST",
      headers: {
        origin,
        accept,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    assert.equal(empty.status, 405, accept);
    assert.equal(empty.headers.allow, "GET", accept);
    assert.match(empty.headers["content-type"], new RegExp(accept));
    if (accept === "application/json") {
      assert.deepEqual(JSON.parse(empty.body), {
        type: "error",
        location: "/login",
        error: { message: "Method Not Allowed", status: 405 },
      });
    } else {
      assert.match(empty.body.toString(), /Method Not Allowed/);
    }
  }

  // A real named action is the positive control: an empty anonymous checkout
  // reaches its auth guard. Kit 3 encodes the redirect in an HTTP 200 envelope.
  const billingPath = "/smoke-user/dashboard/billing";
  const action = await send(port, `${billingPath}?/checkout`, {
    method: "POST",
    headers: {
      origin,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  assert.equal(action.status, 200);
  assert.deepEqual(JSON.parse(action.body), {
    type: "redirect",
    status: 302,
    location: `/login?next=${encodeURIComponent(billingPath)}`,
  });

  // All browser form encodings must be refused BEFORE the action guard. The
  // same-origin request above rules out a generic missing-route/POST failure.
  for (const contentType of [
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=smoke",
    "text/plain",
  ]) {
    const rejected = await send(port, `${billingPath}?/checkout`, {
      method: "POST",
      headers: {
        origin: "https://cross-origin.invalid",
        accept: "application/json",
        "content-type": contentType,
      },
    });
    assert.equal(rejected.status, 403, contentType);
    assert.deepEqual(JSON.parse(rejected.body), {
      message: "Cross-site POST form submissions are forbidden",
    });
  }
  assert.deepEqual(
    observed,
    [],
    "empty/forbidden actions must not call Django",
  );

  // Bodyless HTTP responses also pass through the real adapter. Reports need
  // no credentials and intentionally return 204 even for an empty payload.
  const noContent = await send(port, "/csp-report", {
    method: "POST",
    headers: { origin, "content-type": "application/csp-report" },
  });
  assert.equal(noContent.status, 204);
  assert.equal(noContent.body.length, 0);
  assert.equal(noContent.headers["cache-control"], "no-store");

  // Pick a JS file referenced by THIS render, not a guessed hash or an arbitrary
  // file in build/. Compare bytes with disk so an HTML fallback cannot pass.
  const asset = html.match(
    /(?:href|src)="([^"\s]*\/_app\/immutable\/[^"\s]+\.js)"/,
  );
  assert.ok(asset, "login SSR must reference an immutable JS asset");
  const assetUrl = new URL(asset[1], origin);
  assert.equal(assetUrl.origin, origin);
  assert.match(assetUrl.pathname, /^\/_app\/immutable\/[\w./-]+\.js$/);
  assert.equal(assetUrl.pathname.includes(".."), false);
  const diskBytes = await readFile(
    `${appRoot}build/client${assetUrl.pathname}`,
  );
  const cached = await send(port, assetUrl.pathname);
  assert.equal(cached.status, 200);
  assert.match(
    cached.headers["content-type"],
    /(?:text|application)\/javascript/,
  );
  assert.deepEqual(cached.body, diskBytes);
  assert.equal(
    cached.headers["cache-control"],
    "public,max-age=31536000,immutable",
  );
  assert.ok(cached.headers.etag, "immutable assets need an ETag");
  const unchanged = await send(port, assetUrl.pathname, {
    headers: { "if-none-match": cached.headers.etag },
  });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body.length, 0);
  assert.equal(unchanged.headers.etag, cached.headers.etag);
  assert.equal(
    unchanged.headers["cache-control"],
    cached.headers["cache-control"],
  );
  const head = await send(port, assetUrl.pathname, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers.etag, cached.headers.etag);
  assert.equal(head.headers["content-length"], String(diskBytes.length));
  const changed = await send(port, assetUrl.pathname, {
    headers: { "if-none-match": '"smoke-nonmatching-etag"' },
  });
  assert.equal(changed.status, 200, "a different ETag must not yield 304");
  assert.deepEqual(changed.body, diskBytes);
  const version = await send(port, "/_app/version.json");
  assert.equal(version.status, 200);
  assert.doesNotMatch(version.headers["cache-control"] || "", /immutable/);
  console.log("built adapter smoke: PASS");
} catch (error) {
  if (transcript) process.stderr.write(transcript);
  throw error;
} finally {
  if (adapter && adapter.exitCode === null && adapter.signalCode === null) {
    const exited = once(adapter, "exit");
    adapter.kill("SIGTERM");
    const killDeadline = setTimeout(() => adapter.kill("SIGKILL"), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(killDeadline);
    }
  }
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
}
