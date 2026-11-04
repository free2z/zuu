import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

import {
  PUBLIC_STREAM_TYPES,
  STREAM_TYPES,
  isPublicStreamType,
  requiresAuthenticatedViewer,
} from "../src/lib/streamTypes.js";

//  `/live/{username}?type=` used to be free text that only had to be
// "authenticated" to pass. `?type=private` therefore sent an ordinary logged-in
// visitor into `StreamService.initStream`, which POSTs
// `/api/dyte/{username}/private` — the creator-only manage route. On the server
// that route always acted on `creator=request.user`, so it recycled the
// CALLER's own invite secret and minted a fresh paid provider meeting per
// request, and answered with `{secret, e2ee}`, which fails
// `streamInitResponseSchema` and surfaces as a generic "invalid stream
// response". The authoritative fix is the 403 in `PrivateMeetingManage`
// (py/free2z/dj/apps/dyte/test_private_meeting_access.py); this pins the other half:
// the UI must stop offering an action the API will refuse.

let vite;
let load;

const previousApiBase = process.env.PRIVATE_API_BASE_URL;

before(async () => {
  process.env.PRIVATE_API_BASE_URL = "https://api.free2z.test";
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  ({ load } = await vite.ssrLoadModule(
    "/src/routes/live/[username]/+page.server.ts",
  ));
});

after(async () => {
  await vite?.close();
  if (previousApiBase === undefined) {
    delete process.env.PRIVATE_API_BASE_URL;
  } else {
    process.env.PRIVATE_API_BASE_URL = previousApiBase;
  }
});

/** A page event that records every upstream request the load makes. */
function pageEvent({ type, cookie, authStatus = 200 } = {}) {
  const requests = [];
  const search = type === undefined ? "" : `?type=${encodeURIComponent(type)}`;
  return {
    requests,
    event: {
      params: { username: "alice" },
      url: new URL(`https://free2z.cash/live/alice${search}`),
      request: {
        headers: { get: (name) => (name === "cookie" ? cookie || "" : null) },
      },
      // The same cookie header, parsed the way SvelteKit's `event.cookies`
      // would: the protected-stream guard reads `sessionid` from it.
      cookies: {
        get: (name) =>
          (cookie || "")
            .split(";")
            .map((part) => part.trim().split("="))
            .find(([key]) => key === name)?.[1],
      },
      setHeaders: () => {},
      fetch: async (url) => {
        requests.push(String(url));
        if (String(url).includes("/api/auth/user/")) {
          return new Response(JSON.stringify({ id: 7, username: "bob" }), {
            status: authStatus,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ username: "alice" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
}

/** Run the load and report what it threw (HttpError or Redirect), or the data. */
async function outcome(event) {
  try {
    return { data: await load(event) };
  } catch (thrown) {
    if (thrown?.status && thrown?.body) {
      return { status: thrown.status, message: thrown.body.message };
    }
    if (thrown?.status && thrown?.location) {
      return { status: thrown.status, location: thrown.location };
    }
    throw thrown;
  }
}

// --- the closed enum ---------------------------------------------------------

test("private is not a value this route serves", () => {
  assert.ok(!PUBLIC_STREAM_TYPES.includes("private"));
  assert.ok(STREAM_TYPES.includes("private"));
  assert.equal(isPublicStreamType("private"), false);
  assert.equal(requiresAuthenticatedViewer("private"), false);
});

test("?type=private is a 404, and costs no upstream request", async () => {
  const { event, requests } = pageEvent({
    type: "private",
    cookie: "sessionid=real-session",
  });

  const result = await outcome(event);

  assert.equal(result.status, 404);
  assert.equal(result.message, "errors.stream.unknownType");
  // The point: the load returns before the creator fetch, so nothing —
  // least of all `/api/dyte/alice/private` downstream — is ever reached.
  assert.deepEqual(requests, []);
});

const REJECTED_TYPES = {
  "upper-case private": "PRIVATE",
  "title-case private": "Private",
  bogus: "bogus",
  "near miss": "ppv2",
  "wrong separator": "subscribers_only",
  "the spelling views.py never implemented": "pay-per-view",
  "300 characters": "x".repeat(300),
};

for (const [label, type] of Object.entries(REJECTED_TYPES)) {
  test(`?type= ${label} is a 404`, async () => {
    const { event, requests } = pageEvent({ type });

    const result = await outcome(event);

    assert.equal(result.status, 404);
    assert.equal(result.message, "errors.stream.unknownType");
    assert.deepEqual(requests, []);
  });
}

test("an empty ?type= falls back to the default rather than 404ing", async () => {
  const { event } = pageEvent({ type: "" });

  const result = await outcome(event);

  assert.equal(result.status, undefined);
  assert.equal(result.data.type, "broadcast");
});

// --- the three real types still work -----------------------------------------

test("broadcast loads for an anonymous visitor without an auth check", async () => {
  const { event, requests } = pageEvent({ type: "broadcast" });

  const result = await outcome(event);

  assert.equal(result.data.type, "broadcast");
  assert.equal(result.data.username, "alice");
  assert.deepEqual(requests, ["https://api.free2z.test/api/creator/alice/"]);
});

test("no ?type= at all still defaults to broadcast", async () => {
  const { event } = pageEvent({});

  const result = await outcome(event);

  assert.equal(result.data.type, "broadcast");
});

test("a mixed-case public type is normalized, not rejected", async () => {
  const { event } = pageEvent({ type: "BroadCast" });

  const result = await outcome(event);

  assert.equal(result.data.type, "broadcast");
});

for (const type of ["subscribers-only", "ppv"]) {
  test(`${type} still redirects an anonymous visitor to log in`, async () => {
    const { event } = pageEvent({ type, authStatus: 401 });

    const result = await outcome(event);

    assert.equal(result.status, 302);
    assert.ok(result.location.startsWith("/login?next="));
    assert.ok(decodeURIComponent(result.location).includes(`type=${type}`));
  });

  test(`${type} loads for a signed-in visitor`, async () => {
    const { event, requests } = pageEvent({
      type,
      cookie: "sessionid=real-session",
    });

    const result = await outcome(event);

    assert.equal(result.data.type, type);
    assert.equal(result.data.viewerActorId, type === "ppv" ? 7 : undefined);
    assert.ok(requests.includes("https://api.free2z.test/api/auth/user/"));
  });

  test(`${type} sends a rejected session (401) to log in`, async () => {
    const { event } = pageEvent({
      type,
      cookie: "sessionid=expired",
      authStatus: 401,
    });

    const result = await outcome(event);

    assert.equal(result.status, 302);
    assert.ok(result.location.startsWith("/login?next="));
  });

  //a backend outage is not a logout.
  for (const authStatus of [429, 502, 503, 504]) {
    test(`${type} answers 503, not /login, when the identity lookup is a ${authStatus}`, async () => {
      const { event } = pageEvent({
        type,
        cookie: "sessionid=real-session",
        authStatus,
      });

      const result = await outcome(event);

      assert.equal(result.status, 503);
      assert.equal(result.location, undefined);
    });
  }
}
