import assert from "node:assert/strict";
import test from "node:test";
import {
  takeAgentLinkIntent,
  clearAgentLinkIntent,
} from "../src/lib/oidc/agent-link-intent.ts";

function tab() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("link authorization survives a clean sign-in return only in the originating tab", () => {
  const storage = tab(),
    token = "x".repeat(43);
  let cleaned = false;
  assert.equal(
    takeAgentLinkIntent(
      new URL(`https://free2z.cash/account/agent-link#intent=${token}`),
      storage,
      () => {
        cleaned = true;
      },
      100,
    ),
    token,
  );
  assert.equal(cleaned, true);
  assert.equal(
    takeAgentLinkIntent(
      new URL("https://free2z.cash/account/agent-link"),
      storage,
      () => {},
      200,
    ),
    token,
  );
  assert.equal(
    takeAgentLinkIntent(
      new URL("https://free2z.cash/account/agent-link"),
      tab(),
      () => {},
      200,
    ),
    null,
  );
  clearAgentLinkIntent(storage);
  assert.equal(
    takeAgentLinkIntent(
      new URL("https://free2z.cash/account/agent-link"),
      storage,
      () => {},
      300,
    ),
    null,
  );
});

test("an invalid replacement or old tab cannot revive a previous request", () => {
  const storage = tab(),
    token = "y".repeat(43);
  const link = new URL(
    `https://free2z.cash/account/agent-link#intent=${token}`,
  );
  takeAgentLinkIntent(link, storage, () => {}, 100);
  assert.equal(
    takeAgentLinkIntent(
      new URL("https://free2z.cash/account/agent-link#intent=bad"),
      storage,
      () => {},
      200,
    ),
    null,
  );
  assert.equal(
    takeAgentLinkIntent(
      new URL("https://free2z.cash/account/agent-link"),
      storage,
      () => {},
      300,
    ),
    null,
  );
  takeAgentLinkIntent(link, storage, () => {}, 100);
  assert.equal(
    takeAgentLinkIntent(
      new URL("https://free2z.cash/account/agent-link"),
      storage,
      () => {},
      100 + 15 * 60 * 1000,
    ),
    null,
  );
});
