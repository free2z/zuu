import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";
let server, renewalDisplay, createRenewalDisplay, balanceReads;
before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ renewalDisplay, createRenewalDisplay } = await server.ssrLoadModule(
    "/src/lib/billing-renewal-display.ts",
  ));
  balanceReads = await server.ssrLoadModule("/src/lib/account-balance.ts");
});
after(async () => {
  await server?.close();
});
const summary = {
  status: "shortfall",
  balance: "5.000",
  total_upcoming: "20.000",
  shortfall: "15.000",
  horizon_days: 29,
};

test("renewal balance updates reduce deficits and cover the same total and window", () => {
  assert.equal(renewalDisplay(summary, "15").shortfall, "5");
  const covered = renewalDisplay(summary, "25");
  assert.equal(covered.status, "ok");
  assert.equal(covered.shortfall, "0");
  assert.equal(covered.total, "20.000");
  assert.equal(covered.horizonDays, 29);
  assert.deepEqual(summary, {
    status: "shortfall",
    balance: "5.000",
    total_upcoming: "20.000",
    shortfall: "15.000",
    horizon_days: 29,
  });
  assert.equal(
    renewalDisplay(
      { ...summary, status: "ok", balance: "25", shortfall: "0" },
      "5",
    ).status,
    "shortfall",
  );
});

test("large milli-credit deficits retain exact monetary precision", () => {
  const large = {
    ...summary,
    balance: "99999999999999.998",
    total_upcoming: "99999999999999.999",
    shortfall: "0.001",
  };
  assert.equal(renewalDisplay(large, "99999999999999.998").shortfall, "0.001");
  assert.equal(renewalDisplay(large, "99999999999999.999").status, "ok");
});

test("unknown, malformed, inconsistent and unavailable summaries never infer coverage", () => {
  for (const invalid of [
    null,
    undefined,
    {},
    { ...summary, status: "unknown" },
    { ...summary, balance: "NaN" },
    { ...summary, total_upcoming: "bad" },
    { ...summary, shortfall: "bad" },
    { ...summary, shortfall: "0" },
    { ...summary, horizon_days: NaN },
    { ...summary, horizon_days: 0 },
  ]) {
    assert.equal(renewalDisplay(invalid, "25").status, "unknown");
  }
  for (const balance of [undefined, "bad", "-1", "Infinity"])
    assert.equal(renewalDisplay(summary, balance).status, "unknown");
});

test("no chargeable renewals stay quiet after any balance change", () => {
  const none = {
    ...summary,
    status: "none",
    total_upcoming: "0.000",
    shortfall: "0.000",
  };
  assert.equal(renewalDisplay(none, "25").status, "none");
  assert.equal(
    renewalDisplay({ ...none, total_upcoming: "1" }, "25").status,
    "unknown",
  );
});

test("summary balance survives earlier auth, late completion and non-auth clones until a later real dispatch", () => {
  const {
    beginAccountBalanceRead,
    recordAccountBalanceRead,
    inheritAccountBalanceRead,
  } = balanceReads;
  const olderOrder = beginAccountBalanceRead();
  const old = {
    username: "owner",
    id: 1,
    tuzis: "100",
    balance_snapshot: "9000:0",
  };
  recordAccountBalanceRead(old, olderOrder, true, true);
  const callbacks = [];
  const display = createRenewalDisplay((owner, order) =>
    callbacks.push({ owner, order }),
  );
  const charged = {
    ...summary,
    balance: "20",
    total_upcoming: "30",
    shortfall: "10",
  };
  assert.equal(display(charged, old, old).shortfall, "10");
  assert.deepEqual(callbacks[0].owner, {
    username: "owner",
    id: 1,
    tuzis: "20",
  });
  const late = { ...old };
  recordAccountBalanceRead(late, olderOrder, true, true);
  assert.equal(display(charged, old, late).shortfall, "10");
  const metadata = { ...late, full_name: "Changed" };
  inheritAccountBalanceRead(metadata, late);
  recordAccountBalanceRead(metadata); // Generic re-recording cannot replace original auth authority.
  assert.equal(display(charged, old, metadata).shortfall, "10");
  const route = { ...old, tuzis: "99" };
  inheritAccountBalanceRead(route, old);
  assert.equal(display(charged, old, route).shortfall, "10");
  const after = { ...old, tuzis: "35" };
  recordAccountBalanceRead(after, beginAccountBalanceRead(), true, true);
  assert.equal(display(charged, old, after).status, "ok");
  const debit = { ...after, tuzis: "25" };
  recordAccountBalanceRead(debit, beginAccountBalanceRead(), true, true);
  assert.equal(display(charged, old, debit).shortfall, "5");
  assert.equal(
    display(charged, old, { ...debit, username: "other" }).shortfall,
    "10",
  );
  assert.equal(callbacks.length, 1);
});

test("SSR and failed validation keep summary authority, and each new summary starts a new arrival", () => {
  const display = createRenewalDisplay();
  const owner = { username: "owner", id: 1, tuzis: "100" };
  const charged = {
    ...summary,
    balance: "20",
    total_upcoming: "30",
    shortfall: "10",
  };
  assert.equal(display(charged, owner, null).shortfall, "10");
  assert.equal(display(charged, owner, owner).shortfall, "10");
  balanceReads.recordAccountBalanceRead(
    owner,
    balanceReads.beginAccountBalanceRead(),
    true,
    true,
  );
  assert.equal(display(charged, owner, owner).status, "ok");
  assert.equal(display({ ...charged }, owner, owner).shortfall, "10");
});
