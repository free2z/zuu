import test from "node:test";
import assert from "node:assert/strict";
import { Client, SdkError } from "@free2z/sdk";
import { HelloAI, browserJournal } from "../.test-build/controller.js";

const at = 1000;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { resolve, reject, promise };
};
function fixture() {
  let session = {
    signedIn: true,
    subject: "alice",
    generation: "1",
    grantedScopes: ["ai:invoke", "balance:read"],
    persistence: "memory_only",
  };
  const entries = new Map(),
    starts = [],
    order = [],
    streams = [];
  const started = deferred();
  let now = at,
    serial = 0,
    events = [],
    mode = "done",
    enforced = true,
    refusal;
  const balance = {
    available_milli_2z: 9007199254740993n,
    held_milli_2z: 0n,
    balance_milli_2z: 9007199254740993n,
    debt_milli_2z: 0n,
    as_of: "now",
  };
  const receipt = {
    call_id: "call-1",
    charge: { state: "charged", charged2z: 2n, receiptId: "receipt-1" },
    status: "settled",
  };
  const transport = {
    session: async () => ({ ...session }),
    signIn: async () => ({ ...session }),
    signOut: async () => {
      session = {
        ...session,
        signedIn: false,
        subject: null,
        generation: "out",
      };
      return { revoked: false, generation: "out" };
    },
    balance: async () => {
      order.push("balance");
      return balance;
    },
    models: async () => ({ models: [{ id: "model" }], catalog_version: 1n }),
    grant: async () => ({
      enforced,
      sub: session.subject,
      scopes: ["ai:invoke"],
    }),
    estimate: async () => {
      if (refusal) throw new SdkError(refusal);
      return {};
    },
    call: async () => receipt,
    chat: async (request, options) => {
      order.push("chat");
      assert.ok(entries.get(session.subject), "journal precedes paid request");
      starts.push(
        structuredClone({
          request,
          options: { ...options, signal: undefined },
        }),
      );
      assert.equal(options.sessionGeneration, session.generation);
      const currentMode = mode;
      let complete = false;
      const reading = deferred();
      const stream = {
        reading,
        cancellations: 0,
        callId: mode === "no-id" ? undefined : "call-1",
        async next() {
          reading.resolve();
          if (complete) return { done: true };
          complete = true;
          if (currentMode === "no-id")
            throw new SdkError("unconfirmed", {
              idempotencyKey: options.idempotencyKey,
            });
          if (currentMode === "replay") {
            return { done: false, value: { type: "replay", record: receipt } };
          }
          if (currentMode === "blocked") {
            await events.promise;
            return {
              done: false,
              value: { type: "delta", text: "old account secret" },
            };
          }
          return {
            done: false,
            value: { type: "done", charge: receipt.charge },
          };
        },
        async cancel() {
          this.cancellations++;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      streams.push(stream);
      started.resolve();
      return stream;
    },
  };
  const journal = {
    read: (subject) => entries.get(subject),
    write: (entry) => {
      order.push("save");
      entries.set(entry.subject, structuredClone(entry));
    },
  };
  const views = [];
  const app = new HelloAI(
    new Client(transport),
    journal,
    (view) => views.push(structuredClone(view)),
    () => now,
    () => `uuid-${++serial}`,
  );
  return {
    app,
    transport,
    entries,
    starts,
    streams,
    order,
    views,
    journal,
    balance,
    started,
    set mode(v) {
      mode = v;
    },
    set now(v) {
      now = v;
    },
    set enforced(v) {
      enforced = v;
    },
    set refusal(v) {
      refusal = v;
    },
    switch() {
      session = { ...session, signedIn: true, subject: "bob", generation: "2" };
    },
    replace(change) {
      session = { ...session, ...change };
    },
    block() {
      events = deferred();
      return events;
    },
  };
}
test("paid send persists first, pins generation, shows exact receipt and re-reads ledger", async () => {
  const f = fixture();
  await f.app.refresh();
  await f.app.send("model", "Hello");
  assert.equal(f.starts.length, 1);
  assert.ok(f.order.indexOf("save") < f.order.indexOf("chat"));
  assert.equal(f.app.view.balance.available_milli_2z, 9007199254740993n);
  assert.deepEqual(f.app.view.charge, {
    state: "charged",
    charged2z: 2n,
    receiptId: "receipt-1",
  });
  assert.equal(f.order.at(-1), "balance");
});
test("refusal and unenforced grants start no paid request and no recovery entry", async () => {
  for (const code of [
    "insufficient_balance",
    "cap_exceeded",
    "context_length_exceeded",
  ]) {
    const f = fixture();
    await f.app.refresh();
    f.refusal = code;
    await f.app.send("model", "Hello");
    assert.equal(f.starts.length, 0);
    assert.equal(f.entries.size, 0);
  }
  const f = fixture();
  await f.app.refresh();
  f.enforced = false;
  await f.app.send("model", "Hello");
  assert.equal(f.starts.length, 0);
});
test("failed journal storage prevents paid send", async () => {
  const f = fixture();
  await f.app.refresh();
  f.journal.write = () => {
    throw Error("quota");
  };
  await f.app.send("model", "Hello");
  assert.equal(f.starts.length, 0);
});
test("lost opening response retains keys, never retries, and explicit recovery uses identical body/key", async () => {
  const f = fixture();
  await f.app.refresh();
  f.mode = "no-id";
  await f.app.send("model", "Original prompt");
  assert.equal(f.starts.length, 1);
  assert.equal(f.app.view.charge.state, "pending");
  await assert.rejects(f.app.send("model", "New prompt"), {
    code: "unconfirmed",
  });
  f.mode = "replay";
  await f.app.recover();
  assert.equal(f.starts.length, 2);
  assert.deepEqual(f.starts[1], f.starts[0]);
  assert.equal(f.app.view.entry.callId, "call-1");
  assert.equal(f.app.view.charge.state, "charged");
});
test("expired and future-dated keys cannot start paid recovery", async () => {
  for (const elapsed of [23 * 3600000, -1]) {
    const f = fixture();
    await f.app.refresh();
    f.mode = "no-id";
    await f.app.send("model", "Hello");
    f.now = at + elapsed;
    await f.app.recover();
    assert.equal(f.starts.length, 1);
  }
});
test("cancellation keeps an unknown charge and known ID; recovery reads instead of sending", async () => {
  const f = fixture();
  await f.app.refresh();
  f.mode = "blocked";
  const gate = f.block();
  const pending = f.app.send("model", "Hello");
  await f.started.promise;
  await f.app.cancel();
  gate.resolve();
  await pending;
  assert.equal(f.app.view.charge.state, "pending");
  await f.app.recover();
  assert.equal(f.starts.length, 1);
  assert.equal(f.app.view.charge.state, "charged");
});
test("account replacement quarantines old journal and rejects late output", async () => {
  const f = fixture();
  await f.app.refresh();
  f.mode = "blocked";
  const gate = f.block();
  const pending = f.app.send("model", "Hello");
  await f.started.promise;
  f.switch();
  await f.app.refresh();
  gate.resolve();
  await pending;
  assert.equal(f.app.view.session.subject, "bob");
  assert.equal(f.app.view.text, "");
  assert.equal(f.app.view.entry, undefined);
  assert.ok(f.entries.has("alice"));
});
test("unconfirmed sign-out clears the visible identity without claiming revocation", async () => {
  const f = fixture();
  await f.app.refresh();
  await f.app.signOut();
  assert.equal(f.app.view.session.signedIn, false);
  assert.match(f.app.view.status, /not confirmed/);
});
test("browser journal stores no tokens, keeps apps/accounts separate and rejects corrupt units", () => {
  const data = new Map();
  const storage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
  };
  const journal = browserJournal(storage, "app-id"),
    other = browserJournal(storage, "other-app");
  const entry = {
    subject: "alice",
    operationId: "op",
    idempotencyKey: "key",
    startedAt: at,
    model: "model",
    prompt: "Hello",
    maxOutputTokens: "256",
  };
  journal.write(entry);
  assert.deepEqual(journal.read("alice"), entry);
  assert.equal(journal.read("bob"), undefined);
  assert.equal(other.read("alice"), undefined);
  journal.write({ ...entry, maxOutputTokens: "256.1" });
  assert.throws(() => journal.read("alice"));
});

test("sign-in transition blocks paid actions until authentication finishes", async () => {
  const f = fixture();
  await f.app.refresh();
  const gate = deferred();
  f.transport.signIn = () => gate.promise;
  const pending = f.app.signIn(true);
  assert.equal(f.app.view.authenticating, true);
  await assert.rejects(f.app.send("model", "Hello"), {
    code: "invalid_request",
  });
  await assert.rejects(f.app.signIn(), { code: "invalid_request" });
  gate.resolve(await f.transport.session());
  await pending;
  assert.equal(f.app.view.busy, false);
  assert.equal(f.app.view.authenticating, false);
  assert.equal(f.starts.length, 0);
});

for (const outcome of ["resolve", "reject"]) {
  test(`late cancellation ${outcome} cannot publish into or stop a newer account's call`, async () => {
    const f = fixture();
    await f.app.refresh();
    f.mode = "blocked";
    const oldRead = f.block();
    const oldRun = f.app.send("model", "Alice prompt");
    await f.started.promise;
    const oldStream = f.streams[0];
    await oldStream.reading.promise;
    const stopped = deferred(),
      stopping = deferred();
    oldStream.cancel = async () => {
      stopping.resolve();
      await stopped.promise;
    };
    const cancel = f.app.cancel();
    await stopping.promise;
    f.switch();
    await f.app.refresh();
    const newRead = f.block(),
      newStarted = deferred();
    const originalChat = f.transport.chat;
    f.transport.chat = async (...args) => {
      const stream = await originalChat(...args);
      newStarted.resolve(stream);
      return stream;
    };
    const newRun = f.app.send("model", "Bob prompt");
    const newStream = await newStarted.promise;
    await newStream.reading.promise;
    const before = structuredClone(f.app.view);
    stopped[outcome](new Error("old cancellation failure"));
    oldRead.resolve();
    await Promise.all([cancel, oldRun]);
    assert.deepEqual(f.app.view, before);
    assert.equal(newStream.cancellations, 0);
    assert.equal(f.app.view.session.subject, "bob");
    assert.ok(f.entries.has("alice"));
    await f.app.cancel();
    newRead.resolve();
    await newRun;
  });
}

test("late cancellation observes an external replacement without a UI refresh", async () => {
  const f = fixture();
  await f.app.refresh();
  f.mode = "blocked";
  const read = f.block(),
    stopped = deferred(),
    stopping = deferred();
  const run = f.app.send("model", "Alice prompt");
  await f.started.promise;
  const stream = f.streams[0];
  await stream.reading.promise;
  stream.cancel = async () => {
    stopping.resolve();
    await stopped.promise;
  };
  const cancel = f.app.cancel();
  await stopping.promise;
  f.switch();
  stopped.resolve();
  await cancel;
  read.resolve();
  await run;
  assert.equal(f.app.view.session.subject, "bob");
  assert.equal(f.app.view.status, "Signed in.");
  assert.equal(f.app.view.text, "");
  assert.equal(f.app.view.balance, undefined);
  assert.equal(f.app.view.entry, undefined);
});

for (const phase of ["pending", "completed"]) {
  test(`late sign-out cannot overwrite a ${phase} newer sign-in`, async () => {
    const f = fixture();
    await f.app.refresh();
    const logout = deferred(),
      logoutStarted = deferred(),
      login = deferred();
    const originalSignOut = f.transport.signOut;
    f.transport.signOut = async () => {
      const result = await originalSignOut();
      logoutStarted.resolve();
      await logout.promise;
      return result;
    };
    f.transport.signIn = async () => {
      await login.promise;
      f.switch();
      return f.transport.session();
    };
    const signingOut = f.app.signOut();
    await logoutStarted.promise;
    const signingIn = f.app.signIn();
    if (phase === "completed") {
      login.resolve();
      await signingIn;
    }
    const before = structuredClone(f.app.view);
    logout.resolve();
    await signingOut;
    assert.deepEqual(f.app.view, before);
    if (phase === "pending") {
      assert.equal(f.app.view.authenticating, true);
      assert.equal(f.app.view.status, "Signing in…");
      login.resolve();
      await signingIn;
    }
    assert.equal(f.app.view.session.subject, "bob");
    assert.equal(f.app.view.session.signedIn, true);
    assert.equal(f.app.view.status, "Signed in.");
  });
}

test("late sign-out observes an externally installed session without claiming logout", async () => {
  const f = fixture();
  await f.app.refresh();
  const gate = deferred(),
    entered = deferred();
  const signOut = f.transport.signOut;
  f.transport.signOut = async () => {
    const result = await signOut();
    entered.resolve();
    await gate.promise;
    return result;
  };
  const run = f.app.signOut();
  await entered.promise;
  f.switch();
  gate.resolve();
  await run;
  assert.equal(f.app.view.session.subject, "bob");
  assert.equal(f.app.view.status, "Signed in.");
});

for (const subject of ["alice", "bob"]) {
  test(`post-call balance cannot publish across external generation replacement (${subject})`, async () => {
    const f = fixture();
    await f.app.refresh();
    const balanceRead = deferred(),
      entered = deferred();
    const replacement = { ...f.balance, available_milli_2z: 17n };
    f.transport.balance = async () => {
      entered.resolve();
      return balanceRead.promise;
    };
    const run = f.app.send("model", "Alice prompt");
    await entered.promise;
    f.replace({ subject, generation: "external-2" });
    balanceRead.resolve(replacement);
    await run;
    assert.equal(f.app.view.session.subject, subject);
    assert.equal(f.app.view.session.generation, "external-2");
    assert.equal(f.app.view.balance, undefined);
    assert.equal(f.app.view.busy, false);
    assert.ok(
      f.views.every((view) => view.balance?.available_milli_2z !== 17n),
    );
    assert.ok(f.entries.has("alice"));
  });
  test(`replacement before post-call balance is detected before reading (${subject})`, async () => {
    const f = fixture();
    await f.app.refresh();
    const settled = deferred(),
      cleanup = deferred();
    const chat = f.transport.chat;
    f.transport.chat = async (...args) => {
      const stream = await chat(...args);
      stream.cancel = async () => {
        settled.resolve();
        await cleanup.promise;
      };
      return stream;
    };
    let balanceReads = 0;
    f.transport.balance = async () => {
      balanceReads++;
      return { ...f.balance, available_milli_2z: 17n };
    };
    const run = f.app.send("model", "Alice prompt");
    await settled.promise;
    f.replace({ subject, generation: "external-2" });
    cleanup.resolve();
    await run;
    assert.equal(balanceReads, 0);
    assert.equal(f.app.view.session.subject, subject);
    assert.equal(f.app.view.session.generation, "external-2");
    assert.equal(f.app.view.balance, undefined);
    assert.equal(f.app.view.text, "");
    assert.equal(f.app.view.charge.state, "pending");
  });
}
