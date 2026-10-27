import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite;
let editLoad;

before(async () => {
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  ({ load: editLoad } = await vite.ssrLoadModule("/src/routes/edit/+page.ts"));
});

after(async () => {
  await vite?.close();
});

test("the editor ownership redirect encodes an above-Latin-1 username", async () => {
  const currentUsername = "cΔrovΣr0";
  const event = {
    url: new URL("https://free2z.cash/edit?id=page-id"),
    parent: async () => ({ locale: "en" }),
    fetch: async (input) => {
      const path = String(input);
      if (path === "/api/auth/user/") {
        return new Response(JSON.stringify({ username: currentUsername }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (path.startsWith("/api/zpage/page-id/")) {
        return new Response(
          JSON.stringify({
            creator: { username: "other-owner" },
            actual_language: "en",
            source_language: "en",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`unexpected fetch: ${path}`);
    },
  };

  await assert.rejects(
    () => editLoad(event),
    (thrown) => {
      assert.equal(thrown.status, 302);
      assert.match(
        thrown.location,
        /^[\x20-\x7e]*$/,
        "Location must be ASCII-safe",
      );
      assert.equal(thrown.location, "/c%CE%94rov%CE%A3r0/dashboard/pages");
      return true;
    },
  );
});
