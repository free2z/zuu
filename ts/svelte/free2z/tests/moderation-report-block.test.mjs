/**
 * In-app report and block: what goes on the wire and what each
 * answer means to the person.
 *
 * Loaded through Vite in SSR mode so the real generated client and mutator
 * build the requests; `fetch` is the only thing stubbed.
 */
import assert from "node:assert/strict";
import { get } from "svelte/store";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let moderation;
let blocks;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  moderation = await server.ssrLoadModule("/src/lib/moderation.ts");
  blocks = await server.ssrLoadModule("/src/lib/stores/blocks.ts");
});

after(async () => {
  await server?.close();
});

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withFetch(handler, run) {
  const nativeFetch = globalThis.fetch;
  const nativeConsoleError = console.error;
  const calls = [];
  console.error = () => undefined;
  globalThis.fetch = async (input, init = {}) => {
    const call = {
      url: String(input),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = nativeFetch;
    console.error = nativeConsoleError;
  }
}

test("a report posts kind, id, reason and trimmed details to /api/reports/", async () => {
  await withFetch(
    () => json(201, { id: "r1", created_at: "2026-10-04T00:00:00Z" }),
    async (calls) => {
      const outcome = await moderation.submitReport({
        kind: "comment",
        targetId: "0b5f6a52-3d0e-4a8e-9a43-6c7f0f2a9b11",
        reason: "csae",
        details: "  look at this  ",
      });
      assert.deepEqual(outcome, { ok: true });
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /\/api\/reports\/$/);
      assert.equal(calls[0].method, "POST");
      assert.deepEqual(calls[0].body, {
        target_kind: "comment",
        target_id: "0b5f6a52-3d0e-4a8e-9a43-6c7f0f2a9b11",
        reason: "csae",
        details: "look at this",
      });
    },
  );
});

test("empty details are not sent, and long details are capped", async () => {
  await withFetch(
    () => json(201, { id: "r1", created_at: "2026-10-04T00:00:00Z" }),
    async (calls) => {
      await moderation.submitReport({
        kind: "zpage",
        targetId: "addr",
        reason: "spam",
        details: "   ",
      });
      assert.equal("details" in calls[0].body, false);
      await moderation.submitReport({
        kind: "creator",
        targetId: "alice",
        reason: "other",
        details: "x".repeat(moderation.REPORT_DETAILS_MAX + 50),
      });
      assert.equal(calls[1].body.details.length, moderation.REPORT_DETAILS_MAX);
    },
  );
});

test("CSAE is offered first, and every server reason is offered", () => {
  assert.equal(moderation.REPORT_REASONS[0], "csae");
  assert.deepEqual([...moderation.REPORT_REASONS].sort(), [
    "csae",
    "harassment",
    "hate",
    "other",
    "sexual",
    "spam",
    "violence",
  ]);
});

for (const [status, body, expected] of [
  [401, { detail: "Authentication credentials were not provided." }, "auth"],
  [403, { detail: "Forbidden." }, "auth"],
  [429, { detail: "Report limit reached. Please try again later." }, "rate"],
  [404, { detail: "Not found." }, "gone"],
  [400, { reason: ['"made-up" is not a valid choice.'] }, "invalid"],
  [500, { detail: "boom" }, "failed"],
]) {
  test(`a ${status} report answer means "${expected}"`, async () => {
    await withFetch(
      () => json(status, body),
      async () => {
        const outcome = await moderation.submitReport({
          kind: "creator",
          targetId: "alice",
          reason: "spam",
        });
        assert.equal(outcome.ok, false);
        assert.equal(outcome.reason, expected);
        if (expected === "invalid") {
          assert.equal(outcome.message, '"made-up" is not a valid choice.');
        }
      },
    );
  });
}

test("a network failure is a failed report, never a thrown error", async () => {
  await withFetch(
    () => {
      throw new TypeError("fetch failed");
    },
    async () => {
      const outcome = await moderation.submitReport({
        kind: "creator",
        targetId: "alice",
        reason: "spam",
      });
      assert.deepEqual(outcome, { ok: false, reason: "failed" });
    },
  );
});

test("block is PUT and unblock is DELETE on the creator's block route", async () => {
  await withFetch(
    (call) => json(200, { username: "Alice", active: call.method === "PUT" }),
    async (calls) => {
      assert.deepEqual(await moderation.setBlocked("Alice", true), {
        ok: true,
        blocked: true,
      });
      assert.deepEqual(await moderation.setBlocked("Alice", false), {
        ok: true,
        blocked: false,
      });
      assert.equal(calls[0].method, "PUT");
      assert.match(calls[0].url, /\/api\/creator\/Alice\/block\/$/);
      assert.equal(calls[1].method, "DELETE");
      assert.match(calls[1].url, /\/api\/creator\/Alice\/block\/$/);
    },
  );
});

test("a refused block says why", async () => {
  await withFetch(
    () => json(400, { detail: "A creator cannot block themselves." }),
    async () => {
      assert.deepEqual(await moderation.setBlocked("me", true), {
        ok: false,
        reason: "invalid",
      });
    },
  );
});

test("the block list loads every page for the signed-in account and clears on sign-out", async () => {
  await withFetch(
    (call) => {
      const page = new URL(call.url, "http://x").searchParams.get("page");
      if (page === "1") {
        return json(200, {
          count: 49,
          next: "http://x/api/g12f/blocks/mine/?page=2",
          results: [{ username: "Spammer", created_at: "2026-10-04" }],
        });
      }
      return json(200, {
        count: 49,
        next: null,
        results: [{ username: "troll", created_at: "2026-10-03" }],
      });
    },
    async (calls) => {
      blocks.trackSignedInAccount("Reader");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(calls.length, 2);
      assert.match(calls[0].url, /\/api\/g12f\/blocks\/mine\/\?/);
      const usernames = get(blocks.blockedUsernames);
      assert.equal(blocks.isBlockedIn(usernames, "spammer"), true);
      assert.equal(blocks.isBlockedIn(usernames, "TROLL"), true);
      assert.equal(blocks.isBlockedIn(usernames, "friend"), false);
      assert.equal(blocks.isBlockedIn(usernames, undefined), false);

      blocks.setLocallyBlocked("Friend", true);
      assert.equal(
        blocks.isBlockedIn(get(blocks.blockedUsernames), "friend"),
        true,
      );
      blocks.setLocallyBlocked("troll", false);
      assert.equal(
        blocks.isBlockedIn(get(blocks.blockedUsernames), "troll"),
        false,
      );

      blocks.trackSignedInAccount(null);
      assert.equal(get(blocks.blockedUsernames).size, 0);
    },
  );
});

test("an unblock made while the list is loading is not undone by an older page", async () => {
  let releasePageTwo;
  const pageTwo = new Promise((resolve) => (releasePageTwo = resolve));
  await withFetch(
    async (call) => {
      const page = new URL(call.url, "http://x").searchParams.get("page");
      if (page === "1") {
        return json(200, {
          count: 49,
          next: "http://x/api/g12f/blocks/mine/?page=2",
          results: [{ username: "Alice", created_at: "2026-10-04" }],
        });
      }
      await pageTwo;
      return json(200, {
        count: 49,
        next: null,
        results: [{ username: "alice", created_at: "2026-10-04" }],
      });
    },
    async () => {
      blocks.trackSignedInAccount(null);
      blocks.trackSignedInAccount("race-reader", []);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        blocks.isBlockedIn(get(blocks.blockedUsernames), "alice"),
        true,
      );
      blocks.setLocallyBlocked("Alice", false);
      releasePageTwo();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        blocks.isBlockedIn(get(blocks.blockedUsernames), "alice"),
        false,
      );
      blocks.trackSignedInAccount(null);
    },
  );
});

test("a block answer for the previous account never edits the next account's list", async () => {
  await withFetch(
    () => json(200, { count: 0, next: null, results: [] }),
    async () => {
      blocks.trackSignedInAccount(null);
      blocks.trackSignedInAccount("Account-A", []);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // A's unblock/block is in flight; the tab signs in as B meanwhile.
      blocks.trackSignedInAccount("account-b", []);
      await new Promise((resolve) => setTimeout(resolve, 20));
      blocks.setLocallyBlocked("Troll", true, "Account-A");
      assert.equal(
        blocks.isBlockedIn(get(blocks.blockedUsernames), "troll"),
        false,
      );
      // B's own answer (case-insensitive) still applies.
      blocks.setLocallyBlocked("Troll", true, "Account-B");
      assert.equal(
        blocks.isBlockedIn(get(blocks.blockedUsernames), "troll"),
        true,
      );
      // A signed-out answer applies to nobody.
      blocks.setLocallyBlocked("Other", true, null);
      assert.equal(
        blocks.isBlockedIn(get(blocks.blockedUsernames), "other"),
        false,
      );
      blocks.trackSignedInAccount(null);
    },
  );
  const { readFileSync } = await import("node:fs");
  const menu = readFileSync(
    new URL(
      "../src/lib/components/profile/ProfileModerationMenu.svelte",
      import.meta.url,
    ),
    "utf8",
  );
  const calls = menu.match(/setLocallyBlocked\(([^)]*)\)/g) ?? [];
  assert.ok(calls.length >= 2, "the menu writes the store on read and write");
  for (const call of calls) {
    assert.match(call, /,\s*reader\s*\)$/, `${call} must pass the reader`);
  }
});

test("a failed load keeps the pages it got and retries", async () => {
  let pageTwoFailures = 1;
  await withFetch(
    (call) => {
      const page = new URL(call.url, "http://x").searchParams.get("page");
      if (page === "1") {
        return json(200, {
          count: 49,
          next: "http://x/api/g12f/blocks/mine/?page=2",
          results: [{ username: "first", created_at: "2026-10-04" }],
        });
      }
      if (pageTwoFailures-- > 0) return json(503, { detail: "restarting" });
      return json(200, {
        count: 49,
        next: null,
        results: [{ username: "second", created_at: "2026-10-04" }],
      });
    },
    async (calls) => {
      blocks.trackSignedInAccount(null);
      blocks.trackSignedInAccount("retry-reader", [5]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const usernames = get(blocks.blockedUsernames);
      assert.equal(blocks.isBlockedIn(usernames, "first"), true);
      assert.equal(blocks.isBlockedIn(usernames, "second"), true);
      // page 1, failed page 2, then the retry's page 1 and page 2.
      assert.equal(calls.length, 4);
      blocks.trackSignedInAccount(null);
    },
  );
});

test("every comment renderer carries the report control and the block placeholder", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of [
    "src/lib/components/comments/CommentCard.svelte",
    "src/lib/components/converse/ConversePost.svelte",
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /<CommentReportButton\b/, file);
    assert.match(source, /isBlockedIn\(\s*\$blockedUsernames/, file);
  }
});

test("a load that exhausted its retries recovers on the next trigger", async () => {
  let up = false;
  await withFetch(
    () =>
      up
        ? json(200, {
            count: 1,
            next: null,
            results: [{ username: "late", created_at: "2026-10-04" }],
          })
        : json(503, { detail: "restarting" }),
    async () => {
      blocks.trackSignedInAccount(null);
      blocks.trackSignedInAccount("recover-reader", []);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(get(blocks.blockedUsernames).size, 0);
      up = true;
      // Same reader again (an auth revalidation) is the recovery trigger.
      blocks.trackSignedInAccount("recover-reader", []);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        blocks.isBlockedIn(get(blocks.blockedUsernames), "late"),
        true,
      );
      blocks.trackSignedInAccount(null);
    },
  );
});

test("an unblock that shifts the server's pages mid-load does not skip a row", async () => {
  // 49 blocks, newest first: page one is u1..u48, page two is u49.
  let server = Array.from({ length: 49 }, (_, i) => `u${i + 1}`);
  let releasePageTwo;
  const pageTwoGate = new Promise((resolve) => (releasePageTwo = resolve));
  let pageTwoCalls = 0;
  await withFetch(
    async (call) => {
      const page = Number(
        new URL(call.url, "http://x").searchParams.get("page"),
      );
      if (page === 2 && pageTwoCalls++ === 0) await pageTwoGate;
      const rows = server.slice((page - 1) * 48, page * 48);
      return json(200, {
        count: server.length,
        next: page * 48 < server.length ? `http://x/?page=${page + 1}` : null,
        results: rows.map((username) => ({ username, created_at: "x" })),
      });
    },
    async () => {
      blocks.trackSignedInAccount(null);
      blocks.trackSignedInAccount("shift-reader", []);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The reader unblocks u1; the server's page two is now empty and u49
      // has moved onto page one, which this load already read.
      server = server.slice(1);
      blocks.setLocallyBlocked("u1", false);
      releasePageTwo();
      await new Promise((resolve) => setTimeout(resolve, 40));
      const usernames = get(blocks.blockedUsernames);
      assert.equal(blocks.isBlockedIn(usernames, "u49"), true);
      assert.equal(blocks.isBlockedIn(usernames, "u1"), false);
      blocks.trackSignedInAccount(null);
    },
  );
});
