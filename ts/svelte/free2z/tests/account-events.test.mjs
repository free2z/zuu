import assert from "node:assert/strict";
import test from "node:test";
import { createAccountEventDelivery } from "../src/lib/ws/accountEvents.ts";

const wait = () => new Promise((resolve) => setTimeout(resolve, 130));
const event = (id, type = "BOUGHT_TUZI", read = false, username = "buyer") => ({
  id,
  type,
  read,
  receiving_user: { username },
});

test("purchase retries dedupe before notifications, and bursts share an authoritative refresh", async () => {
  const added = [],
    notices = [],
    refreshed = [];
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: (e) => added.push(e.id),
    notify: (e) => notices.push(e.id),
    refresh: async (username) => {
      refreshed.push(username);
    },
  });
  try {
    assert.equal(delivery.receive(event("purchase")), true);
    assert.equal(delivery.receive(event("purchase")), false);
    delivery.receive(event("second"));
    delivery.receive(event("already-read", "BOUGHT_TUZI", true));
    assert.equal(
      delivery.receive(event("wrong-user", "BOUGHT_TUZI", false, "other")),
      false,
    );
    await wait();
    assert.deepEqual(added, ["purchase", "second", "already-read"]);
    assert.deepEqual(notices, ["purchase", "second"]);
    assert.deepEqual(refreshed, ["buyer"]);
  } finally {
    delivery.reset();
  }
});

test("a pending payment is visible but cannot trigger a balance refresh", async () => {
  const added = [],
    notices = [];
  let refreshes = 0;
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: (e) => added.push(e.type),
    notify: (e) => notices.push(e.type),
    refresh: async () => {
      refreshes += 1;
    },
  });
  try {
    delivery.receive(event("pending", "ZEC_PENDING"));
    delivery.receive(event("pending", "ZEC_PENDING"));
    await wait();
    assert.deepEqual(added, ["ZEC_PENDING"]);
    assert.deepEqual(notices, ["ZEC_PENDING"]);
    assert.equal(refreshes, 0);
  } finally {
    delivery.reset();
  }
});

test("account switches and teardown cancel queued refreshes and reset delivery identities", async () => {
  let username = "buyer";
  const refreshed = [];
  const delivery = createAccountEventDelivery({
    username: () => username,
    add: () => {},
    notify: () => {},
    refresh: async (user) => {
      refreshed.push(user);
    },
  });
  delivery.receive(event("same-id"));
  username = "other";
  delivery.reset();
  assert.equal(delivery.receive(event("stale")), false);
  assert.equal(
    delivery.receive(event("same-id", "BOUGHT_TUZI", false, "other")),
    true,
  );
  await wait();
  assert.deepEqual(refreshed, ["other"]);
  delivery.receive(event("teardown", "BOUGHT_TUZI", false, "other"));
  delivery.reset();
  await wait();
  assert.deepEqual(refreshed, ["other"]);
});

test("a credit arriving during an account refresh gets a later authoritative read", async () => {
  let release;
  const refreshed = [];
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: () => {},
    refresh: async () => {
      refreshed.push("refresh");
      if (refreshed.length === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
    },
  });
  try {
    delivery.receive(event("first"));
    await wait();
    delivery.receive(event("second"));
    delivery.receive(event("second"));
    release();
    await wait();
    assert.equal(refreshed.length, 2);
  } finally {
    delivery.reset();
  }
});

test("transient refresh failures retry independently of deduplicated announcements", async () => {
  let reads = 0,
    adds = 0,
    notices = 0;
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => adds++,
    notify: () => notices++,
    retryDelaysMs: [10, 20],
    refresh: async () => {
      if (++reads < 3) throw new Error("503");
    },
  });
  delivery.receive(event("retry-credit"));
  await wait();
  assert.equal(delivery.receive(event("retry-credit")), false);
  await wait();
  assert.equal(reads, 3);
  assert.equal(adds, 1);
  assert.equal(notices, 1);
  delivery.reset();
});

test("refresh recovery is bounded and reset cancels queued retries", async () => {
  let reads = 0;
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: () => {},
    retryDelaysMs: [10, 20],
    refresh: async () => {
      reads++;
      throw new Error("offline");
    },
  });
  delivery.receive(event("offline"));
  await wait();
  await wait();
  assert.equal(reads, 3);
  await wait();
  assert.equal(reads, 3);
  delivery.receive(event("another-credit"));
  await new Promise((resolve) => setTimeout(resolve, 105));
  delivery.reset();
  const afterReset = reads;
  await wait();
  assert.equal(reads, afterReset);
});

test("reconnection recovers new receipts once without announcing initial unread history", async () => {
  let username = "buyer",
    history = [{ ...event("historic"), created_at: "2026-10-06T15:00:00Z" }];
  const added = [],
    notices = [],
    reads = [];
  const delivery = createAccountEventDelivery({
    username: () => username,
    add: (e) => added.push(e.id),
    notify: (e) => notices.push(e.id),
    refresh: async (user, routes) => reads.push({ user, routes }),
    history: async () => history,
  });
  delivery.reconcile(true);
  await wait();
  assert.deepEqual(notices, []);
  history = [
    { ...event("recovered"), created_at: "2026-10-06T16:00:00Z" },
    ...history,
  ];
  delivery.reconcile(true);
  delivery.reconcile(true);
  await wait();
  assert.deepEqual(notices, ["recovered"]);
  assert.equal(delivery.receive(event("recovered")), false);
  delivery.reconcile(true);
  await wait();
  assert.deepEqual(notices, ["recovered"]);
  for (let i = 0; i < 2001; i++)
    delivery.receive(event("evict-" + i, "ZEC_PENDING", true));
  delivery.reconcile(true);
  await wait();
  assert.deepEqual(notices, ["recovered"]);
  username = "other";
  delivery.reset();
  history = [
    {
      ...event("new-user-history", "BOUGHT_TUZI", false, "other"),
      created_at: "2026-10-06T17:00:00Z",
    },
  ];
  delivery.reconcile(true);
  await wait();
  assert.deepEqual(notices, ["recovered"]);
  delivery.reconcile(false, false);
  await wait();
  assert.equal(reads.at(-1).routes, false);
  delivery.reset();
});

test("account changes fence history recovery after each await", async () => {
  let username = "buyer",
    release;
  const notices = [];
  const delivery = createAccountEventDelivery({
    username: () => username,
    add: () => {},
    notify: (e) => notices.push(e.id),
    refresh: async () => {},
    history: async () => new Promise((resolve) => (release = resolve)),
  });
  delivery.reconcile(true);
  await wait();
  username = "other";
  delivery.reset();
  release([{ ...event("stale-history"), created_at: "2026-10-06T16:00:00Z" }]);
  await wait();
  assert.deepEqual(notices, []);
  delivery.reset();
});

test("a failed initial history read retries without announcing historical purchases", async () => {
  let reads = 0;
  const notices = [];
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: (e) => notices.push(e.id),
    refresh: async () => {},
    retryDelaysMs: [10, 20],
    history: async () => {
      if (++reads === 1) throw new Error("Notification recovery superseded");
      return [
        { ...event("previously-unread"), created_at: "2026-10-06T15:00:00Z" },
      ];
    },
  });
  delivery.reconcile(true);
  await wait();
  await wait();
  assert.equal(reads, 2);
  assert.deepEqual(notices, []);
  delivery.reconcile(true);
  await wait();
  assert.deepEqual(notices, []);
  delivery.reset();
});

test("reconnect during history recovery retains a follow-up read for missed receipts", async () => {
  let reads = 0,
    release;
  const notices = [];
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: (e) => notices.push(e.id),
    refresh: async () => {},
    history: async () => {
      reads++;
      if (reads === 2) return new Promise((resolve) => (release = resolve));
      return reads === 1
        ? [{ ...event("baseline"), created_at: "2026-10-06T15:00:00Z" }]
        : [
            {
              ...event("next-connection-credit"),
              created_at: "2026-10-06T16:00:00Z",
            },
          ];
    },
  });
  delivery.reconcile(true);
  await wait();
  delivery.reconcile(true);
  await wait();
  delivery.reconcile(true);
  release([]);
  await wait();
  await wait();
  assert.equal(reads, 3);
  assert.deepEqual(notices, ["next-connection-credit"]);
  delivery.reset();
});

test("history observation settles a credit committed after the earlier account read", async () => {
  let balance = 5,
    displayed = 0,
    historyReads = 0;
  const notices = [];
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: (e) => notices.push(e.id),
    refresh: async () => {
      displayed = balance;
    },
    history: async () => {
      if (++historyReads === 1)
        return [{ ...event("baseline"), created_at: "2026-10-06T15:00:00Z" }];
      balance = 25;
      return [
        { ...event("between-reads"), created_at: "2026-10-06T16:00:00Z" },
      ];
    },
  });
  try {
    delivery.reconcile(true);
    await wait();
    assert.equal(displayed, 5);
    delivery.reconcile(true);
    await wait();
    assert.deepEqual(notices, ["between-reads"]);
    assert.equal(displayed, 25);
    assert.equal(delivery.receive(event("between-reads")), false);
    await wait();
    assert.equal(displayed, 25);
  } finally {
    delivery.reset();
  }
});

test("even a quiet initial or deduplicated history observation gets a later balance read", async () => {
  let balance = 5,
    displayed = 0;
  const notices = [];
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: (e) => notices.push(e.id),
    refresh: async () => {
      displayed = balance;
    },
    history: async () => {
      balance += 10;
      return [
        {
          ...event("read-receipt", "BOUGHT_TUZI", true),
          created_at: "2026-10-06T15:00:00Z",
        },
      ];
    },
  });
  try {
    delivery.reconcile(true);
    await wait();
    assert.equal(displayed, 15);
    delivery.reconcile(true);
    await wait();
    assert.equal(displayed, 25);
    assert.deepEqual(notices, []);
  } finally {
    delivery.reset();
  }
});

test("completed receipt rescans recover older-created late commits without replay after social LRU eviction", async () => {
  let records = [
    { ...event("baseline-receipt"), created_at: "2026-10-06T16:00:00Z" },
  ];
  const notices = [];
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: (e) => notices.push(e.id),
    refresh: async () => {},
    history: async () => records,
  });
  try {
    delivery.reconcile(true);
    await wait();
    records.push({
      ...event("late-commit"),
      created_at: "2026-10-05T16:00:00Z",
    });
    delivery.reconcile(true);
    await wait();
    assert.deepEqual(notices, ["late-commit"]);
    for (let i = 0; i < 2001; i++)
      delivery.receive(event("social-" + i, "PAGE_UPDATE", true));
    delivery.reconcile(true);
    await wait();
    assert.deepEqual(notices, ["late-commit"]);
    assert.equal(delivery.receive(event("baseline-receipt")), false);
    assert.equal(delivery.receive(event("late-commit")), false);
  } finally {
    delivery.reset();
  }
});

test("bounded partial receipt batches cannot seed or announce the initial baseline", async () => {
  let calls = 0;
  const notices = [];
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: (e) => notices.push(e.id),
    refresh: async () => {},
    history: async () => (++calls < 3 ? null : [event("historic-last-page")]),
  });
  try {
    delivery.reconcile(true);
    await wait();
    await wait();
    await wait();
    assert.equal(calls, 3);
    assert.deepEqual(notices, []);
    delivery.reconcile(true);
    await wait();
    assert.deepEqual(notices, []);
  } finally {
    delivery.reset();
  }
});

test("a reconnect requested during partial batches gets a new scan after the older upper boundary completes", async () => {
  let calls = 0,
    release;
  const notices = [];
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: (e) => notices.push(e.id),
    refresh: async () => {},
    history: async () => {
      calls++;
      if (calls === 1) return [event("baseline")];
      if (calls === 2) return new Promise((resolve) => (release = resolve));
      if (calls === 3) return [event("baseline")];
      return [event("baseline"), event("newer-than-old-upper")];
    },
  });
  try {
    delivery.reconcile(true);
    await wait();
    delivery.reconcile(true);
    await wait();
    delivery.reconcile(true);
    release(null);
    await wait();
    await wait();
    assert.equal(calls, 4);
    assert.deepEqual(notices, ["newer-than-old-upper"]);
  } finally {
    delivery.reset();
  }
});

test("a live credit promptly interrupts stalled history and ignores its late result", async () => {
  let release,
    signal,
    reads = 0,
    scans = 0;
  const notices = [];
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: (value) => notices.push(value.id),
    refresh: async () => {
      reads++;
    },
    history: async (_username, abortSignal) => {
      if (++scans > 1) return [];
      signal = abortSignal;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    delivery.reconcile(true);
    await wait();
    assert.equal(reads, 1);
    delivery.receive(event("credit-during-stall"));
    assert.equal(signal.aborted, true);
    await wait();
    assert.ok(
      reads >= 2,
      "a later authoritative read must precede stalled history settlement",
    );
    assert.deepEqual(notices, ["credit-during-stall"]);
    release([event("late-aborted-history")]);
    await wait();
    assert.deepEqual(notices, ["credit-during-stall"]);
    assert.equal(delivery.receive(event("credit-during-stall")), false);
  } finally {
    delivery.reset();
  }
});

test("stalled history deadlines release the queue with bounded retries", async () => {
  const signals = [];
  let reads = 0;
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: () => {},
    historyTimeoutMs: 20,
    retryDelaysMs: [5],
    refresh: async () => {
      reads++;
    },
    history: async (_username, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    },
  });
  try {
    delivery.reconcile(true);
    await wait();
    await wait();
    assert.equal(reads, 2);
    assert.equal(signals.length, 2);
    assert.ok(signals.every((signal) => signal.aborted));
    delivery.receive(event("credit-after-deadline"));
    await wait();
    assert.ok(reads >= 3);
  } finally {
    delivery.reset();
  }
});

test("account teardown cancels active history without affecting a replacement account", async () => {
  let username = "buyer",
    signal,
    release;
  const reads = [],
    notices = [];
  const delivery = createAccountEventDelivery({
    username: () => username,
    add: () => {},
    notify: (value) => notices.push(value.id),
    refresh: async (user) => {
      reads.push(user);
    },
    history: async (_username, abortSignal) => {
      signal = abortSignal;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  delivery.reconcile(true);
  await wait();
  username = "other";
  delivery.reset();
  assert.equal(signal.aborted, true);
  delivery.receive(event("new-account-credit", "BOUGHT_TUZI", false, "other"));
  release([event("old-account-history")]);
  await wait();
  assert.deepEqual(reads, ["buyer", "other"]);
  assert.deepEqual(notices, ["new-account-credit"]);
  delivery.reset();
});

test("paid chat transfers and page-vote debits refresh matching accounts, including read sender events", async () => {
  for (const type of ["ENCRYPTED_CHAT_REQUEST", "PAGE_VOTE"]) {
    for (const read of [false, true]) {
      const calls = [];
      const delivery = createAccountEventDelivery({
        username: () => "buyer",
        add() {},
        notify() {},
        refresh: async (user) => calls.push(user),
      });
      try {
        delivery.receive({ ...event("transfer", type, read), amount: 1 });
        await wait();
        assert.deepEqual(calls, ["buyer"]);
      } finally {
        delivery.reset();
      }
    }
  }
});

test("only exact increasing vote amounts advance a reused event ID", async () => {
  for (const type of [
    "PAGE_VOTE",
    "VOTE_COMMENT_SENT",
    "VOTE_COMMENT_RECEIVED",
  ]) {
    const added = [],
      notices = [];
    const delivery = createAccountEventDelivery({
      username: () => "buyer",
      add: (e) => added.push(e.amount),
      notify: (e) => notices.push(e.amount),
      refresh: async () => {},
    });
    try {
      const vote = (amount, read = false) => ({
        ...event("vote", type, read),
        amount,
      });
      assert.equal(delivery.receive(vote(1, true)), true);
      assert.equal(delivery.receive(vote(2)), true);
      for (const amount of [2, 1, 2.5, NaN, Number.MAX_SAFE_INTEGER + 1])
        assert.equal(delivery.receive(vote(amount)), false);
      assert.deepEqual(added, [1, 2]);
      assert.deepEqual(notices, [2]);
    } finally {
      delivery.reset();
    }
  }
});

test("vote revisions outlive social delivery eviction and HTTP-known votes stay quiet", () => {
  const notices = [];
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: (e) => notices.push(e.id),
    refresh: async () => {},
  });
  try {
    const vote = (amount) => ({ ...event("stable-vote", "PAGE_VOTE"), amount });
    assert.equal(delivery.receive(vote(2), false), true);
    for (let i = 0; i < 2001; i++)
      delivery.receive(event(`social-${i}`, "NEW_REPLY", true));
    assert.equal(delivery.receive(vote(1)), false);
    assert.equal(delivery.receive(vote(2)), false);
    assert.equal(delivery.receive(vote(3)), true);
    assert.deepEqual(notices, ["stable-vote"]);
  } finally {
    delivery.reset();
  }
  const known = createAccountEventDelivery({
    username: () => "buyer",
    add: () => false,
    notify: (e) => notices.push(e.id),
    refresh: async () => {},
  });
  try {
    assert.equal(
      known.receive({ ...event("http-vote", "PAGE_VOTE"), amount: 1 }),
      true,
    );
    assert.deepEqual(notices, ["stable-vote"]);
  } finally {
    known.reset();
  }
});

test("an immutable purchase already loaded into the feed still validates its balance once", async () => {
  let reads = 0;
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => false,
    notify() {},
    refresh: async () => {
      reads++;
    },
  });
  try {
    assert.equal(delivery.receive(event("already-loaded-credit")), true);
    assert.equal(delivery.receive(event("already-loaded-credit")), false);
    await wait();
    assert.equal(reads, 1);
  } finally {
    delivery.reset();
  }
});

test("malformed event envelopes fail closed before revision inspection", () => {
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add() {
      throw Error("unexpected");
    },
    notify() {
      throw Error("unexpected");
    },
    refresh: async () => {
      throw Error("unexpected");
    },
  });
  try {
    for (const malformed of [
      null,
      undefined,
      {},
      { id: "broken", type: "PAGE_VOTE", amount: 2 },
    ])
      assert.equal(delivery.receive(malformed), false);
  } finally {
    delivery.reset();
  }
});

test("a live credit promptly retires an older internal auth queue phase", async () => {
  let releaseOld,
    reads = 0;
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: () => {},
    refresh: async () => {
      if (++reads === 1) await new Promise((resolve) => (releaseOld = resolve));
    },
  });
  try {
    delivery.reconcile();
    await wait();
    delivery.receive(event("credit-during-auth"));
    await wait();
    assert.equal(reads, 2);
    releaseOld();
    await wait();
    assert.equal(reads, 2);
  } finally {
    delivery.reset();
    releaseOld?.();
  }
});

test("historical receipt evidence is quiet and only one page of new unread receipts is surfaced", async () => {
  const historic = Array.from({ length: 1000 }, (_, i) =>
    event(`historic-${i}`, "BOUGHT_TUZI", true),
  );
  const fresh = Array.from({ length: 100 }, (_, i) => event(`fresh-${i}`));
  let records = historic;
  const added = [],
    notices = [];
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: (row, countUnread) => {
      assert.equal(countUnread, false);
      added.push(row.id);
    },
    notify: (row) => notices.push(row.id),
    refresh: async () => {},
    history: async () => records,
  });
  try {
    delivery.reconcile(true);
    await wait();
    assert.deepEqual(added, []);
    assert.deepEqual(notices, []);
    records = [...historic, ...fresh];
    delivery.reconcile(true);
    await wait();
    assert.equal(added.length, 12);
    assert.equal(notices.length, 100);
    delivery.reconcile(true);
    await wait();
    assert.equal(added.length, 12);
    assert.equal(notices.length, 100);
    assert.equal(delivery.receive(fresh[99]), false);
  } finally {
    delivery.reset();
  }
});

test("credit dismisses its pending notice and late delivery cannot regress that purchase", () => {
  const notices = [],
    settled = [];
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: (e) => notices.push(e.id),
    paymentSettled: (id) => settled.push(id),
    refresh: async () => {},
  });
  const payment = (id, type, status = "pending", intent = "invoice") => ({
    ...event(id, type),
    payment_reference: { payment_id: intent, status },
  });
  try {
    delivery.receive(payment("pending", "ZEC_PENDING"));
    delivery.receive(payment("credit", "BOUGHT_TUZI", "credited"));
    delivery.receive(payment("late", "ZEC_PENDING"));
    delivery.receive(
      payment("recovered", "ZEC_PENDING", "credited", "other-invoice"),
    );
    assert.deepEqual(notices, ["pending", "credit"]);
    assert.deepEqual(settled, ["invoice", "other-invoice"]);
    delivery.reset();
    delivery.receive(payment("new-session", "ZEC_PENDING"));
    assert.deepEqual(notices, ["pending", "credit", "new-session"]);
    assert.equal(
      delivery.receive({
        ...payment("wrong-account", "BOUGHT_TUZI", "credited"),
        receiving_user: { username: "other" },
      }),
      false,
    );
    assert.deepEqual(settled, ["invoice", "other-invoice"]);
  } finally {
    delivery.reset();
  }
});

test("quiet initial receipt recovery retires a live pending notice after a missed credit", async () => {
  const notices = [],
    settled = [];
  const payment = (id, type, status) => ({
    ...event(id, type),
    payment_reference: { intent_id: "invoice", status },
  });
  const delivery = createAccountEventDelivery({
    username: () => "buyer",
    add: () => {},
    notify: (e) => notices.push(e.id),
    paymentSettled: (id) => settled.push(id),
    refresh: async () => {},
    history: async () => [
      payment("credit", "BOUGHT_TUZI", "credited"),
      payment("pending", "ZEC_PENDING", "credited"),
      {
        ...payment("other-credit", "BOUGHT_TUZI", "credited"),
        receiving_user: { username: "other" },
      },
    ],
  });
  try {
    delivery.receive(payment("pending", "ZEC_PENDING", "pending"));
    delivery.reconcile(true);
    await wait();
    assert.deepEqual(notices, ["pending"]);
    assert.deepEqual(settled, ["invoice"]);
  } finally {
    delivery.reset();
  }
});
