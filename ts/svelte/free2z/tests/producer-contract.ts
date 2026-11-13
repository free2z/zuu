import test from "node:test";
import assert from "node:assert/strict";
import {
  ProducerClient,
  ProducerFailure,
  parseProducer,
} from "../src/lib/producer/client";
const id = "49aa6f7c-d27e-47f4-a28e-8685af4ea4e9";
const stream = (owner: string, state = "draft", version = 1) => ({
  id,
  owner,
  state,
  version,
  title: "Title",
  description: "Description",
  audience: "public",
  access: "free",
  room_id: null,
  participants: null,
  error_code: "",
  ended_at: null,
});
function memory() {
  const rows = new Map<string, string>();
  return {
    getItem: (k: string) => rows.get(k) ?? null,
    setItem: (k: string, v: string) => {
      rows.set(k, v);
    },
    removeItem: (k: string) => {
      rows.delete(k);
    },
  };
}
test("ambiguous HTTP response and reload preserve exact actor-scoped instruction", async () => {
  const store = memory();
  const bodies: unknown[] = [];
  const c = new ProducerClient(
    42,
    async (_m, _p, b) => {
      bodies.push(b);
      throw new TypeError("offline");
    },
    store,
  );
  await assert.rejects(
    c.command("draft", {
      title: "Title",
      description: "Description",
      audience: "public",
      access: "free",
    }),
  );
  const reloaded = new ProducerClient(
    42,
    async (_m, _p, b) => {
      bodies.push(b);
      return { stream: stream(b!.owner), auth_token: null };
    },
    store,
  );
  await reloaded.retry();
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(reloaded.uncertain, false);
  const other = new ProducerClient(43, async () => [], store);
  assert.notEqual(other.owner, c.owner);
});
test("pending action cannot be turned into end or another draft", async () => {
  const c = new ProducerClient(
    42,
    async () => {
      throw new TypeError("offline");
    },
    memory(),
  );
  await assert.rejects(c.command("draft"));
  await assert.rejects(c.command("end"), /retry_pending/);
});
test("renderer rejects invented state, count, access and malformed responses", () => {
  for (const patch of [
    { state: "on-air" },
    { participants: -1 },
    { participants: "10" },
    { access: "paid" },
    { version: 0 },
  ])
    assert.throws(
      () => parseProducer({ ...stream(id), ...patch }),
      ProducerFailure,
    );
});
test("disposed actor ignores in-flight result and cannot issue more commands", async () => {
  let finish: (v: unknown) => void = () => {};
  const c = new ProducerClient(
    42,
    () => new Promise((r) => (finish = r)),
    memory(),
  );
  const pending = c.command("draft");
  c.dispose();
  finish({ stream: stream(c.owner), auth_token: null });
  await assert.rejects(pending, /actor_changed/);
  assert.equal(c.stream, null);
  await assert.rejects(c.command("draft"), /actor_changed/);
});
test("storage refusal prevents every POST, including retry", async () => {
  let calls = 0;
  const c = new ProducerClient(
    42,
    async () => {
      calls++;
      return {};
    },
    undefined,
  );
  await assert.rejects(c.command("draft"), /storage_unavailable/);
  await assert.rejects(c.retry(), /storage_unavailable/);
  assert.equal(calls, 0);
});
test("definite server refusal updates authoritative state and permits cleanup", async () => {
  const c = new ProducerClient(
    42,
    async () => {
      throw new ProducerFailure("provider_unavailable", {
        stream: stream(c.owner, "failed", 3),
        code: "provider_unavailable",
      });
    },
    memory(),
  );
  await assert.rejects(c.command("draft"));
  assert.equal(c.stream?.state, "failed");
  assert.equal(c.uncertain, false);
});
