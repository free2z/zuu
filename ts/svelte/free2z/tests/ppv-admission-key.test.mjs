import assert from "node:assert/strict";
import test from "node:test";
import { clearPpvJoinKey, ppvJoinKey } from "../src/lib/ppv-admission-key.js";
import { listenForPpvAdmissionJoin } from "../src/lib/ppv-admission-join.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test("PPV keys are scoped to their actual provider session", () => {
  const previous = globalThis.sessionStorage;
  globalThis.sessionStorage = storage();
  try {
    const sessionA = "00000000-0000-4000-8000-000000000001";
    const sessionB = "00000000-0000-4000-8000-000000000002";
    const first = ppvJoinKey("ppv-key-race", 719001, sessionA, "ppv");
    const later = ppvJoinKey("ppv-key-race", 719001, sessionB, "ppv");

    assert.notEqual(first, later);
    clearPpvJoinKey("ppv-key-race", 719001, first, sessionA, "ppv");
    assert.equal(ppvJoinKey("ppv-key-race", 719001, sessionB, "ppv"), later);
  } finally {
    if (previous === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previous;
  }
});

test("unscoped legacy keys are not adopted and meeting types remain isolated", () => {
  const previous = globalThis.sessionStorage;
  const currentStorage = storage();
  globalThis.sessionStorage = currentStorage;
  try {
    currentStorage.setItem(
      "f2z:ppv-join:ppv-key-legacy:719002",
      "legacy-admission-key",
    );
    const session = "00000000-0000-4000-8000-000000000003";
    const adopted = ppvJoinKey("ppv-key-legacy", 719002, session, "ppv");
    assert.notEqual(adopted, "legacy-admission-key");
    assert.equal(
      ppvJoinKey("ppv-key-legacy", 719002, session, "broadcast") === adopted,
      false,
    );
  } finally {
    if (previous === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previous;
  }
});

test("aborting an admission attempt unregisters its roomJoined listener", () => {
  const handlers = new Set();
  const meeting = {
    self: {
      on: (_event, handler) => handlers.add(handler),
      off: (_event, handler) => handlers.delete(handler),
    },
  };
  const controller = new AbortController();
  let joined = 0;
  listenForPpvAdmissionJoin(meeting, controller.signal, () => joined++);
  assert.equal(handlers.size, 1);
  controller.abort();
  assert.equal(handlers.size, 0);
  for (const handler of handlers) handler();
  assert.equal(joined, 0);
});
