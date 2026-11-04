import test from "node:test";
import assert from "node:assert/strict";
import { FetchTransport, NativeTransport } from "../dist/index.js";
import { issuer, deferred } from "./issuer.mjs";
const wire = {
  sub: "alice",
  client_id: "client",
  account_epoch: 4,
  grant_generation: 2,
  scopes: ["ai:invoke"],
  spend_cap_2z: 500,
  cap_period: "total",
  enforced: true,
  as_of: "2026-09-28T00:00:00Z",
};
test("grant proof is fresh, scoped and rejects missing enforcement or unknown period", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  mock.api = () => mock.json(wire);
  assert.equal((await transport.grant()).spend_cap_2z, 500n);
  mock.api = () => mock.json({ ...wire, enforced: false });
  assert.equal((await transport.grant()).enforced, false);
  for (const field of [
    "enforced",
    "spend_cap_2z",
    "cap_period",
    "account_epoch",
    "grant_generation",
  ]) {
    const incomplete = { ...wire };
    delete incomplete[field];
    mock.api = () => mock.json(incomplete);
    await assert.rejects(transport.grant(), { code: "invalid_response" });
  }
  for (const invalid of [
    { cap_period: "forever" },
    { grant_generation: 0 },
    { scopes: [] },
    { as_of: "" },
    { as_of: "2026-02-30T00:00:00Z" },
    { as_of: "2026-09-28T00:00:00+01:00" },
    { client_id: "other" },
    { sub: "bob" },
  ]) {
    mock.api = () => mock.json({ ...wire, ...invalid });
    await assert.rejects(transport.grant(), { code: "invalid_response" });
  }
});
test("enforcement reason is optional, tolerant of new codes, and consistent", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  mock.api = () => mock.json(wire);
  assert.equal("enforcement_reason" in (await transport.grant()), false);
  for (const [code, enforced, expected] of [
    ["ok", true, "ok"],
    ["platform_disabled", false, "platform_disabled"],
    ["ledger_cutover_pending", false, "ledger_cutover_pending"],
    ["ledger_cap_pending", false, "ledger_cap_pending"],
    ["some_future_code", false, "unknown"],
  ]) {
    mock.api = () => mock.json({ ...wire, enforced, enforcement_reason: code });
    const g = await transport.grant();
    assert.equal(g.enforcement_reason, expected, code);
    assert.equal(g.enforced, enforced, code);
  }
  for (const [code, enforced] of [
    ["ok", false],
    ["platform_disabled", true],
    ["some_future_code", true],
    [3, false],
  ]) {
    mock.api = () => mock.json({ ...wire, enforced, enforcement_reason: code });
    await assert.rejects(transport.grant(), { code: "invalid_response" });
  }
});
test("native grant integers stay exact and old session proof is refused", async () => {
  let generation = "1",
    subject = "alice";
  const pending = deferred(),
    entered = deferred();
  const bridge = {
    session: async () => ({
      signedIn: true,
      subject,
      grantedScopes: ["ai:invoke"],
      persistence: "persistent",
      generation,
    }),
    grant: async () => ({
      ...wire,
      spend_cap_2z: "18446744073709551615",
      account_epoch: "4",
      grant_generation: "2",
    }),
  };
  const transport = new NativeTransport(bridge);
  assert.equal((await transport.grant()).spend_cap_2z, 18446744073709551615n);
  bridge.grant = () => {
    entered.resolve();
    return pending.promise;
  };
  const old = transport.grant();
  await entered.promise;
  generation = "2";
  subject = "alice"; // Same account, a new local authorization session.
  pending.resolve({
    ...wire,
    spend_cap_2z: "500",
    account_epoch: "4",
    grant_generation: "2",
  });
  await assert.rejects(old, { code: "signed_out" });
});
test("web grant reply is invalidated by sign-out while response is pending", async () => {
  const mock = issuer(),
    transport = new FetchTransport(mock.config);
  await transport.signIn();
  const pending = deferred(),
    entered = deferred();
  mock.api = () => {
    entered.resolve();
    return pending.promise;
  };
  const old = transport.grant();
  await entered.promise;
  await transport.signOut();
  pending.resolve(mock.json(wire));
  await assert.rejects(old, { code: "signed_out" });
});
