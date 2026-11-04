/**
 * "Mark all as read" failing must neither lie nor lose events.
 *
 * It used to restore a snapshot taken BEFORE the request, silently — which
 * threw away every event the websocket delivered while the request was in
 * flight, and told the person nothing. Now the store undoes only its own
 * optimistic flip, keeps arrivals, and re-throws the server's reason for the
 * page to show.
 *
 * Loaded through Vite in SSR mode, where the store's server re-read is a
 * no-op — so what is asserted is the restore itself, not a reload papering
 * over it.
 */
import assert from "node:assert/strict";
import { get } from "svelte/store";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let eventNotifications;
let fetchUnreadCount;
let UnreadCountRecipientEnvelopeUnavailableError;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ eventNotifications } = await server.ssrLoadModule(
    "/src/lib/stores/eventNotifications.ts",
  ));
  ({ fetchUnreadCount, UnreadCountRecipientEnvelopeUnavailableError } =
    await server.ssrLoadModule("/src/lib/api/events/eventNotificationsApi.ts"));
});

after(async () => {
  await server?.close();
});

function event(id, read) {
  return {
    id,
    type: "PAGE_VOTE",
    read,
    amount: 1,
    contributor: { username: "alice" },
    receiving_user: { username: "bob" },
    created_at: "2026-09-22 00:00:00",
  };
}

test("unread counts require and validate the requested recipient", async () => {
  const nativeFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input), "https://test.invalid");
      assert.equal(url.pathname, "/api/events/unread_count/");
      assert.equal(url.searchParams.get("include_recipient"), "1");
      return new Response(
        JSON.stringify({ unread_count: 7, recipient_username: "bob" }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    assert.equal(await fetchUnreadCount(undefined, "bob"), 7);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ unread_count: 7 }), {
        headers: { "Content-Type": "application/json" },
      });
    await assert.rejects(
      fetchUnreadCount(undefined, "bob"),
      UnreadCountRecipientEnvelopeUnavailableError,
    );

    globalThis.fetch = async () =>
      new Response(JSON.stringify(7), {
        headers: { "Content-Type": "application/json" },
      });
    await assert.rejects(
      fetchUnreadCount(undefined, "bob"),
      UnreadCountRecipientEnvelopeUnavailableError,
    );

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ unread_count: 400, recipient_username: "alice" }),
        { headers: { "Content-Type": "application/json" } },
      );
    await assert.rejects(
      fetchUnreadCount(undefined, "bob"),
      /Unread count recipient changed/,
    );

    globalThis.fetch = async () => {
      throw new Error("an empty recipient must not make a request");
    };
    await assert.rejects(
      fetchUnreadCount(undefined, ""),
      /Unread count recipient is missing/,
    );
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("owned receipt evidence survives a rejected unread-count response", async () => {
  const nativeFetch = globalThis.fetch;
  const json = (value) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://test.invalid");
    if (url.searchParams.has("recovery"))
      return json({
        results: [{ ...event("owned-credit", false), type: "BOUGHT_TUZI" }],
        next: null,
        recovery_boundary: "owned-receipt-scan",
      });
    if (url.pathname === "/api/events/has/") return json(true);
    if (url.pathname === "/api/events/unread_count/")
      return json({ unread_count: 400, recipient_username: "alice" });
    return json({
      results: [event("owned-head", false)],
      next: null,
    });
  };
  try {
    eventNotifications.clearForLogout();
    eventNotifications.addIncomingEvent(event("known", false));
    assert.equal(get(eventNotifications).unreadCount, 1);

    const recovered = await eventNotifications.reconcilePayments("bob");

    assert.deepEqual(
      recovered.map((row) => row.id),
      ["owned-credit"],
    );
    assert.deepEqual(
      get(eventNotifications).events.map((row) => row.id),
      ["owned-head", "known"],
    );
    assert.equal(get(eventNotifications).unreadCount, 1);
  } finally {
    globalThis.fetch = nativeFetch;
    eventNotifications.clearForLogout();
  }
});

test("a failed mark-all keeps arrivals, restores only its own flip, and says why", async () => {
  const nativeFetch = globalThis.fetch;
  const nativeConsoleError = console.error;
  console.error = () => undefined;
  let answer;
  const requested = new Promise((resolve) => {
    globalThis.fetch = (input, init) => {
      assert.match(String(input), /\/api\/events\/read\/all\/$/);
      assert.equal(init?.method, "POST");
      resolve();
      return new Promise((settle) => {
        answer = settle;
      });
    };
  });

  try {
    eventNotifications.clearForLogout();
    eventNotifications.addIncomingEvent(event("old-read", true));
    eventNotifications.addIncomingEvent(event("old-unread", false));
    assert.equal(get(eventNotifications).unreadCount, 1);

    const marking = eventNotifications.markAllRead();
    await requested;
    // Optimistic state while in flight.
    assert.equal(get(eventNotifications).unreadCount, 0);
    assert.equal(get(eventNotifications).markingAllRead, true);

    // The websocket delivers a new event mid-request.
    eventNotifications.addIncomingEvent(event("arrived", false));

    answer(
      new Response(
        JSON.stringify({ detail: "Notifications are temporarily read-only." }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    );

    await assert.rejects(marking, (error) => {
      assert.equal(error.name, "ApiError");
      assert.equal(error.message, "Notifications are temporarily read-only.");
      return true;
    });

    const state = get(eventNotifications);
    const byId = Object.fromEntries(state.events.map((e) => [e.id, e.read]));
    assert.deepEqual(byId, {
      arrived: false, // kept — the old snapshot restore discarded it
      "old-unread": false, // our optimistic flip, undone
      "old-read": true, // was read before, stays read
    });
    assert.equal(state.unreadCount, 2);
    assert.equal(state.markingAllRead, false);
  } finally {
    globalThis.fetch = nativeFetch;
    console.error = nativeConsoleError;
    eventNotifications.clearForLogout();
  }
});

test("an aborted ignored body cannot retire the replacement receipt scan", async () => {
  const nativeFetch = globalThis.fetch;
  let oldBody,
    releaseNew,
    receiptReads = 0;
  let oldStarted, newStarted;
  const oldReady = new Promise((resolve) => {
    oldStarted = resolve;
  });
  const newReady = new Promise((resolve) => {
    newStarted = resolve;
  });
  const json = (value) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://test.invalid");
    if (url.searchParams.get("recovery") === "payments") {
      if (++receiptReads === 1) {
        const stream = new ReadableStream({
          start(controller) {
            oldBody = controller;
            oldStarted();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "application/json" },
        });
      }
      newStarted();
      return new Promise((resolve) => {
        releaseNew = resolve;
      });
    }
    if (url.pathname === "/api/events/has/") return json(true);
    if (url.pathname === "/api/events/unread_count/")
      return json({ unread_count: 1, recipient_username: "bob" });
    return json({ results: [], count: 0, next: null });
  };
  try {
    eventNotifications.clearForLogout();
    const controller = new AbortController();
    const old = eventNotifications.reconcilePayments("bob", controller.signal);
    const oldRejected = assert.rejects(
      old,
      (error) => error.name === "AbortError",
    );
    await oldReady;
    controller.abort(
      new DOMException("Receipt history interrupted", "AbortError"),
    );
    const replacement = eventNotifications.reconcilePayments("bob");
    await newReady;
    oldBody.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          results: [{ ...event("stale", false), type: "BOUGHT_TUZI" }],
          next: null,
          recovery_boundary: "old-scan",
        }),
      ),
    );
    oldBody.close();
    await oldRejected;
    releaseNew(
      json({
        results: [{ ...event("replacement", false), type: "BOUGHT_TUZI" }],
        next: null,
        recovery_boundary: "new-scan",
      }),
    );
    const recovered = await replacement;
    assert.deepEqual(
      recovered.map((receipt) => receipt.id),
      ["replacement"],
    );
    assert.deepEqual(
      get(eventNotifications).events.map((receipt) => receipt.id),
      [],
    );
  } finally {
    globalThis.fetch = nativeFetch;
    eventNotifications.clearForLogout();
  }
});

test("slow advancing receipt pages retain one scan and do not expand the paginated feed", async () => {
  const nativeFetch = globalThis.fetch;
  let reads = 0,
    starts = 0;
  const json = (value) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  const receipts = Array.from({ length: 1000 }, (_, i) => ({
    ...event(`receipt-${i}`, false),
    type: "BOUGHT_TUZI",
  }));
  const head = Array.from({ length: 12 }, (_, i) => event(`head-${i}`, true));
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://test.invalid");
    if (url.searchParams.get("recovery") === "payments") {
      reads++;
      if (!url.searchParams.has("recovery_cursor")) starts++;
      const offset = Number(url.searchParams.get("recovery_cursor") || 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
      return json({
        results: receipts.slice(offset, offset + 48),
        next:
          offset + 48 < receipts.length
            ? `/api/events/?recovery=payments&recovery_cursor=${offset + 48}`
            : null,
        recovery_boundary: "slow-scan",
        count: 1000,
      });
    }
    if (url.pathname === "/api/events/has/") return json(true);
    if (url.pathname === "/api/events/unread_count/")
      return json({ unread_count: 1000, recipient_username: "bob" });
    return json({ results: head, next: "/api/events/?page=2", count: 1012 });
  };
  try {
    eventNotifications.clearForLogout();
    let recovered = null;
    while (recovered === null) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new DOMException("Deadline", "TimeoutError")),
        80,
      );
      try {
        recovered = await eventNotifications.reconcilePayments(
          "bob",
          controller.signal,
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    assert.equal(starts, 1);
    assert.equal(reads, 21);
    assert.equal(recovered.length, 1000);
    assert.deepEqual(
      get(eventNotifications).events.map((row) => row.id),
      head.map((row) => row.id),
    );
    assert.equal(get(eventNotifications).nextPageUrl, "/api/events/?page=2");
  } finally {
    globalThis.fetch = nativeFetch;
    eventNotifications.clearForLogout();
  }
});

test("aborting the final normal head preserves completed receipt evidence under new ownership", async () => {
  const nativeFetch = globalThis.fetch;
  const json = (value) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  let receiptReads = 0,
    normalReads = 0,
    releaseOld,
    releaseNew;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://test.invalid");
    if (url.searchParams.has("recovery")) {
      receiptReads++;
      return json({
        results: [{ ...event("ack-only", false), type: "BOUGHT_TUZI" }],
        next: null,
        recovery_boundary: "completed",
      });
    }
    if (url.pathname === "/api/events/has/") return json(true);
    if (url.pathname === "/api/events/unread_count/")
      return json({ unread_count: 1, recipient_username: "bob" });
    normalReads++;
    return new Promise((resolve) =>
      normalReads === 1 ? (releaseOld = resolve) : (releaseNew = resolve),
    );
  };
  const waitFor = async (condition) => {
    while (!condition()) await new Promise((resolve) => setTimeout(resolve, 1));
  };
  try {
    eventNotifications.clearForLogout();
    const controller = new AbortController();
    const old = eventNotifications.reconcilePayments("bob", controller.signal);
    const rejected = assert.rejects(
      old,
      (error) => error.name === "AbortError",
    );
    await waitFor(() => releaseOld);
    controller.abort(new DOMException("Yield", "AbortError"));
    const replacement = eventNotifications.reconcilePayments("bob");
    await waitFor(() => releaseNew);
    releaseOld(json({ results: [event("stale-head", false)], next: null }));
    await rejected;
    assert.deepEqual(get(eventNotifications).events, []);
    releaseNew(json({ results: [event("fresh-head", false)], next: null }));
    assert.deepEqual(
      (await replacement).map((row) => row.id),
      ["ack-only"],
    );
    assert.equal(receiptReads, 1);
    assert.deepEqual(
      get(eventNotifications).events.map((row) => row.id),
      ["fresh-head"],
    );
  } finally {
    globalThis.fetch = nativeFetch;
    eventNotifications.clearForLogout();
  }
});

test("a bound notification recipient rejects a stale recovery invocation before transport", async () => {
  const nativeFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("a stale recipient must not issue a request");
  };
  try {
    eventNotifications.clearForLogout();
    eventNotifications.enterNotificationsView("bob");
    await assert.rejects(
      eventNotifications.reconcile("alice"),
      /recipient changed/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = nativeFetch;
    eventNotifications.clearForLogout();
  }
});
