import test from "node:test";
import assert from "node:assert/strict";
import { Client, NativeTransport } from "../dist/index.js";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const options = { operationId: "operation-1", idempotencyKey: "durable-key" };
const request = { model: "test", messages: [] };
function bridge(extra = {}) {
  return {
    session: async () => ({
      signedIn: true,
      subject: "alice",
      grantedScopes: [],
      persistence: "persistent",
      generation: "1",
    }),
    ...extra,
  };
}

test("native adapter converts request quantities without rounding and pulls one event at a time", async () => {
  let sent,
    reads = 0,
    stops = 0;
  const b = bridge({
    startChat: async (r, o) => {
      sent = { r, o };
      return { operationId: o.operationId };
    },
    nextChat: async () => {
      reads++;
      return reads === 1
        ? {
            type: "meta",
            call_id: "call-1",
            model: "test",
            hold_2z: "18446744073709551615",
          }
        : {
            type: "done",
            finish_reason: "stop",
            charge: { state: "charged", charged2z: "2", receiptId: "r" },
          };
    },
    cancelChat: async () => {
      stops++;
    },
  });
  const stream = await new NativeTransport(b).chat(
    { ...request, max_output_tokens: 18446744073709551615n },
    options,
  );
  assert.equal(sent.r.max_output_tokens, "18446744073709551615");
  assert.deepEqual(sent.o, options);
  assert.equal(reads, 0);
  assert.equal((await stream.next()).value.hold_2z, 18446744073709551615n);
  assert.equal(reads, 1);
  assert.equal((await stream.next()).value.charge.charged2z, 2n);
  assert.equal((await stream.next()).done, true);
  assert.equal(reads, 2);
  assert.equal(stops, 0);
});
test("cancel during native start retries cancellation after registration and retains recovery key", async () => {
  const start = deferred(),
    started = deferred(),
    controller = new AbortController();
  let cancels = 0,
    registered = false,
    cancelledRegistered = false;
  const b = bridge({
    startChat: () => {
      started.resolve();
      return start.promise;
    },
    cancelChat: async () => {
      cancels++;
      if (!registered) throw { code: "operation_not_found" };
      cancelledRegistered = true;
    },
  });
  const pending = new NativeTransport(b).chat(request, {
    ...options,
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  await assert.rejects(
    pending,
    (e) =>
      e.code === "cancelled" && e.idempotencyKey === options.idempotencyKey,
  );
  registered = true;
  start.resolve({ operationId: options.operationId });
  await new Promise((r) => setImmediate(r));
  assert.equal(cancels >= 2, true);
  assert.equal(cancelledRegistered, true);
});
test("native rejects simultaneous stream readers and cancels the blocked read", async () => {
  const read = deferred();
  let cancels = 0;
  const controller = new AbortController();
  const stream = await new NativeTransport(
    bridge({
      startChat: async () => ({ operationId: options.operationId }),
      nextChat: () => read.promise,
      cancelChat: async () => {
        cancels++;
        read.resolve(null);
      },
    }),
  ).chat(request, { ...options, signal: controller.signal });
  const first = stream.next();
  await assert.rejects(stream.next(), { code: "concurrent_stream_read" });
  controller.abort();
  await assert.rejects(
    first,
    (e) => e.code === "cancelled" && e.idempotencyKey === "durable-key",
  );
  assert.equal(cancels > 0, true);
});
test("native purchase failure retains caller key and drops raw native diagnostics", async () => {
  const client = new NativeTransport(
    bridge({
      createPurchase: async () => {
        throw {
          code: "unconfirmed",
          message: "bearer secret",
          retryAfterSeconds: "18446744073709551615",
        };
      },
    }),
  );
  await assert.rejects(
    client.createPurchase({ rail: "card", quantity2z: 1n }, options),
    (e) =>
      e.code === "unconfirmed" &&
      e.idempotencyKey === "durable-key" &&
      !e.message.includes("secret") &&
      e.retryAfterSeconds === 86400,
  );
});
test("native sign-in cancellation is explicitly rejected before opening browser", async () => {
  let called = false;
  const client = new NativeTransport(
    bridge({
      signIn: async () => {
        called = true;
      },
    }),
  );
  await assert.rejects(
    client.signIn({ signal: new AbortController().signal }),
    { code: "native_sign_in_signal_unsupported" },
  );
  assert.equal(called, false);
});
test("polling deadline returns paid purchase and pending charge without claiming settlement", async () => {
  const client = new Client({
    purchase: async () => ({ status: "paid" }),
    call: async () => ({ charge: { state: "pending" } }),
  });
  assert.equal(
    (await client.waitForPurchase("p", { timeoutMs: 0 })).status,
    "paid",
  );
  assert.equal(
    (await client.waitForCall("c", { timeoutMs: 0 })).charge.state,
    "pending",
  );
});
test("native receipt metadata remains caller strings through call lookup and replay", async () => {
  const record = {
    call_id: "call-1",
    status: "settled",
    charge: { state: "charged", charged2z: "2", receiptId: "receipt" },
    metadata: { input_tokens: "lesson-1", hold_2z: "42" },
    extension: { input_tokens: "not-a-protocol-count" },
  };
  const client = new NativeTransport(
    bridge({
      call: async () => record,
      startChat: async () => ({
        operationId: options.operationId,
        replay: record,
      }),
      cancelChat: async () => {},
    }),
  );
  for (const received of [
    await client.call("call-1"),
    (await (await client.chat(request, options)).next()).value.record,
  ]) {
    assert.deepEqual({ ...received.metadata }, record.metadata);
    assert.equal(received.extension.input_tokens, "not-a-protocol-count");
    assert.equal(received.charge.charged2z, 2n);
  }
});
test("native buffered replay is invalidated on sign-out and account switch", async () => {
  for (const transition of ["signOut", "signIn"]) {
    let generation = "1";
    const session = () => ({
      signedIn: true,
      subject: generation === "1" ? "alice" : "bob",
      grantedScopes: [],
      persistence: "persistent",
      generation,
    });
    const record = {
      call_id: "alice-call",
      status: "released",
      charge: { state: "released", charged2z: "0" },
    };
    const client = new NativeTransport(
      bridge({
        session: async () => session(),
        startChat: async () => ({
          operationId: options.operationId,
          replay: record,
        }),
        cancelChat: async () => {},
        signOut: async () => {
          generation = "2";
          return { revoked: true, generation };
        },
        signIn: async () => {
          generation = "2";
          return session();
        },
      }),
    );
    const stream = await client.chat(request, options);
    await client[transition]();
    await assert.rejects(
      stream.next(),
      (e) =>
        e.code === "signed_out" && e.idempotencyKey === options.idempotencyKey,
    );
  }
});
test("native buffered replay detects a session replaced through another bridge caller", async () => {
  let generation = "1";
  const client = new NativeTransport(
    bridge({
      session: async () => ({
        signedIn: true,
        subject: "user",
        grantedScopes: [],
        persistence: "persistent",
        generation,
      }),
      startChat: async () => ({
        operationId: options.operationId,
        replay: {
          call_id: "old-call",
          status: "released",
          charge: { state: "released", charged2z: "0" },
        },
      }),
      cancelChat: async () => {},
    }),
  );
  const stream = await client.chat(request, options);
  generation = "2";
  await assert.rejects(stream.next(), { code: "signed_out" });
});
test("native cancel discards a reply that was already in flight", async () => {
  const read = deferred(),
    reading = deferred();
  const client = new NativeTransport(
    bridge({
      startChat: async () => ({ operationId: options.operationId }),
      nextChat: () => {
        reading.resolve();
        return read.promise;
      },
      cancelChat: async () => {},
    }),
  );
  const stream = await client.chat(request, options),
    pending = stream.next();
  await reading.promise;
  await stream.cancel();
  read.resolve({ type: "delta", text: "late private text" });
  assert.equal((await pending).done, true);
});
test("native opening failure preserves the server call ID when no stream was returned", async () => {
  const client = new NativeTransport(
    bridge({
      startChat: async () => {
        throw { code: "unconfirmed", callId: "known-call" };
      },
      cancelChat: async () => {},
    }),
  );
  await assert.rejects(
    client.chat(request, options),
    (e) =>
      e.code === "unconfirmed" &&
      e.callId === "known-call" &&
      e.idempotencyKey === options.idempotencyKey,
  );
});
test("native adapter forwards max_output_tokens_strict only when true", async () => {
  const seen = [];
  const b = bridge({
    estimate: async (r) => {
      seen.push(r);
      return {
        model: "test",
        input_tokens: "1",
        max_output_tokens: "1800",
        hold_2z: "1",
      };
    },
    startChat: async (r, o) => {
      seen.push(r);
      return { operationId: o.operationId };
    },
  });
  const transport = new NativeTransport(b);
  const limited = { ...request, max_output_tokens: 1800n };
  await transport.estimate({ ...limited, max_output_tokens_strict: true });
  assert.equal(seen.at(-1).max_output_tokens_strict, true);
  await transport.chat({ ...limited, max_output_tokens_strict: true }, options);
  assert.equal(seen.at(-1).max_output_tokens_strict, true);
  assert.equal(seen.at(-1).max_output_tokens, "1800");
  await transport.estimate({ ...limited, max_output_tokens_strict: false });
  assert.equal("max_output_tokens_strict" in seen.at(-1), false);
  const before = seen.length;
  await assert.rejects(
    transport.chat({ ...request, max_output_tokens_strict: true }, options),
    (e) => e.code === "invalid_request",
  );
  assert.equal(seen.length, before);
});
test("native sign-in forwards a spend-cap hint as decimal strings, only when given", async () => {
  const sent = [];
  const client = new NativeTransport(
    bridge({
      signIn: async (options) => {
        sent.push(options);
        return {
          signedIn: true,
          subject: "alice",
          grantedScopes: [],
          persistence: "persistent",
          generation: "2",
        };
      },
    }),
  );
  await client.signIn();
  await client.signIn({ spendCap: { cap2z: 500n, period: "total" } });
  await client.signIn({ prompt: "consent", spendCap: { cap2z: 9n } });
  assert.deepEqual(sent, [
    {},
    { spendCap: "500", spendPeriod: "total" },
    { prompt: "consent", spendCap: "9" },
  ]);
  await assert.rejects(client.signIn({ spendCap: { cap2z: -1n } }), {
    code: "invalid_request",
  });
  assert.equal(sent.length, 3);
});
test("native adapter forwards response_format as plain JSON, only when set", async () => {
  const seen = [];
  const b = bridge({
    estimate: async (r) => {
      seen.push(r);
      return {
        model: "test",
        input_tokens: "1",
        max_output_tokens: "1800",
        hold_2z: "1",
      };
    },
    startChat: async (r, o) => {
      seen.push(r);
      return { operationId: o.operationId };
    },
  });
  const transport = new NativeTransport(b);
  const format = {
    type: "json_schema",
    json_schema: {
      name: "activity_spec",
      schema: { type: "object", properties: { n: { maximum: 9n } } },
      strict: true,
    },
  };
  await transport.chat({ ...request, response_format: format }, options);
  // The schema is ordinary JSON over IPC: bigint becomes a number, never
  // the decimal-string quantity codec. (Converted objects are null-prototype.)
  assert.deepEqual(JSON.parse(JSON.stringify(seen.at(-1).response_format)), {
    type: "json_schema",
    json_schema: {
      name: "activity_spec",
      schema: { type: "object", properties: { n: { maximum: 9 } } },
      strict: true,
    },
  });
  await transport.estimate({
    ...request,
    response_format: { type: "json_object" },
  });
  assert.deepEqual(seen.at(-1).response_format, { type: "json_object" });
  await transport.estimate(request);
  assert.equal("response_format" in seen.at(-1), false);
  const before = seen.length;
  await assert.rejects(
    transport.chat(
      { ...request, response_format: { type: "text" } },
      { ...options, operationId: "operation-2" },
    ),
    (e) => e.code === "invalid_request",
  );
  assert.equal(seen.length, before);
});
test("native estimate decodes the budget fields from decimal strings", async () => {
  let answer;
  const transport = new NativeTransport(
    bridge({ estimate: async () => answer }),
  );
  const base = {
    model: "gpt-4o",
    input_tokens: "180",
    max_output_tokens: "16",
    hold_2z: "1",
    min_charge_2z: "1",
    available_milli_2z: "4000",
    cap_remaining_milli_2z: "4000",
    catalog_version: "1791205020000000",
  };
  answer = base;
  const estimate = await transport.estimate(request);
  assert.equal(estimate.available_milli_2z, 4000n);
  assert.equal(estimate.cap_remaining_milli_2z, 4000n);
  assert.equal(estimate.min_charge_2z, 1n);
  assert.equal(estimate.catalog_version, 1791205020000000n);
  answer = { ...base, cap_remaining_milli_2z: null };
  assert.equal(
    (await transport.estimate(request)).cap_remaining_milli_2z,
    null,
  );
  answer = { ...base, future_field: { x: "1" } };
  assert.deepEqual(
    { ...(await transport.estimate(request)).future_field },
    {
      x: "1",
    },
  );
  const {
    available_milli_2z,
    cap_remaining_milli_2z,
    min_charge_2z,
    catalog_version,
    ...older
  } = base;
  answer = older;
  const bare = await transport.estimate(request);
  assert.equal("cap_remaining_milli_2z" in bare, false);
  assert.equal("available_milli_2z" in bare, false);
  for (const bad of [
    { ...base, available_milli_2z: "-1" },
    { ...base, cap_remaining_milli_2z: "01" },
  ]) {
    answer = bad;
    await assert.rejects(
      transport.estimate(request),
      (e) => e.code === "invalid_response",
    );
  }
});

test("native sign-in rejection codes reach the app unchanged and are never retryable", async () => {
  for (const code of [
    "user_cancelled",
    "browser_unavailable",
    "timeout",
    "browser_error",
  ]) {
    const client = new Client(
      new NativeTransport(
        bridge({
          signIn: async () => {
            throw { code, retryable: false };
          },
        }),
      ),
    );
    await assert.rejects(
      client.signIn(),
      (e) => e.name === "SdkError" && e.code === code && e.retryable === false,
    );
  }
});
