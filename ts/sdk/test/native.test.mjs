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
    controller = new AbortController();
  let cancels = 0,
    registered = false,
    cancelledRegistered = false;
  const b = bridge({
    startChat: () => start.promise,
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
