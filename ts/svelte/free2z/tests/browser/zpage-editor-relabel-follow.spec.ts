import { expect, test } from "@playwright/test";

//the background language detector relabels a zPage a few minutes
// after a save (`en` -> `es`). that no longer fails the creator's
// next autosave with a 412 -- provided the editor says which label it saw
// (`X-Free2Z-Source-Language`) -- so the save SUCCEEDS and its response names
// the new label. The editor must follow it: it was showing the canonical article
// and still is. If it kept `selectedLanguage = "en"`, `isCanonicalLanguage`
// would turn false and the NEXT autosave would PUT the creator's article body
// to `/translations/en/` as a brand-new "translation", while the real article
// silently stopped receiving edits.

// Named `zpage-*`, not `editor-*`, on purpose: sharding is alphabetical by
// file and the `editor-*` block already makes shard 2 of 5 the one closest to
// its time budget (CLAUDE.md, "The browser suite is its own job").

test.setTimeout(120_000);

const ARTICLE_ID = "detected-relabel-fixture";
const CREATOR = {
  id: 8249,
  username: "detected-relabel-user",
  full_name: "Detected Relabel User",
  p2paddr: "",
};

type Write = {
  method: string;
  pathname: string;
  body: Record<string, any>;
  claimed: string | undefined;
};

test("a detector relabel seen in a save response keeps saves canonical", async ({
  page,
}) => {
  const writes: Write[] = [];
  // What the server's label is. The detector moves it after the create.
  let sourceLanguage = "en";

  function detail(body: Record<string, any>) {
    return {
      id: 2179,
      free2zaddr: ARTICLE_ID,
      vanity: ARTICLE_ID,
      title: body.title || "",
      description: body.description || "",
      canonical_url: body.canonical_url || "",
      content: body.content || "",
      tags: body.tags || [],
      p2paddr: body.p2paddr || "",
      featured_image: null,
      is_published: false,
      is_subscriber_only: false,
      publish_at: null,
      creator: CREATOR,
      source_language: sourceLanguage,
      language_source: sourceLanguage === "en" ? null : "detected",
      detected_language: sourceLanguage === "en" ? null : sourceLanguage,
      detection_confidence: sourceLanguage === "en" ? null : 0.95,
      actual_language: sourceLanguage,
      requested_language: sourceLanguage,
      available_languages: [sourceLanguage],
      variant_is_published: false,
      created_at: "2026-09-26T00:00:00Z",
      updated_at: "2026-09-26T00:00:00Z",
    };
  }

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      const method = request.method();

      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }

      if (
        (method === "POST" || method === "PUT" || method === "PATCH") &&
        pathname.startsWith("/api/zpage/")
      ) {
        const body = JSON.parse(request.postData() || "{}");
        writes.push({
          method,
          pathname,
          body,
          claimed: request.headers()["x-free2z-source-language"],
        });
        if (/\/(variants|translations)\//.test(pathname)) {
          // A translation create would be the bug; answer it plausibly so
          // the assertion below, not a crash, is what reports it.
          await route.fulfill({ status: 200, json: detail(body) });
          return;
        }
        const isCreate = pathname === "/api/zpage/";
        await route.fulfill({
          status: isCreate ? 201 : 200,
          json: detail(body),
          headers: { ETag: `"state-${writes.length}.label-${sourceLanguage}"` },
        });
        // The detector finishes right after the create commits.
        if (isCreate) sourceLanguage = "es";
        return;
      }

      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  await page.goto("/edit?lang=en");
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible({ timeout: 30_000 });

  await page.locator("textarea").first().fill("Mensajeria cifrada");
  await body.fill("Este articulo esta escrito en espanol.");
  await expect.poll(() => writes.length, { timeout: 15_000 }).toBe(1);
  expect(writes[0]).toMatchObject({ method: "POST", pathname: "/api/zpage/" });

  // Save 2: the response is the first to carry the detector's `es`.
  await body.fill("Este articulo esta escrito en espanol. Un parrafo mas.");
  await expect.poll(() => writes.length, { timeout: 15_000 }).toBe(2);
  expect(writes[1]).toMatchObject({
    method: "PUT",
    pathname: `/api/zpage/${ARTICLE_ID}/`,
  });
  // An update never sends the label; that is what lets it pass the
  // precondition across a detector relabel on the server.
  expect(writes[1].body).not.toHaveProperty("source_language");
  //...and it says which label it saw, which is what the backend needs to
  // tell a detector relabel from a second editor.
  expect(writes[1].claimed).toBe("en");

  // Save 3 is the one that used to go to `/translations/en/`.
  await body.fill(
    "Este articulo esta escrito en espanol. Un parrafo mas. Y otro.",
  );
  await expect.poll(() => writes.length, { timeout: 15_000 }).toBe(3);
  expect(writes[2]).toMatchObject({
    method: "PUT",
    pathname: `/api/zpage/${ARTICLE_ID}/`,
  });
  expect(writes[2].claimed).toBe("es");
  expect(
    writes.some((write) => /\/(variants|translations)\//.test(write.pathname)),
  ).toBe(false);
  // The editor now says what the article is, in its address too.
  await expect
    .poll(() => new URL(page.url()).searchParams.get("lang"))
    .toBe("es");
});
