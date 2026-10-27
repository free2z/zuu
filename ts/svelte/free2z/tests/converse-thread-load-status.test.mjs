import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

/**
 *  `/converse/<uuid>` is now what Slack, X, Discord & co. unfurl (the
 * Django card tier that used to answer them is retired). An unfurler caches
 * whatever it is handed, so the loader must only ever say "not found" when
 * the API said so about THIS post. A backend 5xx or a transport failure is
 * a 503, which nginx's crawler location turns into a retryable 503 +
 * Retry-After rather than a cached "not found" card. A throttle stays a 429
 * with the API's Retry-After: a 503 would be retried by nginx and
 * replaced by the site-wide maintenance page for a signed-in human.
 */

let server;
let load;
const previousApiBase = process.env.PRIVATE_API_BASE_URL;
const UUID = "0b7a3c1e-1111-4222-8333-944455556666";

before(async () => {
  process.env.PRIVATE_API_BASE_URL = "https://api.free2z.test";
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { hmr: false, middlewareMode: true },
  });
  ({ load } = await server.ssrLoadModule(
    "/src/routes/converse/[uuid]/+page.server.ts",
  ));
});

after(async () => {
  await server?.close();
  if (previousApiBase === undefined) delete process.env.PRIVATE_API_BASE_URL;
  else process.env.PRIVATE_API_BASE_URL = previousApiBase;
});

function event(fetchImpl) {
  return {
    params: { uuid: UUID },
    request: new Request(`https://free2z.cash/converse/${UUID}`),
    fetch: fetchImpl,
    setHeaders: () => {},
    locals: {},
    url: new URL(`https://free2z.cash/converse/${UUID}`),
    isDataRequest: false,
  };
}

async function statusOf(fetchImpl) {
  const originalError = console.error;
  console.error = () => {};
  try {
    await load(event(fetchImpl));
    return 200;
  } catch (thrown) {
    if (typeof thrown?.status === "number") return thrown.status;
    throw thrown;
  } finally {
    console.error = originalError;
  }
}

const answering = (status) => async () =>
  new Response(JSON.stringify({ detail: "x" }), {
    status,
    headers: { "content-type": "application/json" },
  });

test("a post the API does not have is a 404", async () => {
  assert.equal(await statusOf(answering(404)), 404);
});

test("a throttle stays a 429 with the API's Retry-After, never a 503 (#2190)", async () => {
  const headers = {};
  const throttled = async () =>
    new Response("{}", { status: 429, headers: { "retry-after": "17" } });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      load({
        ...event(throttled),
        setHeaders: (h) => Object.assign(headers, h),
      }),
      (thrown) => thrown?.status === 429,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(headers["retry-after"], "17");
});

for (const status of [500, 502, 503, 504]) {
  test(`a backend ${status} is a retryable 503, never "not found"`, async () => {
    assert.equal(await statusOf(answering(status)), 503);
  });
}

test('a transport failure is a retryable 503, never "not found"', async () => {
  const refused = async () => {
    throw new TypeError("fetch failed: ECONNREFUSED");
  };
  assert.equal(await statusOf(refused), 503);
});

test("a present post still renders (positive control)", async () => {
  const ok = async () =>
    Response.json({ uuid: UUID, parent: null, content: "hello" });
  assert.equal(await statusOf(ok), 200);
});

const PARENT = "1c8b4d2f-2222-4333-8444-a55566667777";
const replyThenParent = (parentStatus) => async (input) => {
  const path = new URL(String(input)).pathname;
  if (path === `/api/comments/${UUID}/`) {
    return Response.json({ uuid: UUID, parent: PARENT, content: "a reply" });
  }
  return new Response("{}", { status: parentStatus });
};

for (const [status, expected] of [
  [429, 429],
  [503, 503],
]) {
  test(`an ancestor ${status} is a ${expected}, not a 200 card built from the reply`, async () => {
    assert.equal(await statusOf(replyThenParent(status)), expected);
  });
}

test("a missing ancestor still renders the reply (unchanged)", async () => {
  assert.equal(await statusOf(replyThenParent(404)), 200);
});
