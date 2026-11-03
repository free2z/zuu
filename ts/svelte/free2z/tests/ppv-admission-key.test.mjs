import assert from "node:assert/strict";
import test from "node:test";
import { clearPpvJoinKey, ppvJoinKey } from "../src/lib/ppv-admission-key.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test("a stale roomJoined callback cannot clear the replacement admission key", () => {
  const previous = globalThis.sessionStorage;
  globalThis.sessionStorage = storage();
  try {
    const first = ppvJoinKey("ppv-key-race", 719001, "ppv");
    clearPpvJoinKey("ppv-key-race", 719001, first);
    const later = ppvJoinKey("ppv-key-race", 719001, "ppv");

    clearPpvJoinKey("ppv-key-race", 719001, first);
    assert.equal(ppvJoinKey("ppv-key-race", 719001, "ppv"), later);
  } finally {
    if (previous === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previous;
  }
});

test("legacy pending PPV keys are adopted and meeting types do not share keys", () => {
  const previous = globalThis.sessionStorage;
  const currentStorage = storage();
  globalThis.sessionStorage = currentStorage;
  try {
    currentStorage.setItem(
      "f2z:ppv-join:ppv-key-legacy:719002",
      "legacy-admission-key",
    );
    const adopted = ppvJoinKey("ppv-key-legacy", 719002, "ppv");
    assert.equal(adopted, "legacy-admission-key");
    assert.equal(
      ppvJoinKey("ppv-key-legacy", 719002, "broadcast") === adopted,
      false,
    );
  } finally {
    if (previous === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previous;
  }
});
