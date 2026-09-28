import test from "node:test";
import assert from "node:assert/strict";
import { parseJson, stringifyJson } from "../dist/json.js";
import { nativeData, balance, charge } from "../dist/decode.js";
import { frames } from "../dist/sse.js";
import { readJson } from "../dist/http.js";

test("wire u64 and native decimal DTO preserve all balance digits", () => {
  const text =
    '{"available_milli_2z":18446744073709551615,"held_milli_2z":0,"balance_milli_2z":18446744073709551615,"debt_milli_2z":0,"as_of":"now"}';
  const result = balance(parseJson(text));
  assert.equal(result.available_milli_2z, 18446744073709551615n);
  assert.equal(stringifyJson(result), text);
  const dto = Object.fromEntries(
    Object.entries(result).map(([k, v]) => [
      k,
      typeof v === "bigint" ? String(v) : v,
    ]),
  );
  assert.deepEqual(balance(nativeData(dto)), result);
  assert.throws(() => stringifyJson({ x: 9007199254740992 }), {
    code: "unsafe_integer",
  });
  assert.throws(() => nativeData({ available_milli_2z: "01" }), {
    code: "invalid_response",
  });
});
test("JSON rejects duplicates, excessive depth, unsafe lexemes and trailing data", () => {
  for (const input of [
    '{"a":1,"a":2}',
    "[".repeat(70) + "0" + "]".repeat(70),
    "1".repeat(129),
    "{}null",
    '{"x":NaN}',
  ])
    assert.throws(() => parseJson(input));
  assert.equal(
    parseJson('{"__proto__":{"polluted":true}}').__proto__.polluted,
    true,
  );
  assert.equal({}.polluted, undefined);
});
test("pending and inconsistent receipts never become free calls", () => {
  assert.deepEqual(charge({ settlement: "pending", charged_2z: 0n }), {
    state: "pending",
  });
  assert.deepEqual(
    charge({
      settlement: "settled",
      charged_2z: 1n,
      receipt_id: "r",
      collected_milli_2z: 1n,
      shortfall_milli_2z: 0n,
    }),
    { state: "pending" },
  );
  assert.equal(
    charge({
      settlement: "settled",
      charged_2z: 2n,
      receipt_id: "r",
      collected_milli_2z: 1200n,
      shortfall_milli_2z: 800n,
    }).state,
    "charged",
  );
});
function response(chunks, cancel = () => {}) {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
      cancel,
    }),
  );
}
test("SSE handles split UTF8/newlines/comments/multiline data and ignores cut final event", async () => {
  const wire =
    '\ufeff: ping\r\nevent: delta\r\ndata: {"text":\r\ndata: "🐇"}\r\n\r\nevent: done\ndata: cut';
  const bytes = new TextEncoder().encode(wire);
  const body = new ReadableStream({
    start(c) {
      for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
      c.close();
    },
  });
  const seen = [];
  for await (const frame of frames(
    new Response(body),
    new AbortController().signal,
    1000,
  ))
    seen.push(frame);
  assert.deepEqual(seen, [{ event: "delta", data: '{"text":\n"🐇"}' }]);
});
test("SSE bounds one event and cancels a blocked read", async () => {
  await assert.rejects(
    async () => {
      for await (const _ of frames(
        response(["data: " + "x".repeat(256 * 1024)]),
        new AbortController().signal,
        1000,
      )) {
      }
    },
    { code: "response_too_large" },
  );
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const controller = new AbortController(),
    iterator = frames(new Response(body), controller.signal, 1000);
  const next = iterator.next();
  controller.abort();
  await assert.rejects(next, { code: "cancelled" });
  assert.equal(cancelled, true);
});
test("broken success body does not parse as a completed JSON result", async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"id":"p"'));
      c.error(new Error("private transport detail"));
    },
  });
  await assert.rejects(
    readJson(new Response(body)),
    (error) => error.code === "transport" && !error.message.includes("private"),
  );
});
test("endless empty SSE frames cannot postpone idle deadline", async () => {
  let stopped = false;
  const body = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array());
    },
    cancel() {
      stopped = true;
    },
  });
  await assert.rejects(
    frames(new Response(body), new AbortController().signal, 15).next(),
    { code: "stream_interrupted" },
  );
  assert.equal(stopped, true);
});
