import test from "node:test";
import assert from "node:assert/strict";
import {
  Client,
  FetchTransport,
  NativeTransport,
  TauriTransport,
} from "@free2z/sdk";
import { issuer } from "./issuer.mjs";

test("TauriTransport is the existing native implementation, including instanceof", () => {
  assert.equal(TauriTransport, NativeTransport);
  assert.ok(new TauriTransport({}) instanceof NativeTransport);
});
for (const status of ["future_review", "disputed", "partially_refunded"]) {
  test(`legacy waitForPurchase keeps reconciling ${status} instead of returning early`, async () => {
    const abort = new AbortController();
    let reads = 0;
    const client = new Client({
      purchase: async () => {
        reads++;
        // Abort just after the first snapshot; a premature terminal return
        // would resolve despite this signal rather than enter the wait lane.
        queueMicrotask(() => abort.abort());
        return { status };
      },
    });
    await assert.rejects(
      client.waitForPurchase("intent", {
        signal: abort.signal,
        timeoutMs: 10000,
      }),
      { code: "cancelled" },
    );
    assert.equal(reads, 1);
  });
}
test("legacy final purchase statuses return immediately", async () => {
  for (const status of [
    "credited",
    "expired",
    "failed",
    "refunded",
    "clawed_back",
  ]) {
    const client = new Client({ purchase: async () => ({ status }) });
    assert.equal((await client.waitForPurchase("intent")).status, status);
  }
});
for (const native of [false, true]) {
  test(`${native ? "native" : "fetch"} legacy Zcash refusal preserves billing destination and original key without retry`, async () => {
    const url = "https://issuer.example/buy-2z?client_id=client";
    let sends = 0;
    const mock = issuer();
    mock.config.scopes = [
      "openid",
      "profile",
      "offline_access",
      "purchase:create",
    ];
    const error = { code: "rail_unavailable", details: { billing_url: url } };
    mock.api = () => {
      sends++;
      return mock.json({ error }, 400);
    };
    const bridge = {
      createPurchase: async () => {
        sends++;
        throw error;
      },
    };
    const client = new Client(
      native ? new NativeTransport(bridge) : new FetchTransport(mock.config),
    );
    if (!native) await client.signIn();
    await assert.rejects(
      client.createPurchase(
        { rail: "zcash", quantity2z: 500n },
        { idempotencyKey: "saved-key" },
      ),
      (e) =>
        e.code === "rail_unavailable" &&
        e.details.billing_url === url &&
        e.idempotencyKey === "saved-key",
    );
    assert.equal(sends, 1);
  });
}
