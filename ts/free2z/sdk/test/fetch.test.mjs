import test from "node:test";
import assert from "node:assert/strict";
import {
  Client,
  FetchTransport,
  MAX_TOOL_ROUNDS,
  ToolCallAccumulator,
  runTools,
} from "../dist/index.js";
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
test("reasoning_effort reaches the gateway exactly, only when set, and is checked first", async () => {
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
  for (const effort of ["minimal", "low", "medium", "high"]) {
    await transport.estimate({ ...request, reasoning_effort: effort });
    assert.equal(JSON.parse(bodies.at(-1)).reasoning_effort, effort);
  }
  // Negative control: absent (or explicitly undefined) is not on the wire.
  await transport.estimate({ ...request, reasoning_effort: undefined });
  assert.equal("reasoning_effort" in JSON.parse(bodies.at(-1)), false);
  await transport.estimate(request);
  assert.equal("reasoning_effort" in JSON.parse(bodies.at(-1)), false);
  const sent = bodies.length;
  for (const bad of [null, "none", "xhigh", "High", "", 1, {}]) {
    await assert.rejects(
      transport.estimate({ ...request, reasoning_effort: bad }),
      (e) => e.code === "invalid_request",
      JSON.stringify(bad),
    );
    await assert.rejects(
      transport.chat({ ...request, reasoning_effort: bad }, options),
      (e) => e.code === "invalid_request",
    );
  }
  assert.equal(bodies.length, sent, "a refused request is never sent");
});
test("estimate decodes the budget fields a paid-call gate reads, and tolerates additive fields", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  // Live prod answer, 2026-10-05.
  const live =
    '{"available_milli_2z":4000,"cap_remaining_milli_2z":4000,"catalog_version":1791205020000000,"hold_2z":1,"input_tokens":180,"max_output_tokens":16,"min_charge_2z":1,"model":"gpt-4o"}';
  let body = live;
  mock.api = () =>
    new Response(body, { headers: { "content-type": "application/json" } });
  const estimate = await transport.estimate(request);
  assert.deepEqual(
    {
      available: estimate.available_milli_2z,
      cap: estimate.cap_remaining_milli_2z,
      min: estimate.min_charge_2z,
      version: estimate.catalog_version,
      hold: estimate.hold_2z,
    },
    {
      available: 4000n,
      cap: 4000n,
      min: 1n,
      version: 1791205020000000n,
      hold: 1n,
    },
  );
  // null is "uncapped", and stays apart from absent.
  body = live.replace(
    '"cap_remaining_milli_2z":4000',
    '"cap_remaining_milli_2z":null',
  );
  const uncapped = await transport.estimate(request);
  assert.equal(uncapped.cap_remaining_milli_2z, null);
  assert.ok("cap_remaining_milli_2z" in uncapped);
  // Optional on decode (chat-api.md §6): absent stays absent, never "uncapped".
  body = '{"model":"m","input_tokens":1,"max_output_tokens":1,"hold_2z":1}';
  const bare = await transport.estimate(request);
  for (const key of [
    "available_milli_2z",
    "cap_remaining_milli_2z",
    "min_charge_2z",
    "catalog_version",
  ])
    assert.equal(key in bare, false, key);
  // A null amount reads as absent, as the Rust proto reads it.
  body = live.replace('"available_milli_2z":4000', '"available_milli_2z":null');
  assert.equal(
    "available_milli_2z" in (await transport.estimate(request)),
    false,
  );
  // Forward compatibility: an unknown field never fails the decode.
  body = live.replace("{", '{"future_field":{"x":1},');
  assert.deepEqual(
    { ...(await transport.estimate(request)).future_field },
    { x: 1n },
  );
  for (const bad of [
    live.replace('"available_milli_2z":4000', '"available_milli_2z":-1'),
    live.replace(
      '"cap_remaining_milli_2z":4000',
      '"cap_remaining_milli_2z":-1',
    ),
    live.replace('"min_charge_2z":1', '"min_charge_2z":"1"'),
    live.replace('"catalog_version":1791205020000000', '"catalog_version":1.5'),
  ]) {
    body = bad;
    await assert.rejects(
      transport.estimate(request),
      (e) => e.code === "invalid_response",
      bad,
    );
  }
});
const checkAnswer = {
  name: "check_answer",
  description: "Grade a student's answer to one question.",
  parameters: {
    type: "object",
    properties: { question_id: { type: "string" }, answer: { type: "string" } },
    required: ["question_id", "answer"],
    additionalProperties: false,
  },
};
test("tool controls reach the gateway exactly, only when set, and are checked first", async () => {
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
  await transport.estimate({
    ...request,
    tools: [{ ...checkAnswer, strict: true }],
    tool_choice: { type: "function", function: { name: "check_answer" } },
    parallel_tool_calls: false,
  });
  const sentBody = JSON.parse(bodies.at(-1));
  assert.deepEqual(sentBody.tools, [{ ...checkAnswer, strict: true }]);
  assert.deepEqual(sentBody.tool_choice, {
    type: "function",
    function: { name: "check_answer" },
  });
  assert.equal(sentBody.parallel_tool_calls, false);
  await transport.estimate({ ...request, tools: [checkAnswer] });
  for (const member of ["tool_choice", "parallel_tool_calls"])
    assert.equal(member in JSON.parse(bodies.at(-1)), false, member);
  assert.equal("strict" in JSON.parse(bodies.at(-1)).tools[0], false);
  const sent = bodies.length;
  for (const bad of [
    { tool_choice: "auto" },
    { parallel_tool_calls: true },
    { tools: [checkAnswer], tool_choice: "any" },
    { tools: [checkAnswer], tool_choice: null },
    {
      tools: [checkAnswer],
      tool_choice: { type: "tool", name: "check_answer" },
    },
    {
      tools: [checkAnswer],
      tool_choice: { type: "function", function: { name: "other" } },
    },
    { tools: [checkAnswer], parallel_tool_calls: "false" },
    { tools: [{ ...checkAnswer, strict: null }] },
    { tools: [{ ...checkAnswer, name: "has space" }] },
    { tools: [checkAnswer, checkAnswer] },
    { tools: [{ ...checkAnswer, parameters: [] }] },
    { tools: [{ ...checkAnswer, parameters: { d: "x".repeat(32 * 1024) } }] },
    {
      tools: Array.from({ length: 129 }, (_, i) => ({
        ...checkAnswer,
        name: `f${i}`,
      })),
    },
  ]) {
    await assert.rejects(
      transport.estimate({ ...request, ...bad }),
      (e) => e.code === "invalid_request",
      JSON.stringify(bad).slice(0, 80),
    );
    await assert.rejects(
      transport.chat({ ...request, ...bad }, options),
      (e) => e.code === "invalid_request",
    );
  }
  assert.equal(bodies.length, sent, "a refused request is never sent");
});
const sse = (events) =>
  events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
const turn = (callId, middle, finish) =>
  sse([
    ["meta", { call_id: callId, model: "test", hold_2z: 1 }],
    ...middle,
    [
      "usage",
      { usage: { input_tokens: 10, output_tokens: 5 }, source: "provider" },
    ],
    [
      "done",
      { finish_reason: finish, charged_2z: 1, receipt_id: `rcpt_${callId}` },
    ],
  ]);
test("tool_call_delta fragments decode, assemble, and precede the authoritative call", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  const args = '{"question_id":"q1","answer":"x = 4"}';
  mock.api = () =>
    new Response(
      turn(
        "call-1",
        [
          [
            "tool_call_delta",
            { index: 0, id: "call_q1", name: "check_answer", arguments: "" },
          ],
          ["tool_call_delta", { index: 0, arguments: args.slice(0, 10) }],
          ["tool_call_delta", { index: 0, arguments: args.slice(10) }],
          [
            "tool_call",
            { id: "call_q1", name: "check_answer", arguments: args },
          ],
        ],
        "tool_calls",
      ),
      { headers: { "content-type": "text/event-stream" } },
    );
  const stream = await transport.chat(
    { ...request, tools: [checkAnswer] },
    options,
  );
  const live = new ToolCallAccumulator();
  const types = [];
  for await (const event of stream) {
    types.push(event.type);
    if (event.type === "tool_call_delta") {
      assert.equal(typeof event.index, "number");
      live.push(event);
    }
  }
  assert.deepEqual(types, [
    "meta",
    "tool_call_delta",
    "tool_call_delta",
    "tool_call_delta",
    "tool_call",
    "usage",
    "done",
  ]);
  assert.deepEqual(live.calls, [
    { id: "call_q1", name: "check_answer", arguments: args },
  ]);
});
test("runTools runs each call, answers it, relaxes a forced choice, and needs caller keys", async () => {
  const mock = issuer(),
    client = new Client(new FetchTransport(mock.config));
  await client.signIn();
  const bodies = [];
  mock.api = (path, init) => {
    bodies.push(JSON.parse(init.body));
    const body =
      bodies.length === 1
        ? turn(
            "call-1",
            [
              [
                "tool_call",
                {
                  id: "call_q1",
                  name: "check_answer",
                  arguments: '{"question_id":"q1","answer":"4"}',
                },
              ],
            ],
            "tool_calls",
          )
        : turn("call-2", [["delta", { text: "Correct!" }]], "stop");
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const graded = [];
  const keys = [];
  const run = await runTools(
    client,
    {
      ...request,
      messages: [
        { role: "user", content: [{ type: "text", text: "2x+3=11, x=4" }] },
      ],
      tools: [checkAnswer],
      tool_choice: { type: "function", function: { name: "check_answer" } },
    },
    (call) => {
      graded.push(JSON.parse(call.arguments));
      return '{"correct":true}';
    },
    {
      operation: (round) => {
        const op = {
          operationId: `op-${round}`,
          idempotencyKey: `key-${round}`,
        };
        keys.push(op.idempotencyKey);
        return op;
      },
    },
  );
  assert.equal(run.finished, true);
  assert.equal(run.rounds.length, 2);
  assert.deepEqual(keys, ["key-0", "key-1"]);
  assert.deepEqual(graded, [{ question_id: "q1", answer: "4" }]);
  assert.deepEqual(
    run.rounds.map((r) => r.charge.state),
    ["charged", "charged"],
  );
  assert.equal(run.rounds[1].text, "Correct!");
  // Round 2 carries the call and its result, and is no longer forced.
  assert.equal(bodies[1].tool_choice, "auto");
  assert.deepEqual(bodies[1].messages.slice(1), [
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call_q1",
          name: "check_answer",
          arguments: '{"question_id":"q1","answer":"4"}',
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_q1",
      content: [{ type: "text", text: '{"correct":true}' }],
    },
  ]);
  // A later round's failure keeps the paid round and the tool result, and
  // a cancel between tools stops the next handler.
  bodies.length = 0;
  graded.length = 0;
  const twoCalls = turn(
    "call-4",
    [
      ["tool_call", { id: "call_a", name: "check_answer", arguments: "{}" }],
      ["tool_call", { id: "call_b", name: "check_answer", arguments: "{}" }],
    ],
    "tool_calls",
  );
  mock.api = (path, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1
      ? new Response(twoCalls, {
          headers: { "content-type": "text/event-stream" },
        })
      : new Response(
          '{"error":{"code":"insufficient_balance","message":"x","details":{"available_milli_2z":0,"required_2z":1}}}',
          { status: 402, headers: { "content-type": "application/json" } },
        );
  };
  const failed = await runTools(
    client,
    { ...request, tools: [checkAnswer] },
    (call) => {
      graded.push(call.id);
      return "{}";
    },
    {
      operation: (round) => ({
        operationId: `f-${round}`,
        idempotencyKey: `f-${round}`,
      }),
    },
  );
  assert.equal(failed.finished, false);
  assert.equal(failed.rounds.length, 1);
  assert.equal(failed.rounds[0].charge.state, "charged");
  assert.deepEqual(graded, ["call_a", "call_b"]);
  assert.deepEqual(
    failed.operations.map((o) => o.idempotencyKey),
    ["f-0", "f-1"],
  );
  assert.equal(failed.error?.code, "insufficient_balance");
  assert.equal(failed.messages.at(-1).tool_call_id, "call_b");
  bodies.length = 0;
  graded.length = 0;
  const control = new AbortController();
  const cancelled = await runTools(
    client,
    { ...request, tools: [checkAnswer] },
    (call) => {
      graded.push(call.id);
      control.abort(); // the user cancels while the first tool runs
      return "{}";
    },
    {
      operation: (round) => ({
        operationId: `c-${round}`,
        idempotencyKey: `c-${round}`,
        signal: control.signal,
      }),
    },
  );
  assert.deepEqual(graded, ["call_a"], "a handler ran after cancellation");
  assert.equal(cancelled.error?.code, "cancelled");
  assert.equal(bodies.length, 1);
  // A turn cut off at the output cap never runs its (truncated) call.
  bodies.length = 0;
  graded.length = 0;
  mock.api = (path, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      turn(
        "call-3",
        [
          [
            "tool_call",
            { id: "call_cut", name: "check_answer", arguments: '{"answer":' },
          ],
        ],
        "length",
      ),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const cut = await runTools(
    client,
    { ...request, tools: [checkAnswer] },
    (call) => {
      graded.push(call);
      return "{}";
    },
    {
      operation: (round) => ({
        operationId: `cut-${round}`,
        idempotencyKey: `cut-${round}`,
      }),
    },
  );
  assert.equal(cut.finished, false);
  assert.equal(cut.rounds.length, 1);
  assert.equal(graded.length, 0, "a truncated call reached the handler");
  assert.equal(bodies.length, 1, "no further paid round after a cut-off turn");
  // Negative control: maxRounds 1 stops with the call unrun.
  bodies.length = 0;
  graded.length = 0;
  const capped = await runTools(
    client,
    { ...request, tools: [checkAnswer] },
    () => "{}",
    {
      maxRounds: 1,
      operation: (round) => ({
        operationId: `cap-${round}`,
        idempotencyKey: `cap-${round}`,
      }),
    },
  );
  assert.equal(capped.finished, false);
  assert.equal(capped.rounds.length, 1);
  assert.equal(graded.length, 0);
  // The round bound is a hard ceiling: 0 or above MAX_TOOL_ROUNDS throws
  // before any paid call; the ceiling itself is accepted (control above).
  bodies.length = 0;
  for (const maxRounds of [0, MAX_TOOL_ROUNDS + 1, Number.MAX_SAFE_INTEGER])
    await assert.rejects(
      runTools(client, { ...request, tools: [checkAnswer] }, () => "{}", {
        maxRounds,
        operation: (round) => ({
          operationId: `over-${round}`,
          idempotencyKey: `over-${round}`,
        }),
      }),
      (error) => error.code === "invalid_request",
    );
  assert.equal(bodies.length, 0, "a refused bound sent a call");
  const ceiling = await runTools(
    client,
    { ...request, tools: [checkAnswer] },
    () => "{}",
    {
      maxRounds: MAX_TOOL_ROUNDS,
      operation: (round) => ({
        operationId: `ceil-${round}`,
        idempotencyKey: `ceil-${round}`,
      }),
    },
  );
  assert.equal(ceiling.rounds.length, 1);
});
test("models types capabilities, prices and limits, and tolerates additive fields", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  // Live prod model, 2026-10-05.
  const gpt4o =
    '{"id":"gpt-4o","provider":"openai","display_name":"gpt-4o","context_window":128000,"max_output_tokens":16384,"capabilities":{"vision":false,"tools":false,"reasoning":false,"structured_output":true},"prices":{"cache_write_milli_2z_per_mtok":300000,"cached_input_milli_2z_per_mtok":150000,"image_milli_2z":0,"input_milli_2z_per_mtok":300000,"output_milli_2z_per_mtok":1200000,"tool_call_milli_2z":0},"min_charge_2z":1,"ttfb_timeout_ms":60000}';
  const catalog = (model) =>
    `{"catalog_version":1791205020000000,"includes_markup_bps":0,"models":[${model}]}`;
  let body = catalog(gpt4o);
  mock.api = () =>
    new Response(body, { headers: { "content-type": "application/json" } });
  const live = await transport.models();
  assert.equal(live.catalog_version, 1791205020000000n);
  assert.equal(live.includes_markup_bps, 0n);
  const [m] = live.models;
  assert.deepEqual(
    {
      id: m.id,
      provider: m.provider,
      display_name: m.display_name,
      context_window: m.context_window,
      max_output_tokens: m.max_output_tokens,
      min_charge_2z: m.min_charge_2z,
      ttfb_timeout_ms: m.ttfb_timeout_ms,
    },
    {
      id: "gpt-4o",
      provider: "openai",
      display_name: "gpt-4o",
      context_window: 128000n,
      max_output_tokens: 16384n,
      min_charge_2z: 1n,
      ttfb_timeout_ms: 60000n,
    },
  );
  assert.equal(m.capabilities.structured_output, true);
  assert.equal(m.capabilities.tools, false);
  // gpt-4o declares no reasoning_effort, and nothing is narrowed.
  assert.notEqual(m.capabilities.reasoning_effort, true);
  assert.deepEqual({ ...m.controls }, {});
  assert.equal(m.prices.input_milli_2z_per_mtok, 300000n);
  assert.equal(m.prices.output_milli_2z_per_mtok, 1200000n);
  assert.equal(m.prices.image_milli_2z, 0n);
  // An older gateway: no capabilities, no prices → {} (nothing supported).
  body = catalog('{"id":"old"}');
  const old = (await transport.models()).models[0];
  assert.deepEqual({ ...old.capabilities }, {});
  assert.deepEqual({ ...old.controls }, {});
  assert.deepEqual({ ...old.prices }, {});
  assert.notEqual(old.capabilities.structured_output, true);
  for (const key of ["provider", "context_window", "min_charge_2z"])
    assert.equal(key in old, false, key);
  assert.equal(
    "includes_markup_bps" in
      (await (async () => {
        body = '{"catalog_version":1,"models":[]}';
        return transport.models();
      })()),
    false,
  );
  // null reads as absent, as the Rust SDK reads it.
  body = catalog(
    '{"id":"n","provider":null,"context_window":null,"capabilities":null,"prices":{"input_milli_2z_per_mtok":null}}',
  );
  const nulls = (await transport.models()).models[0];
  assert.equal("provider" in nulls, false);
  assert.equal("context_window" in nulls, false);
  assert.deepEqual({ ...nulls.capabilities }, {});
  assert.deepEqual({ ...nulls.prices }, {});
  // Forward compatibility: unknown capabilities, rates and model keys pass.
  body = catalog(
    gpt4o
      .replace('"vision":false', '"audio":true,"vision":false')
      .replace(
        '"image_milli_2z":0',
        '"audio_milli_2z_per_mtok":7,"image_milli_2z":0,"tier":"std"',
      )
      .replace("{", '{"future_field":{"x":1},'),
  );
  const next = (await transport.models()).models[0];
  assert.equal(next.capabilities.audio, true);
  assert.equal(next.capabilities.structured_output, true);
  assert.equal(next.prices.audio_milli_2z_per_mtok, 7n);
  assert.equal(next.prices.tier, "std");
  assert.deepEqual({ ...next.future_field }, { x: 1n });
  // A reasoning model with its signed effort levels.
  body = catalog(
    gpt4o
      .replace(
        '"structured_output":true',
        '"structured_output":true,"reasoning_effort":true',
      )
      .replace(
        '"prices"',
        '"controls":{"effort_levels":["low","medium","high"]},"prices"',
      ),
  );
  const o3 = (await transport.models()).models[0];
  assert.equal(o3.capabilities.reasoning_effort, true);
  assert.deepEqual(o3.controls.effort_levels, ["low", "medium", "high"]);
  body = catalog(
    gpt4o.replace('"prices"', '"controls":{"effort_levels":null},"prices"'),
  );
  assert.deepEqual({ ...(await transport.models()).models[0].controls }, {});
  for (const bad of [
    gpt4o.replace('"structured_output":true', '"structured_output":"true"'),
    gpt4o.replace(
      '"structured_output":true',
      '"structured_output":true,"reasoning_effort":"true"',
    ),
    gpt4o.replace('"prices"', '"controls":{"effort_levels":"low"},"prices"'),
    gpt4o.replace('"prices"', '"controls":{"effort_levels":[1]},"prices"'),
    gpt4o.replace('"prices"', '"controls":["low"],"prices"'),
    gpt4o.replace('"tools":false', '"tools":0'),
    gpt4o.replace(
      '"capabilities":{"vision":false,"tools":false,"reasoning":false,"structured_output":true}',
      '"capabilities":["structured_output"]',
    ),
    gpt4o.replace('"id":"gpt-4o"', '"id":""'),
    gpt4o.replace('"id":"gpt-4o"', '"id":7'),
    gpt4o.replace('"provider":"openai"', '"provider":1'),
    gpt4o.replace('"context_window":128000', '"context_window":-1'),
    gpt4o.replace(
      '"input_milli_2z_per_mtok":300000',
      '"input_milli_2z_per_mtok":"300000"',
    ),
    gpt4o.replace('"min_charge_2z":1', '"min_charge_2z":1.5'),
  ]) {
    body = catalog(bad);
    await assert.rejects(
      transport.models(),
      (e) => e.code === "invalid_response",
      bad,
    );
  }
});
test("a chat pinned to an old session generation is refused before sending", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  let sends = 0;
  mock.api = () => {
    sends++;
    return new Response("", { status: 500 });
  };
  const { generation } = await transport.session();
  await assert.rejects(
    transport.chat(request, {
      ...options,
      sessionGeneration: `${generation}-old`,
    }),
    (e) => e.code === "signed_out",
  );
  assert.equal(sends, 0);
});

test("a cancel during the last handler stops the run even if the next round's options are fresh", async () => {
  const mock = issuer(),
    client = new Client(new FetchTransport(mock.config));
  await client.signIn();
  let sends = 0;
  mock.api = () => {
    sends++;
    return new Response(
      turn(
        `call-${sends}`,
        [
          [
            "tool_call",
            { id: "call_a", name: "check_answer", arguments: "{}" },
          ],
        ],
        "tool_calls",
      ),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const first = new AbortController();
  const run = await runTools(
    client,
    { ...request, tools: [checkAnswer] },
    () => {
      first.abort(); // the user cancels while the (last) tool runs
      return "{}";
    },
    {
      operation: (round) => ({
        operationId: `x-${round}`,
        idempotencyKey: `x-${round}`,
        // A fresh controller per round: the next round's signal is not aborted.
        signal: round === 0 ? first.signal : new AbortController().signal,
      }),
    },
  );
  assert.equal(sends, 1, "a paid round was sent after cancellation");
  assert.equal(run.error?.code, "cancelled");
  assert.equal(run.finished, false);
});

test("a round that fails after output keeps its charge, and handlers get the run's session", async () => {
  const mock = issuer(),
    client = new Client(new FetchTransport(mock.config));
  await client.signIn();
  const { generation } = await client.session();
  let sends = 0;
  mock.api = () => {
    sends++;
    const body =
      sends === 1
        ? turn(
            "call-1",
            [
              [
                "tool_call",
                { id: "call_a", name: "check_answer", arguments: "{}" },
              ],
            ],
            "tool_calls",
          )
        : sse([
            ["meta", { call_id: "call-2", model: "test", hold_2z: 2 }],
            ["delta", { text: "Partly" }],
            [
              "usage",
              {
                usage: { input_tokens: 10, output_tokens: 5 },
                source: "provider",
              },
            ],
            [
              "error",
              {
                code: "provider_error",
                partial: true,
                charged_2z: 2,
                receipt_id: "rcpt_2",
                settlement: "settled",
              },
            ],
          ]);
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const contexts = [];
  const run = await runTools(
    client,
    { ...request, tools: [checkAnswer] },
    (call, context) => {
      contexts.push(context);
      return "{}";
    },
    {
      operation: (round) => ({
        operationId: `e-${round}`,
        idempotencyKey: `e-${round}`,
      }),
    },
  );
  assert.deepEqual(
    contexts.map((c) => c.sessionGeneration),
    [generation],
  );
  assert.equal(run.rounds.length, 2, "the failed, charged round is kept");
  assert.equal(run.rounds[1].error, "provider_error");
  assert.equal(run.rounds[1].charge.state, "charged");
  assert.equal(run.rounds[1].charge.charged2z, 2n);
  assert.equal(run.error?.code, "provider_error");
  assert.equal(run.finished, false);
  // Its partial output is not history.
  assert.equal(run.messages.at(-1).role, "tool");
});
