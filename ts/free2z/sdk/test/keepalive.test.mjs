// zuu#1163: the gateway's `: ping` keep-alive comments (chat-api.md §3) reset
// the fetch transport's 45 s idle watchdog and never surface as events; and
// without them a model that is silent for longer than that before `meta`
// loses its stream. The watchdog's timer runs on node:test's mock clock, so
// the 50 s silence costs no wall time.
import test from "node:test";
import assert from "node:assert/strict";
import { FetchTransport } from "../dist/index.js";
import { issuer } from "./issuer.mjs";

const options = { operationId: "operation-1", idempotencyKey: "durable-key" };
const request = { model: "test", messages: [] };
const bytes = (s) => new TextEncoder().encode(s);
const PING = ": ping\n\n";
const ANSWER =
  'event: meta\ndata: {"call_id":"call-1","model":"test","hold_2z":1}\n\n' +
  'event: delta\ndata: {"text":"thought about it"}\n\n' +
  'event: done\ndata: {"finish_reason":"stop","settlement":"pending"}\n\n';

/** Let the reader take what was enqueued and arm its next idle timer. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A chat whose response body the test writes by hand: the headers arrive at
 * once (the gateway sends them when the hold exists), the body later.
 */
async function silentChat() {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  let body;
  mock.api = () =>
    new Response(
      new ReadableStream({
        start(c) {
          body = c;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const stream = await transport.chat(request, options);
  return { stream, body };
}

/** Collect every event, recording a failure instead of throwing it. */
function drain(stream) {
  const events = [];
  const done = (async () => {
    try {
      for (;;) {
        const item = await stream.next();
        if (item.done) return { events };
        events.push(item.value.type);
      }
    } catch (error) {
      return { events, error };
    }
  })();
  return { events, done };
}

test("pings keep a stream alive through a 50 s silence before meta and are never events", async (t) => {
  const { stream, body } = await silentChat();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reading = drain(stream);
  await settle();
  // 15, 30 and 45 s into the silence, as the gateway sends them.
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(15_000);
    await settle();
    body.enqueue(bytes(PING));
    await settle();
  }
  t.mock.timers.tick(5_000);
  await settle();
  body.enqueue(bytes(ANSWER));
  body.close();
  const { events, error } = await reading.done;
  assert.equal(error, undefined);
  assert.deepEqual(events, ["meta", "delta", "done"]);
});

test("without pings the same silence trips the 45 s watchdog", async (t) => {
  // The negative control: identical, minus the comments.
  const { stream, body } = await silentChat();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reading = drain(stream);
  await settle();
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(15_000);
    await settle();
  }
  const { events, error } = await reading.done;
  assert.deepEqual(events, []);
  assert.equal(error?.code, "stream_interrupted");
  assert.equal(error?.idempotencyKey, "durable-key");
  // The answer the gateway went on to produce never reaches anyone.
  assert.throws(() => body.enqueue(bytes(ANSWER)));
});
