import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadConfig, redact } from "../dist/config.js";
import { operations, describe, validate, document } from "../dist/catalog.js";
import { execute } from "../dist/api.js";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "free2z-mcp-test-"));
  const received = [];
  let handler = () => ({ status: 200, data: {} });
  const server = httpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = {
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    received.push(request);
    const response = await handler(request);
    res.writeHead(response.status ?? 200, {
      "content-type": "application/json",
      ...response.headers,
    });
    res.end(response.raw ?? JSON.stringify(response.data));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = loadConfig({
    FREE2Z_BASE_URL: base,
    FREE2Z_TOKEN: "testknoxsecret",
  });
  const connect = async (env) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/cli.js")],
      env: { FREE2Z_BASE_URL: base, ...env },
      stderr: "pipe",
    });
    const client = new Client({
      name: "free2z-mcp-integration",
      version: "1.0.0",
    });
    let stderr = "";
    transport.stderr?.on("data", (data) => {
      stderr += data;
    });
    await client.connect(transport);
    t.after(async () => {
      await client.close();
      assert.doesNotMatch(
        stderr,
        /testknoxsecret|testsessionsecret|testcsrfsecret/,
      );
    });
    return client;
  };
  return {
    dir,
    received,
    config,
    base,
    connect,
    respond: (fn) => {
      handler = fn;
    },
  };
}
const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return {
    error: result.isError === true,
    data: JSON.parse(result.content[0].text),
  };
};

test("real MCP handshake, discovery, schema, authenticated reads and paginated query encoding", async (t) => {
  const f = await fixture(t);
  const client = await f.connect({ FREE2Z_TOKEN: "testknoxsecret" });
  const { tools } = await client.listTools();
  assert.equal(
    tools.find((t) => t.name === "free2z_read").annotations.readOnlyHint,
    true,
  );
  assert.equal(
    tools.find((t) => t.name === "free2z_execute").annotations.destructiveHint,
    true,
  );
  const search = await call(client, "free2z_search_operations", {
    query: "zpage",
    limit: 2,
  });
  assert.equal(search.data.operations.length, 2);
  assert.equal(search.data.next_offset, 2);
  const schema = await call(client, "free2z_describe_operation", {
    operation_id: "zpage_create",
  });
  assert.ok(schema.data.components.schemas.zPageUpdate);
  const resources = await client.readResource({ uri: "free2z://guide" });
  assert.doesNotMatch(JSON.stringify(resources), /testknoxsecret/);
  f.respond((req) => ({
    data: {
      count: 3,
      next: `${f.base}/api/zpage/?page=2`,
      results: [{ title: "Draft", balance: "99999999999999.999" }],
    },
  }));
  const read = await call(client, "free2z_read", {
    operation_id: "zpage_list",
    query: {
      mine: true,
      any_tags: ["a,b", "c d"],
      page: 1,
      search: "draft",
      username: "alice",
      future_filter: "accepted",
    },
  });
  assert.equal(read.error, false);
  assert.equal(read.data.data.results[0].balance, "99999999999999.999");
  assert.ok(read.data.data.next);
  assert.equal(
    f.received.length,
    1,
    "pagination must not silently fetch or act on more pages",
  );
  assert.equal(f.received[0].headers.authorization, "Token testknoxsecret");
  assert.equal(f.received[0].headers.cookie, undefined);
  assert.deepEqual(
    new URL(f.received[0].url, f.base).searchParams.getAll("any_tags"),
    ["a,b", "c d"],
  );
  assert.equal(
    new URL(f.received[0].url, f.base).searchParams.get("future_filter"),
    "accepted",
  );
});

test("create/edit/delete route the real payload and concurrency headers; API errors remain errors", async (t) => {
  const f = await fixture(t);
  const client = await f.connect({ FREE2Z_TOKEN: "testknoxsecret" });
  let stored;
  const idempotency = "9225bd1e-e96a-4712-aa20-d8920ca5d8f6";
  f.respond((req) => {
    if (req.method === "POST") {
      stored = JSON.parse(req.body);
      return {
        status: 201,
        headers: { etag: '"revision1"', "idempotency-key-honored": "true" },
        data: { ...stored, free2zaddr: "draft-id" },
      };
    }
    if (req.method === "PATCH") {
      if (req.headers["if-match"] !== '"revision1"')
        return { status: 412, data: { detail: "Stale revision" } };
      stored = { ...stored, ...JSON.parse(req.body) };
      return { data: stored };
    }
    if (req.method === "DELETE") {
      stored = undefined;
      return { status: 204, raw: "" };
    }
    throw new Error("Unexpected request");
  });
  const body = {
    title: "Prepared draft",
    content: "# Content",
    source_language: "en",
    tags: [],
    is_published: false,
  };
  const create = await call(client, "free2z_execute", {
    operation_id: "zpage_create",
    headers: { "Idempotency-Key": idempotency },
    body,
  });
  assert.equal(create.error, false);
  assert.deepEqual(stored, body);
  assert.equal(f.received[0].headers["idempotency-key"], idempotency);
  assert.equal(create.data.headers.etag, '"revision1"');
  assert.equal(create.data.headers["idempotency-key-honored"], "true");
  const rejected = await call(client, "free2z_execute", {
    operation_id: "zpage_partial_update",
    path: { id: "draft-id" },
    headers: { "If-Match": '"stale"' },
    body: { title: "Wrong" },
  });
  assert.equal(rejected.error, true);
  assert.equal(rejected.data.status, 412);
  assert.equal(stored.title, body.title);
  const edit = await call(client, "free2z_execute", {
    operation_id: "zpage_partial_update",
    path: { id: "draft-id" },
    headers: { "If-Match": create.data.headers.etag },
    body: { title: "Edited" },
  });
  assert.equal(edit.error, false);
  assert.equal(stored.title, "Edited");
  const deleted = await call(client, "free2z_execute", {
    operation_id: "zpage_destroy",
    path: { id: "draft-id" },
  });
  assert.equal(deleted.data.status, 204);
  assert.equal(deleted.data.data, null);
  assert.equal(stored, undefined);
  assert.equal(f.received.length, 4, "no automatic mutation retries");
});

test("session uploads include actual bytes, matching metadata and CSRF; token cannot invoke legacy uploads", async (t) => {
  const f = await fixture(t);
  const credentials = join(f.dir, "session.json");
  await writeFile(
    credentials,
    JSON.stringify({
      sessionid: "testsessionsecret",
      csrftoken: "testcsrfsecret",
    }),
    { mode: 0o600 },
  );
  const file = join(f.dir, "photo.png");
  await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const client = await f.connect({ FREE2Z_SESSION_FILE: credentials });
  f.respond((req) => ({
    status: 201,
    data: { url: "/uploadz/photo.png", access: "private" },
  }));
  const upload = await call(client, "free2z_execute", {
    operation_id: "uploads_single_public",
    body: { title: "A private image", access: "private" },
    files: { file: { path: file, content_type: "image/png" } },
  });
  assert.equal(upload.error, false);
  assert.equal(f.received[0].url, "/uploads/single-public");
  assert.equal(
    f.received[0].headers.cookie,
    "sessionid=testsessionsecret; csrftoken=testcsrfsecret",
  );
  assert.equal(f.received[0].headers["x-csrftoken"], "testcsrfsecret");
  assert.equal(f.received[0].headers.origin, f.base);
  assert.equal(f.received[0].headers.referer, `${f.base}/`);
  assert.equal(f.received[0].headers.authorization, undefined);
  assert.match(f.received[0].body, /name="title"\r\n\r\nA private image/);
  assert.match(f.received[0].body, /filename="photo.png"/);
  assert.match(f.received[0].body, /PNG/);
  const metadata = [
    { title: "One", access: "private" },
    { title: "Two", access: "members" },
  ];
  const batch = await call(client, "free2z_execute", {
    operation_id: "uploads_batch",
    body: { body: JSON.stringify(metadata) },
    files: { files: [{ path: file }, { path: file, filename: "second.png" }] },
  });
  assert.equal(batch.error, false);
  assert.equal(f.received[1].url, "/uploads/handle");
  assert.equal((f.received[1].body.match(/name="files"/g) ?? []).length, 2);
  assert.ok(f.received[1].body.includes(JSON.stringify(metadata)));
  await assert.rejects(
    execute(f.config, {
      operation_id: "uploads_single_public",
      files: { file: { path: file } },
    }),
    /requires FREE2Z_SESSION_FILE/,
  );
  const mismatch = await call(client, "free2z_execute", {
    operation_id: "uploads_batch",
    body: { body: "[]" },
    files: { files: { path: file } },
  });
  assert.equal(mismatch.error, true);
  assert.equal(f.received.length, 2);
});

test("credentials and request authority cannot escape through headers, paths, redirects or error responses", async (t) => {
  const f = await fixture(t);
  const client = await f.connect({ FREE2Z_TOKEN: "testknoxsecret" });
  for (const path of [
    "..",
    "%2e%2e",
    "evil/route",
    "evil\\route",
    "?redirect=1",
  ]) {
    const r = await call(client, "free2z_read", {
      operation_id: "creator_retrieve",
      path: { username__iexact: path },
    });
    assert.equal(r.error, true);
  }
  for (const headers of [
    { Authorization: "Bearer stolen" },
    { Cookie: "sessionid=stolen" },
    { Host: "evil.test" },
    { "X-CSRFToken": "other" },
    { "If-Match": "a\r\nb" },
  ]) {
    const r = await call(client, "free2z_read", {
      operation_id: "auth_user_retrieve",
      headers,
    });
    assert.equal(r.error, true);
  }
  assert.equal(
    (
      await call(client, "free2z_read", {
        operation_id: "zpage_create",
        body: {},
      })
    ).error,
    true,
  );
  assert.equal(
    (
      await call(client, "free2z_read", {
        operation_id: "zpage_list",
        query: { arbitrary: { nested: "x" } },
      })
    ).error,
    true,
  );
  assert.equal(f.received.length, 0);
  f.respond(() => ({
    status: 302,
    headers: { location: `${f.base}/capture?credential=testknoxsecret` },
    raw: "<html>secret</html>",
  }));
  const redirect = await call(client, "free2z_read", {
    operation_id: "auth_user_retrieve",
  });
  assert.equal(redirect.error, true);
  assert.doesNotMatch(JSON.stringify(redirect), /testknoxsecret|capture/);
  assert.equal(f.received.length, 1);
  f.respond(() => ({
    status: 401,
    headers: { "set-cookie": "sessionid=issuedsecret" },
    data: {
      token: "newtoken",
      nested: [
        {
          auth_token: "livesecret",
          client_secret: "oauthsecret",
          message: "bad testknoxsecret",
        },
      ],
      detail: "Log in again",
    },
  }));
  const error = await call(client, "free2z_read", {
    operation_id: "auth_user_retrieve",
  });
  assert.equal(error.error, true);
  assert.equal(error.data.status, 401);
  assert.equal(error.data.data.detail, "Log in again");
  assert.doesNotMatch(
    JSON.stringify(error),
    /newtoken|livesecret|oauthsecret|issuedsecret|testknoxsecret/,
  );
  f.respond(() => ({
    status: 500,
    headers: { "content-type": "text/html" },
    raw: '<input value="csrfsecret">stack trace',
  }));
  const html = await call(client, "free2z_read", {
    operation_id: "auth_user_retrieve",
  });
  assert.doesNotMatch(JSON.stringify(html), /csrfsecret|stack trace/);
});

test("configuration rejects conflicting credentials, insecure origins and readable secret files", async (t) => {
  const f = await fixture(t);
  for (const url of [
    "https://example.org/api",
    "http://example.org",
    "https://user:pass@example.org",
    "https://example.org/?x=1",
  ])
    assert.throws(() => loadConfig({ FREE2Z_BASE_URL: url }));
  assert.throws(
    () => loadConfig({ FREE2Z_TOKEN: "a", FREE2Z_SESSION_FILE: "ignored" }),
    /exactly one/,
  );
  assert.throws(() => loadConfig({ FREE2Z_TOKEN: "Token abc" }));
  const tokenFile = join(f.dir, "token");
  await writeFile(tokenFile, "secret", { mode: 0o644 });
  if (process.platform !== "win32")
    assert.throws(
      () => loadConfig({ FREE2Z_TOKEN_FILE: tokenFile }),
      /private/,
    );
  await chmod(tokenFile, 0o600);
  assert.equal(loadConfig({ FREE2Z_TOKEN_FILE: tokenFile }).token, "secret");
  assert.equal(
    redact({ new_password1: "secretvalue", code_verifier: "pkce" }, f.config)
      .new_password1,
    "[REDACTED]",
  );
});

test("response and upload bounds fail closed without automatic retries", async (t) => {
  const f = await fixture(t);
  f.respond(() => ({ data: { large: "a".repeat(1000) } }));
  await assert.rejects(
    execute(
      { ...f.config, maxResponseBytes: 30 },
      { operation_id: "auth_user_retrieve" },
    ),
    /Response exceeded/,
  );
  assert.equal(f.received.length, 1);
  f.respond(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { data: {} };
  });
  await assert.rejects(
    execute(
      { ...f.config, timeoutMs: 5 },
      { operation_id: "auth_user_retrieve" },
    ),
    /timed out/,
  );
  assert.equal(f.received.length, 2);
});

test("every bundled operation schema can be described and its request validators compile", () => {
  const schemaIds = Object.values(document.paths)
    .flatMap((path) => Object.values(path))
    .filter((op) => op.operationId)
    .map((op) => op.operationId);
  const hidden = new Set([
    "account_data_export_create",
    "account_data_export_latest",
    "account_data_export_retrieve",
    "account_data_export_download",
  ]);
  for (const id of schemaIds)
    assert.equal(operations.has(id), !hidden.has(id), id);
  for (const id of hidden) assert.ok(schemaIds.includes(id), id);
  for (const op of operations.values()) {
    assert.ok(describe(op).operation);
    for (const parameter of op.spec.parameters ?? []) {
      try {
        validate(parameter.schema ?? {}, null, parameter.name);
      } catch (e) {
        assert.match(e.message, new RegExp(`^${parameter.name}:`));
      }
    }
    for (const media of Object.values(op.spec.requestBody?.content ?? {})) {
      try {
        validate(media.schema ?? {}, null, "body");
      } catch (e) {
        assert.match(e.message, /^body:/, `${op.id}: ${e.message}`);
      }
    }
  }
});

async function profiles(t) {
  const f = await fixture(t);
  const session = join(f.dir, "alice.json");
  const token = join(f.dir, "team.token");
  const registry = join(f.dir, "accounts.json");
  const accounts = {
    alice: { username: "alice", session_file: session },
    team: { username: "team", token_file: token },
  };
  await writeFile(
    session,
    JSON.stringify({
      sessionid: "aliceSessionSecret",
      csrftoken: "aliceCsrfSecret",
    }),
    { mode: 0o600 },
  );
  await writeFile(token, "teamTokenSecret", { mode: 0o600 });
  await writeFile(registry, JSON.stringify({ accounts }), { mode: 0o600 });
  const client = await f.connect({ FREE2Z_ACCOUNTS_FILE: registry });
  return { ...f, session, token, registry, accounts, client };
}
const draftBody = {
  title: "Account draft",
  content: "Body",
  source_language: "en",
  tags: [],
  is_published: false,
};

test("profile stdio requires explicit account, verifies identity before every operation and refuses expired/wrong credentials without fallback", async (t) => {
  const f = await profiles(t);
  const listed = await call(f.client, "free2z_list_accounts", {});
  assert.equal(listed.error, false);
  assert.deepEqual(listed.data, {
    mode: "profiles",
    accounts: [
      { account: "alice", username: "alice", authentication: "session" },
      { account: "team", username: "team", authentication: "token" },
      { account: "anonymous", username: null, authentication: "anonymous" },
    ],
  });
  assert.equal(f.received.length, 0);
  assert.ok(!JSON.stringify(listed).includes(f.dir));
  for (const account of [undefined, "missing", "__proto__", "constructor"]) {
    const r = await call(f.client, "free2z_execute", {
      operation_id: "zpage_create",
      body: draftBody,
      ...(account === undefined ? {} : { account }),
    });
    assert.equal(r.error, true);
  }
  assert.equal(f.received.length, 0);
  let identity = { username: "someoneElse", token: "issuedSecret" };
  let status = 200;
  f.respond((req) => {
    assert.equal(
      req.url,
      "/api/auth/user/",
      "requested mutation must not be sent when identity verification fails",
    );
    return { status, data: identity };
  });
  for (const code of [200, 401, 403]) {
    status = code;
    const r = await call(f.client, "free2z_execute", {
      account: "alice",
      operation_id: "zpage_create",
      body: draftBody,
    });
    assert.equal(r.error, true);
    assert.match(r.data.error, /identity verification failed/);
    assert.doesNotMatch(
      JSON.stringify(r),
      /someoneElse|issuedSecret|aliceSessionSecret|aliceCsrfSecret/,
    );
  }
  assert.equal(f.received.length, 3);
  assert.ok(f.received.every((r) => r.headers.authorization === undefined));
  f.respond((req) => ({
    data:
      req.url === "/api/auth/user/"
        ? { username: "alice" }
        : { echoed: req.headers.cookie, client_secret: "newSecret" },
  }));
  const read = await call(f.client, "free2z_read", {
    account: "alice",
    operation_id: "zpage_list",
  });
  assert.equal(read.error, false);
  assert.equal(read.data.account, "alice");
  assert.equal(read.data.verified_username, "alice");
  assert.doesNotMatch(
    JSON.stringify(read),
    /aliceSessionSecret|aliceCsrfSecret|newSecret/,
  );
  assert.equal(f.received.length, 5);
  const beforeAnonymous = f.received.length;
  f.respond((req) => {
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-csrftoken"], undefined);
    return { data: {} };
  });
  for (const [tool, operation_id] of [
    ["free2z_read", "zpage_list"],
    ["free2z_execute", "zpage_create"],
  ]) {
    const anonymous = await call(f.client, tool, {
      account: "anonymous",
      operation_id,
      ...(tool === "free2z_execute" ? { body: draftBody } : {}),
    });
    assert.equal(anonymous.error, false);
    assert.equal(anonymous.data.account, "anonymous");
    assert.equal(anonymous.data.verified_username, null);
  }
  assert.equal(
    f.received.length,
    beforeAnonymous + 2,
    "anonymous preserves API semantics without identity lookups or fallback",
  );
});

test("profiles verify exact API usernames containing an internal @", async (t) => {
  const f = await profiles(t);
  const username = "alice@example.com";
  await writeFile(
    f.registry,
    JSON.stringify({ accounts: { alice: { ...f.accounts.alice, username } } }),
  );
  f.respond((req) => ({
    data:
      req.url === "/api/auth/user/" ? { username } : { count: 0, results: [] },
  }));
  const r = await call(f.client, "free2z_read", {
    account: "alice",
    operation_id: "zpage_list",
  });
  assert.equal(r.error, false);
  assert.equal(r.data.verified_username, username);
  assert.equal(f.received.length, 2);
});

test("concurrent profile calls retain verified snapshots while registry and credentials rotate, next calls reload without restart", async (t) => {
  const f = await profiles(t);
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let observed;
  const started = new Promise((resolve) => {
    observed = resolve;
  });
  let delayed = false;
  f.respond(async (req) => {
    const alice = req.headers.cookie?.includes("aliceSessionSecret");
    const rotated = req.headers.cookie?.includes("rotatedSessionSecret");
    const team = req.headers.authorization === "Token teamTokenSecret";
    assert.ok(alice || rotated || team);
    assert.equal(
      Boolean(req.headers.cookie) && Boolean(req.headers.authorization),
      false,
    );
    if (req.url === "/api/auth/user/") {
      if (alice && !delayed) {
        delayed = true;
        observed();
        await hold;
      }
      return { data: { username: team ? "team" : "alice" } };
    }
    assert.equal(req.method, "POST");
    if (alice) assert.equal(req.headers["x-csrftoken"], "aliceCsrfSecret");
    if (rotated) assert.equal(req.headers["x-csrftoken"], "rotatedCsrfSecret");
    return { status: 201, data: { title: JSON.parse(req.body).title } };
  });
  const oldCall = call(f.client, "free2z_execute", {
    account: "alice",
    operation_id: "zpage_create",
    body: { ...draftBody, title: "old snapshot" },
  });
  await started;
  const teamCall = await call(f.client, "free2z_execute", {
    account: "team",
    operation_id: "zpage_create",
    body: { ...draftBody, title: "team snapshot" },
  });
  assert.equal(teamCall.error, false);
  assert.equal(teamCall.data.verified_username, "team");
  // Replace selected file while its identity request is paused. The original call must not reread it.
  await writeFile(
    f.session,
    JSON.stringify({
      sessionid: "rotatedSessionSecret",
      csrftoken: "rotatedCsrfSecret",
    }),
  );
  await writeFile(
    f.registry,
    JSON.stringify({
      accounts: {
        ...f.accounts,
        alice: { ...f.accounts.alice, username: "notAlice" },
      },
    }),
  );
  release();
  const old = await oldCall;
  assert.equal(old.error, false);
  assert.equal(old.data.verified_username, "alice");
  await writeFile(f.registry, JSON.stringify({ accounts: f.accounts }));
  const next = await call(f.client, "free2z_execute", {
    account: "alice",
    operation_id: "zpage_create",
    body: { ...draftBody, title: "new snapshot" },
  });
  assert.equal(next.error, false);
  const posts = f.received.filter((r) => r.method === "POST");
  assert.equal(posts.length, 3);
  assert.equal(
    posts.find((r) => JSON.parse(r.body).title === "old snapshot").headers
      .cookie,
    "sessionid=aliceSessionSecret; csrftoken=aliceCsrfSecret",
  );
  assert.equal(
    posts.find((r) => JSON.parse(r.body).title === "new snapshot").headers
      .cookie,
    "sessionid=rotatedSessionSecret; csrftoken=rotatedCsrfSecret",
  );
  assert.equal(
    posts.find((r) => JSON.parse(r.body).title === "team snapshot").headers
      .authorization,
    "Token teamTokenSecret",
  );
  // Registry replacement also takes effect, without changing another profile.
  await writeFile(
    f.registry,
    JSON.stringify({
      accounts: {
        ...f.accounts,
        alice: { ...f.accounts.alice, username: "notAlice" },
      },
    }),
  );
  const rejected = await call(f.client, "free2z_execute", {
    account: "alice",
    operation_id: "zpage_create",
    body: draftBody,
  });
  assert.equal(rejected.error, true);
  assert.equal(f.received.filter((r) => r.method === "POST").length, 3);
  assert.equal(
    (
      await call(f.client, "free2z_execute", {
        account: "team",
        operation_id: "zpage_create",
        body: draftBody,
      })
    ).error,
    false,
  );
});

test("registry and credential errors are private, malformed reload fails closed, listing does not read credentials", async (t) => {
  const f = await profiles(t);
  assert.throws(
    () =>
      loadConfig({
        FREE2Z_ACCOUNTS_FILE: f.registry,
        FREE2Z_TOKEN: "testknoxsecret",
      }),
    /exactly one/,
  );
  await rm(f.token);
  assert.equal(
    (await call(f.client, "free2z_list_accounts", {})).error,
    false,
    "listing must not open credentials",
  );
  const missing = await call(f.client, "free2z_read", {
    account: "team",
    operation_id: "zpage_list",
  });
  assert.equal(missing.error, true);
  assert.ok(!JSON.stringify(missing).includes(f.dir));
  await writeFile(f.session, "not JSON: privateSecretMarker");
  const malformed = await call(f.client, "free2z_read", {
    account: "alice",
    operation_id: "zpage_list",
  });
  assert.equal(malformed.error, true);
  assert.doesNotMatch(JSON.stringify(malformed), /privateSecretMarker/);
  const invalid = [
    "privateSecretMarker",
    { accounts: { anonymous: f.accounts.alice } },
    { accounts: { alice: { ...f.accounts.alice, token_file: f.token } } },
    {
      accounts: {
        alice: { ...f.accounts.alice, session_file: "relative.json" },
      },
    },
    {
      accounts: {
        alice: { ...f.accounts.alice, raw_token: "privateSecretMarker" },
      },
    },
    { accounts: {}, unexpected: "privateSecretMarker" },
  ];
  for (const registry of invalid) {
    await writeFile(
      f.registry,
      typeof registry === "string" ? registry : JSON.stringify(registry),
    );
    for (const [name, args] of [
      ["free2z_list_accounts", {}],
      ["free2z_read", { account: "alice", operation_id: "zpage_list" }],
    ]) {
      const r = await call(f.client, name, args);
      assert.equal(r.error, true);
      assert.doesNotMatch(JSON.stringify(r), /privateSecretMarker/);
      assert.ok(!JSON.stringify(r).includes(f.dir));
    }
  }
  await writeFile(f.registry, JSON.stringify({ accounts: f.accounts }));
  if (process.platform !== "win32") {
    await chmod(f.registry, 0o644);
    assert.equal(
      (await call(f.client, "free2z_list_accounts", {})).error,
      true,
    );
  }
  assert.equal(f.received.length, 0);
});

test("private account exports are absent and rejected before any transport", async (t) => {
  const f = await profiles(t);
  const hidden = [
    "account_data_export_create",
    "account_data_export_latest",
    "account_data_export_retrieve",
    "account_data_export_download",
  ];
  const search = await call(f.client, "free2z_search_operations", {
    query: "account_data_export",
  });
  assert.equal(search.data.total, 0);
  for (const id of hidden) {
    assert.equal(operations.has(id), false);
    assert.equal(
      (await call(f.client, "free2z_describe_operation", { operation_id: id }))
        .error,
      true,
    );
    for (const tool of ["free2z_read", "free2z_execute"]) {
      const result = await call(f.client, tool, {
        account: "alice",
        operation_id: id,
      });
      assert.equal(result.error, true, `${tool} ${id}`);
    }
    await assert.rejects(
      execute(f.config, { operation_id: id }),
      /Unknown operation_id/,
    );
    // This server has no dry-run mode; its strict tool schema rejects that
    // argument before dispatch instead of treating it as a bypass.
    let outcome;
    try {
      outcome = await f.client.callTool({
        name: "free2z_execute",
        arguments: { account: "alice", operation_id: id, dry_run: true },
      });
    } catch (error) {
      outcome = error;
    }
    assert.ok(outcome instanceof Error || outcome.isError === true);
  }
  for (const raw of [
    "/api/exports/account/",
    "/api/exports/account/latest/",
    "/api/exports/account/%2e%2e/account/latest/",
    "/api/exports/account/123/download/",
  ]) {
    await assert.rejects(
      execute(f.config, { operation_id: raw }),
      /Unknown operation_id/,
    );
    await assert.rejects(
      execute(f.config, {
        operation_id: "publication_exports_retrieve",
        path: { id: raw },
      }),
      /path.id.*uuid|reserved path character/,
    );
  }
  assert.equal(
    f.received.length,
    0,
    "refusal must precede even profile identity verification",
  );
  f.respond((request) =>
    request.url === "/api/auth/user/"
      ? { data: { username: "alice" } }
      : { data: { status: "ready" } },
  );
  const allowed = await call(f.client, "free2z_read", {
    account: "alice",
    operation_id: "publication_exports_list",
  });
  assert.equal(allowed.error, false);
  assert.equal(f.received.length, 2);
  assert.equal(f.received[1].url, "/api/exports/publications/");
});
