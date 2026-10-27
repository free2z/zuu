import assert from "node:assert/strict";
import test from "node:test";
import {
  liveAccountBalance,
  createQuotedBalanceDisplay,
  recordAccountBalanceRead,
} from "../src/lib/account-balance.ts";

test("only the active account's balance overlays its existing page snapshot", () => {
  const owner = { id: 1, username: "buyer", tuzis: "10", draft: "unsaved" };
  assert.equal(liveAccountBalance(owner, { ...owner, tuzis: "25" }), "25");
  assert.equal(
    liveAccountBalance(owner, { id: 2, username: "buyer", tuzis: "99" }),
    "10",
  );
  assert.equal(
    liveAccountBalance(owner, { id: 2, username: "other", tuzis: "99" }),
    "10",
  );
  assert.equal(liveAccountBalance(owner, null), "10");
  assert.equal(liveAccountBalance(null, { ...owner, tuzis: "99" }), "0");
  assert.equal(liveAccountBalance(owner, { ...owner, tuzis: 0 }), 0);
  assert.equal(owner.draft, "unsaved");
});

test("a fresh quote beats cached auth until a newer account read, without changing consent", async () => {
  const { createQuotedBalanceDisplay } =
    await import("../src/lib/account-balance.ts");
  const display = createQuotedBalanceDisplay();
  const owner = { username: "buyer", id: 1 };
  const cached = { ...owner, tuzis: "100" };
  const quote = { balance: "75", affordable: false, price: "90" };
  assert.equal(display(quote, owner, cached), "75");
  assert.equal(display(quote, owner, cached), "75");
  const refreshed = { ...owner, tuzis: "125" };
  assert.equal(display(quote, owner, refreshed), "125");
  assert.equal(quote.affordable, false);
  assert.equal(quote.price, "90");
  const requote = { ...quote, balance: "110" };
  assert.equal(display(requote, owner, refreshed), "110");
  assert.equal(
    display(requote, owner, { username: "other", id: 2, tuzis: "999" }),
    "110",
  );
});

test("fresh route snapshots outrank cached auth and later reads overlay only the same account", async () => {
  const { createAccountBalanceDisplay, recordAccountBalanceRead } =
    await import("../src/lib/account-balance.ts");
  const display = createAccountBalanceDisplay();
  const cached = { id: 1, username: "buyer", tuzis: "10" };
  const page = { ...cached, tuzis: "2500", draft: "keep this" };
  assert.equal(display(page, cached), "2500");
  assert.equal(display(page, cached), "2500");
  const refreshed = { ...cached, tuzis: "3000" };
  recordAccountBalanceRead(refreshed);
  assert.equal(display(page, refreshed), "3000");
  const newerPage = { ...page, tuzis: "3500" };
  assert.equal(display(newerPage, refreshed), "3000");
  assert.equal(
    display(page, { id: 2, username: "other", tuzis: "999" }),
    "2500",
  );
  assert.equal(page.draft, "keep this");
});

test("a refusal keeps its original account and newer snapshot while later same-account reads update display", async () => {
  const { createInsufficientFundsBalanceDisplay } =
    await import("../src/lib/account-balance.ts");
  const display = createInsufficientFundsBalanceDisplay();
  const error = { balance: "5", cost: "20", action: "donation" };
  const cached = { id: 1, username: "buyer", tuzis: "100" };
  assert.equal(display(error, cached), "5");
  assert.equal(display(error, { ...cached, tuzis: "25" }), "25");
  assert.equal(display(error, { id: 2, username: "other", tuzis: "999" }), "5");
  assert.equal(display(error, { id: 2, username: "buyer", tuzis: "999" }), "5");
  assert.deepEqual(error, { balance: "5", cost: "20", action: "donation" });
});

test("metadata-only auth clones preserve the balance-read revision instead of overriding fresh snapshots", async () => {
  const {
    recordAccountBalanceRead,
    inheritAccountBalanceRead,
    createAccountBalanceDisplay,
    createQuotedBalanceDisplay,
  } = await import("../src/lib/account-balance.ts");
  const cached = { id: 1, username: "buyer", tuzis: "100" };
  recordAccountBalanceRead(cached, undefined, false);
  const owner = { ...cached, tuzis: "5" };
  const quote = { balance: "5", price: "20" };
  const pageDisplay = createAccountBalanceDisplay();
  const quoteDisplay = createQuotedBalanceDisplay();
  assert.equal(pageDisplay(owner, cached), "5");
  assert.equal(quoteDisplay(quote, owner, cached), "5");
  const metadataUpdate = { ...cached, stars: ["creator"] };
  inheritAccountBalanceRead(metadataUpdate, cached);
  assert.equal(pageDisplay(owner, metadataUpdate), "5");
  assert.equal(quoteDisplay(quote, owner, metadataUpdate), "5");
  const refreshed = { ...cached, tuzis: "25" };
  recordAccountBalanceRead(refreshed);
  assert.equal(pageDisplay(owner, refreshed), "25");
  assert.equal(quoteDisplay(quote, owner, refreshed), "25");
});

test("a delayed refusal preserves an already completed later credit without changing its cost", async () => {
  const {
    beginAccountBalanceRead,
    recordAccountBalanceRead,
    recordQuotedBalanceRead,
    createInsufficientFundsBalanceDisplay,
  } = await import("../src/lib/account-balance.ts");
  const order = beginAccountBalanceRead();
  const refusal = recordQuotedBalanceRead(
    { balance: "5", cost: "20", action: "donation" },
    order,
  );
  const credited = { id: 1, username: "buyer", tuzis: "25" };
  recordAccountBalanceRead(credited);
  const seenOrders = [];
  const display = createInsufficientFundsBalanceDisplay((_owner, value) =>
    seenOrders.push(value),
  );
  assert.equal(display(refusal, credited), "25");
  assert.deepEqual(seenOrders, [order]);
  assert.equal(refusal.cost, "20");
  assert.equal(refusal.balance, "5");
  assert.equal(
    JSON.stringify(refusal),
    '{"balance":"5","cost":"20","action":"donation"}',
  );
});

test("quote freshness follows request start even when its old response arrives after a credit", async () => {
  const {
    beginAccountBalanceRead,
    recordAccountBalanceRead,
    recordQuotedBalanceRead,
    createQuotedBalanceDisplay,
  } = await import("../src/lib/account-balance.ts");
  const owner = { id: 1, username: "buyer" };
  const olderAuthOrder = beginAccountBalanceRead();
  const quoteOrder = beginAccountBalanceRead();
  const delayedQuote = recordQuotedBalanceRead(
    { balance: "5", price: "20" },
    quoteOrder,
  );
  const oldAuth = { ...owner, tuzis: "100" };
  recordAccountBalanceRead(oldAuth, olderAuthOrder);
  assert.equal(createQuotedBalanceDisplay()(delayedQuote, owner, oldAuth), "5");
  const credited = { ...owner, tuzis: "25" };
  recordAccountBalanceRead(credited, beginAccountBalanceRead());
  const display = createQuotedBalanceDisplay();
  assert.equal(display(delayedQuote, owner, credited), "25");
  const latestQuote = recordQuotedBalanceRead(
    { balance: "20", price: "10" },
    beginAccountBalanceRead(),
  );
  assert.equal(display(latestQuote, owner, credited), "20");
});

test("DB visibility snapshots preserve transaction precision and reject malformed freshness", async () => {
  const {
    balanceSnapshot,
    compareBalanceSnapshots,
    createAccountBalanceDisplay,
    recordAccountBalanceRead,
  } = await import("../src/lib/account-balance.ts");
  const time = "8123:2";
  const later = "8123:1";
  assert.deepEqual(balanceSnapshot(time), [8123n, 2n]);
  assert.equal(
    compareBalanceSnapshots("9007199254740993:1", "9007199254740992:0"),
    1,
  );
  assert.equal(compareBalanceSnapshots("8123:1", "8123:2"), 1);
  assert.equal(compareBalanceSnapshots("8123:2", "8123:2"), 0);
  for (const invalid of [
    null,
    0,
    "",
    "0008123:1",
    "8123:01",
    "8123:-1",
    "2026-10-06T16:00:00.123Z",
    "tomorrow",
  ])
    assert.equal(balanceSnapshot(invalid), undefined);
  const oldRoute = {
    id: 1,
    username: "buyer",
    tuzis: "5",
    balance_snapshot: time,
    draft: "kept",
  };
  const credited = { ...oldRoute, tuzis: "25", balance_snapshot: later };
  recordAccountBalanceRead(credited);
  const display = createAccountBalanceDisplay();
  assert.equal(display(oldRoute, credited), "25");
  assert.equal(
    display(
      {
        ...oldRoute,
        tuzis: "35",
        balance_snapshot: "8123:0",
      },
      credited,
    ),
    "35",
  );
  assert.equal(
    display({ ...oldRoute, balance_snapshot: undefined }, credited),
    "25",
  );
  assert.equal(
    display({ ...oldRoute, balance_snapshot: "malformed" }, credited),
    "25",
  );
  assert.equal(
    display(oldRoute, { ...credited, id: 2, username: "other" }),
    "5",
  );
  assert.equal(oldRoute.draft, "kept");
});

test("every arriving quote exposes its unknown database balance once for postarrival validation", () => {
  const calls = [];
  const display = createQuotedBalanceDisplay((owner, order, balance) =>
    calls.push({ owner, order, balance }),
  );
  const owner = { username: "buyer", id: 1 };
  const current = { ...owner, tuzis: "25" };
  recordAccountBalanceRead(current);
  const quote = { balance: "5" };
  display(quote, owner, current);
  display(quote, owner, { ...current });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].balance, "5");
  assert.equal(calls[0].owner, owner);
  assert.equal(quote.balance, "5");
});
