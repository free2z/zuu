import test from "node:test";
import assert from "node:assert/strict";
import { FetchTransport } from "../dist/index.js";
import { WebSession } from "../dist/oauth.js";
import { issuer, deferred } from "./issuer.mjs";
const options = { operationId: "operation-1", idempotencyKey: "durable-key" };
const request = { model: "test", messages: [] };
const bytes = (s) => new TextEncoder().encode(s);
const expired = () =>
  new Response('{"error":{"code":"token_expired"}}', {
    status: 401,
    headers: { "content-type": "application/json" },
  });

test("browser validates signed ID token and nonce before exposing session", async () => {
  const mock = issuer(),
    auth = new WebSession(mock.config);
  assert.equal((await auth.signIn()).subject, "alice");
  assert.equal(await auth.token("ai:invoke", auth.generation), "access-1");
  const bad = issuer({ claims: { nonce: "attacker" } });
  await assert.rejects(new WebSession(bad.config).signIn());
  const hash = issuer({ claims: { at_hash: "wrong" } });
  await assert.rejects(new WebSession(hash.config).signIn(), {
    code: "invalid_response",
  });
});
test("lost refresh response recovers same predecessor once for concurrent waiters", async () => {
  const mock = issuer(),
    auth = new WebSession(mock.config),
    predecessors = [];
  await auth.signIn();
  mock.refresh = (params) => {
    predecessors.push(params.get("refresh_token"));
    if (predecessors.length === 1) throw new TypeError("socket secret");
    return mock.json({
      access_token: "successor",
      refresh_token: "next",
      token_type: "Bearer",
      expires_in: 300,
    });
  };
  const results = await Promise.all([
    auth.token("ai:invoke", auth.generation, undefined, true),
    auth.token("ai:invoke", auth.generation, undefined, true),
  ]);
  assert.deepEqual(results, ["successor", "successor"]);
  assert.deepEqual(predecessors, ["refresh-1", "refresh-1"]);
});
test("cancelled chat during refresh does not send a billable request after rotation", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  const refresh = deferred(),
    started = deferred();
  let sends = 0;
  mock.refresh = () => {
    started.resolve();
    return refresh.promise;
  };
  mock.api = () => {
    sends++;
    return expired();
  };
  const controller = new AbortController(),
    pending = transport.chat(request, {
      ...options,
      signal: controller.signal,
    });
  await started.promise;
  controller.abort();
  await assert.rejects(
    pending,
    (e) => e.code === "cancelled" && e.idempotencyKey === "durable-key",
  );
  refresh.resolve(
    mock.json({
      access_token: "new",
      refresh_token: "next",
      token_type: "Bearer",
      expires_in: 300,
    }),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(sends, 1);
  assert.equal((await transport.session()).signedIn, true);
});
test("account switch during an old refresh cannot install old identity or reuse old flight", async () => {
  const mock = issuer(),
    auth = new WebSession(mock.config);
  await auth.signIn();
  const old = deferred(),
    started = deferred();
  mock.refresh = () => {
    started.resolve();
    return old.promise;
  };
  const pending = auth.token("ai:invoke", auth.generation, undefined, true);
  await started.promise;
  mock.subject = "bob";
  await auth.signIn();
  mock.refresh = () =>
    mock.json({
      access_token: "bob-new",
      refresh_token: "bob-next",
      token_type: "Bearer",
      expires_in: 300,
    });
  assert.equal(
    await auth.token("ai:invoke", auth.generation, undefined, true),
    "bob-new",
  );
  old.resolve(
    mock.json({
      access_token: "alice-new",
      refresh_token: "alice-next",
      token_type: "Bearer",
      expires_in: 300,
    }),
  );
  await assert.rejects(pending, { code: "signed_out" });
  assert.equal(auth.snapshot().subject, "bob");
  assert.equal(await auth.token("ai:invoke", auth.generation), "bob-new");
});
test("broken purchase and chat success bodies preserve their original keys", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  mock.api = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes('{"id":"intent"'));
          c.error(new Error("private detail"));
        },
      }),
      {
        headers: {
          "content-type": "application/json",
          "x-f2z-call-id": "call-1",
        },
      },
    );
  await assert.rejects(
    transport.createPurchase({ rail: "card", quantity2z: 1n }, options),
    (e) => e.code === "unconfirmed" && e.idempotencyKey === "durable-key",
  );
  await assert.rejects(
    transport.chat(request, options),
    (e) =>
      e.code === "unconfirmed" &&
      e.idempotencyKey === "durable-key" &&
      e.callId === "call-1",
  );
});
test("cancelling stream before first pull closes response and terminal event closes without another pull", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  let cancellations = 0;
  mock.api = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(
            bytes(
              'event: meta\ndata: {"call_id":"call-1","model":"test","hold_2z":1}\n\nevent: done\ndata: {"finish_reason":"stop","settlement":"pending"}\n\n',
            ),
          );
        },
        cancel() {
          cancellations++;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const first = await transport.chat(request, options);
  await first.cancel();
  assert.equal(cancellations, 1);
  const second = await transport.chat(request, options);
  assert.equal((await second.next()).value.type, "meta");
  assert.equal((await second.next()).value.charge.state, "pending");
  assert.equal(cancellations, 2);
  assert.equal((await second.next()).done, true);
});
test("stream EOF is ambiguous and never retries a new billable key", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  let sends = 0;
  mock.api = () => {
    sends++;
    return new Response(
      'event: meta\ndata: {"call_id":"call-1","model":"test","hold_2z":1}\n\nevent: delta\ndata: {"text":"hello"}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const stream = await transport.chat(request, options);
  await stream.next();
  await stream.next();
  await assert.rejects(
    stream.next(),
    (e) =>
      e.code === "stream_interrupted" &&
      e.callId === "call-1" &&
      e.idempotencyKey === "durable-key",
  );
  assert.equal(sends, 1);
});
test("catalog cache is conditional, immutable to consumers and scoped to login generation", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  let reads = 0;
  mock.api = (_path, init) => {
    reads++;
    if (reads === 2) {
      assert.equal(
        new Headers(init.headers).get("if-none-match"),
        '"catalog-1"',
      );
      return new Response(null, {
        status: 304,
        headers: { "cache-control": "max-age=60" },
      });
    }
    return new Response('{"catalog_version":1,"models":[{"id":"test"}]}', {
      headers: {
        "content-type": "application/json",
        etag: '"catalog-1"',
        "cache-control": "max-age=0",
      },
    });
  };
  const one = await transport.models();
  one.models[0].id = "mutated";
  assert.equal((await transport.models()).models[0].id, "test");
  await transport.models();
  assert.equal(reads, 2);
  mock.subject = "bob";
  await transport.signIn();
  await transport.models();
  assert.equal(reads, 3);
});
test("token claims with an invalid signature cannot install a browser session", async () => {
  const mock = issuer(),
    original = mock.config.fetch;
  mock.config.fetch = async (input, init) => {
    const response = await original(input, init);
    if (new URL(String(input)).pathname !== "/token") return response;
    const data = await response.json();
    data.id_token =
      data.id_token.split(".").slice(0, 2).join(".") +
      "." +
      Buffer.alloc(256).toString("base64url");
    return mock.json(data);
  };
  const auth = new WebSession(mock.config);
  await assert.rejects(auth.signIn(), { code: "invalid_response" });
  assert.equal(auth.snapshot().signedIn, false);
});
test("truncated refresh JSON recovers the same predecessor within the grace window", async () => {
  const mock = issuer(),
    auth = new WebSession(mock.config),
    predecessors = [];
  await auth.signIn();
  mock.refresh = (params) => {
    predecessors.push(params.get("refresh_token"));
    if (predecessors.length === 1)
      return new Response('{"access_token":"cut', {
        headers: { "content-type": "application/json" },
      });
    return mock.json({
      access_token: "next",
      refresh_token: "next-refresh",
      token_type: "Bearer",
      expires_in: 300,
    });
  };
  assert.equal(
    await auth.token("ai:invoke", auth.generation, undefined, true),
    "next",
  );
  assert.deepEqual(predecessors, ["refresh-1", "refresh-1"]);
});
test("web call lookup and idempotent replay preserve metadata that resembles amount fields", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  const record = {
    call_id: "call-1",
    status: "settled",
    charged_2z: 2,
    receipt_id: "receipt",
    metadata: { input_tokens: "lesson-1", hold_2z: "42" },
    extension: { input_tokens: "an extension string" },
  };
  mock.api = () => mock.json(record);
  const looked = await transport.call("call-1"),
    replay = (await (await transport.chat(request, options)).next()).value
      .record;
  for (const received of [looked, replay]) {
    assert.deepEqual({ ...received.metadata }, record.metadata);
    assert.equal(received.extension.input_tokens, "an extension string");
    assert.equal(received.charge.charged2z, 2n);
  }
});
test("late purchase responses cannot restore an old checkout after sign-out", async () => {
  const intent = {
    id: "intent-1",
    rail: "card",
    status: "created",
    quantity_2z: 100,
    price: { currency: "usd", amount_minor: 100 },
    credited_milli_2z: null,
    credited_at: null,
    rail_data: { checkout_url: "https://checkout.example/old-user" },
  };
  for (const method of ["createPurchase", "purchase"])
    for (let turns = 0; turns < 35; turns++) {
      const mock = issuer();
      let opened = 0,
        signedOut;
      const transport = new FetchTransport({
        ...mock.config,
        openExternal: async () => {
          opened++;
        },
      });
      await transport.signIn();
      mock.api = () => {
        let remaining = turns;
        const tick = () => {
          if (remaining-- === 0) signedOut = transport.signOut();
          else queueMicrotask(tick);
        };
        queueMicrotask(tick);
        return mock.json(intent);
      };
      try {
        if (method === "createPurchase")
          await transport.createPurchase(
            { rail: "card", quantity2z: 100n },
            options,
          );
        else await transport.purchase("intent-1");
      } catch {}
      await new Promise((resolve) => setImmediate(resolve));
      await signedOut;
      assert.equal((await transport.session()).signedIn, false);
      await assert.rejects(transport.openCheckout("intent-1"));
      assert.equal(
        opened,
        0,
        `${method} revived a checkout at microtask offset ${turns}`,
      );
    }
});
test("max_output_tokens_strict reaches the gateway only when true, and never without a limit", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  const bodies = [];
  mock.api = (path, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      '{"model":"test","input_tokens":1,"max_output_tokens":1800,"hold_2z":1}',
      { headers: { "content-type": "application/json" } },
    );
  };
  const limited = { ...request, max_output_tokens: 1800n };
  await transport.estimate({ ...limited, max_output_tokens_strict: true });
  assert.equal(bodies.at(-1).max_output_tokens_strict, true);
  assert.equal(bodies.at(-1).max_output_tokens, 1800);
  // false is the default: dropped, so the body is the pre-flag body.
  await transport.estimate({ ...limited, max_output_tokens_strict: false });
  assert.deepEqual(Object.keys(bodies.at(-1)).sort(), [
    "max_output_tokens",
    "messages",
    "model",
  ]);
  const sent = bodies.length;
  for (const bad of [
    { ...request, max_output_tokens_strict: true },
    { ...limited, max_output_tokens_strict: "true" },
  ]) {
    await assert.rejects(
      transport.estimate(bad),
      (e) => e.code === "invalid_request",
    );
    await assert.rejects(
      transport.chat(bad, options),
      (e) => e.code === "invalid_request",
    );
  }
  assert.equal(bodies.length, sent, "a refused request is never sent");
});
test("a spend-cap hint is sent only when asked for, and validated", async () => {
  const mock = issuer(),
    seen = [];
  mock.authorize = (url) => {
    seen.push(url);
    const callback = new URL("https://app.example/callback");
    callback.searchParams.set("code", "code");
    callback.searchParams.set("state", url.searchParams.get("state"));
    callback.searchParams.set("iss", url.origin);
    return callback.href;
  };
  await new WebSession(mock.config).signIn();
  assert.equal(seen[0].searchParams.has("f2z_spend_cap"), false);
  assert.equal(seen[0].searchParams.has("f2z_spend_period"), false);
  await new WebSession(mock.config).signIn({
    spendCap: { cap2z: 500n, period: "total" },
  });
  assert.equal(seen[1].searchParams.get("f2z_spend_cap"), "500");
  assert.equal(seen[1].searchParams.get("f2z_spend_period"), "total");
  await new WebSession(mock.config).signIn({ spendCap: { cap2z: 7n } });
  assert.equal(seen[2].searchParams.get("f2z_spend_cap"), "7");
  assert.equal(seen[2].searchParams.has("f2z_spend_period"), false);
  for (const spendCap of [
    { cap2z: 0n },
    { cap2z: 2_147_483_648n },
    { cap2z: 500 },
    { cap2z: 500n, period: "year" },
  ])
    await assert.rejects(new WebSession(mock.config).signIn({ spendCap }), {
      code: "invalid_request",
    });
  assert.equal(seen.length, 3, "a refused hint never reaches the browser");
});
test("response_format reaches the gateway exactly, only when set, and is checked first", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  const bodies = [];
  mock.api = (path, init) => {
    bodies.push(init.body);
    return new Response(
      '{"model":"test","input_tokens":1,"max_output_tokens":1800,"hold_2z":1}',
      { headers: { "content-type": "application/json" } },
    );
  };
  const activity = {
    type: "json_schema",
    json_schema: {
      name: "activity_spec",
      schema: {
        type: "object",
        properties: { steps: { type: "array", maxItems: 12n } },
        required: ["steps"],
        additionalProperties: false,
      },
      strict: true,
    },
  };
  // Round trip: bigint in the schema is a JSON integer, members are exact.
  await transport.estimate({ ...request, response_format: activity });
  assert.equal(
    JSON.stringify(JSON.parse(bodies.at(-1)).response_format),
    '{"type":"json_schema","json_schema":{"name":"activity_spec","schema":{"type":"object","properties":{"steps":{"type":"array","maxItems":12}},"required":["steps"],"additionalProperties":false},"strict":true}}',
  );
  await transport.estimate({
    ...request,
    response_format: { type: "json_object" },
  });
  assert.deepEqual(JSON.parse(bodies.at(-1)).response_format, {
    type: "json_object",
  });
  // Absent (or explicitly undefined) is not on the wire.
  await transport.estimate({ ...request, response_format: undefined });
  assert.equal("response_format" in JSON.parse(bodies.at(-1)), false);
  const sent = bodies.length;
  const schema = (json_schema) => ({
    type: "json_schema",
    json_schema: { name: "n", schema: { type: "object" }, ...json_schema },
  });
  for (const bad of [
    null,
    { type: "text" },
    { type: "json_object", schema: {} },
    { type: "json_schema" },
    schema({ name: "" }),
    schema({ name: "has space" }),
    schema({ name: "n".repeat(65) }),
    schema({ schema: [] }),
    schema({ schema: "{}" }),
    schema({ strict: "true" }),
    schema({ description: "not a member" }),
    schema({ schema: { d: "x".repeat(32 * 1024) } }),
  ]) {
    await assert.rejects(
      transport.estimate({ ...request, response_format: bad }),
      (e) => e.code === "invalid_request",
      JSON.stringify(bad).slice(0, 80),
    );
    await assert.rejects(
      transport.chat({ ...request, response_format: bad }, options),
      (e) => e.code === "invalid_request",
    );
  }
  assert.equal(bodies.length, sent, "a refused request is never sent");
});
