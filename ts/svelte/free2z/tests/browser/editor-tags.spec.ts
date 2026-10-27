import { expect, test, type Page } from "@playwright/test";

/**
 * Free-form tags in the editor.
 *
 * The backend field is `django-taggit` — an open vocabulary. The editor used
 * to front it with a twenty-item `<Select>`, so a creator could neither add a
 * tag outside that list nor remove one. These tests exercise the real editor
 * against a stubbed API and assert on the bytes that leave the browser,
 * because "the tag is on screen" and "the tag is in the PUT" are different
 * claims and only the second one survives a reload.
 *
 * The first test is the regression the issue is really about: an article
 * carrying tags no picker knows must come back unharmed from a save that had
 * nothing to do with tags.
 *
 * Against `main` these fail at the first assertion for the same reason: there
 * is no text input in the publish sheet at all, only a listbox of twenty.
 */

const CREATOR = { id: 8103, username: "tagsmith", full_name: "Tag Smith" };

const ARTICLE_ID = "tagged-fixture";

/** Tags a closed twenty-item picker could never have rendered. */
const UNKNOWN_TAGS = ["zebra husbandry", "café-culture"];

const SUGGESTIONS = [
  { name: "zcash", count: 42 },
  { name: "privacy", count: 17 },
];

function article() {
  return {
    id: 1,
    free2zaddr: ARTICLE_ID,
    vanity: "tagged-fixture",
    title: "An article with tags nobody hardcoded",
    description: "",
    canonical_url: "",
    content: "Body.",
    tags: [...UNKNOWN_TAGS, "ART"],
    category: "",
    is_published: true,
    is_subscriber_only: false,
    publish_at: null,
    p2paddr: "",
    featured_image: null,
    creator: CREATOR,
    source_language: "en",
    actual_language: "en",
    requested_language: "en",
    available_languages: ["en"],
    variant_is_published: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

type Sent = { pathname: string; method: string; body: any };

/**
 * `/edit` is `ssr = false`, so every call it makes is client-side and the
 * Playwright mock-API server never sees them. Interception is the only way to
 * both feed the editor an article and read back what it saves.
 */
async function stubApi(page: Page) {
  const sent: Sent[] = [];

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname, searchParams } = new URL(request.url());
      const method = request.method();

      if (method !== "GET") {
        let body: any = null;
        try {
          body = JSON.parse(request.postData() || "null");
        } catch {
          body = request.postData();
        }
        sent.push({ pathname, method, body });
      }

      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }
      if (pathname === "/api/tagging/autocomplete") {
        const query = (searchParams.get("query") || "").toLowerCase();
        await route.fulfill({
          json: SUGGESTIONS.filter((tag) => tag.name.includes(query)),
        });
        return;
      }
      if (pathname === `/api/zpage/${ARTICLE_ID}/`) {
        // A write echoes what it was sent, the way the API does. Returning the
        // pristine fixture instead makes the editor rehydrate from a response
        // that contradicts the request, which is a bug in the test rather than
        // in the app — and one that hides real ones behind a save loop.
        const body = method === "GET" ? null : sent[sent.length - 1]?.body;
        await route.fulfill({ json: { ...article(), ...(body || {}) } });
        return;
      }
      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  return sent;
}

async function openPublishSheet(page: Page) {
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(page.locator("textarea.writing-area-textarea")).toBeVisible();
  // The sheet is behind the topbar's publish action, which reads "Update"
  // once the article is published.
  await page
    .getByRole("button", { name: /^(update|publish)$/i })
    .first()
    .click();
  const input = page.getByTestId("tag-input");
  await expect(input).toBeVisible();
  return input;
}

/** The `tags` array of the most recent write, whatever route it went to. */
function lastSavedTags(sent: Sent[]): string[] | undefined {
  for (let index = sent.length - 1; index >= 0; index -= 1) {
    const body = sent[index].body;
    if (body && Array.isArray(body.tags)) return body.tags;
  }
  return undefined;
}

test.describe.configure({ timeout: 90_000 });

test("tags the UI never had a picker for are visible and survive a save", async ({
  page,
}) => {
  const sent = await stubApi(page);
  const input = await openPublishSheet(page);

  // Visible first: a tag you cannot see is one you cannot knowingly keep.
  for (const tag of UNKNOWN_TAGS) {
    await expect(
      page.getByRole("button", { name: `Remove tag ${tag}` }),
    ).toBeVisible();
  }

  // An edit that has nothing to do with tags.
  await input.fill("");
  await page
    .getByLabel(/subtitle|description/i)
    .first()
    .fill("A subtitle.");

  await expect
    .poll(() => lastSavedTags(sent), { timeout: 30_000 })
    .toEqual([...UNKNOWN_TAGS, "ART"]);
});

test("a creator can add a tag that is in no predefined list", async ({
  page,
}) => {
  const sent = await stubApi(page);
  const input = await openPublishSheet(page);

  await input.fill("quantum knitting");
  await input.press("Enter");

  await expect
    .poll(() => lastSavedTags(sent), { timeout: 30_000 })
    .toEqual([...UNKNOWN_TAGS, "ART", "quantum knitting"]);
});

test("a comma commits a tag, so pasting a list works", async ({ page }) => {
  const sent = await stubApi(page);
  const input = await openPublishSheet(page);

  await input.fill("halo2 recursion,");

  await expect
    .poll(() => lastSavedTags(sent), { timeout: 30_000 })
    .toEqual([...UNKNOWN_TAGS, "ART", "halo2 recursion"]);
});

test("pasting a long list keeps every tag, not the first 100 characters", async ({
  page,
}) => {
  // The input carries no `maxlength`: 100 characters is a limit on ONE tag,
  // and an aggregate DOM limit would have the browser chop a paste before any
  // of this code ran — tail tags gone, last one truncated, both saved.
  const sent = await stubApi(page);
  const input = await openPublishSheet(page);

  const pasted = [
    "distributed systems reading notes",
    "shielded pool accounting",
    "recursive proof composition",
    "long tail discovery",
  ];
  expect(pasted.join(", ").length).toBeGreaterThan(100);

  await input.fill(`${pasted.join(", ")},`);

  await expect
    .poll(() => lastSavedTags(sent), { timeout: 30_000 })
    .toEqual([...UNKNOWN_TAGS, "ART", ...pasted]);
});

test("a tag can be removed, which the closed picker could not do either", async ({
  page,
}) => {
  const sent = await stubApi(page);
  await openPublishSheet(page);

  await page.getByRole("button", { name: "Remove tag café-culture" }).click();

  await expect
    .poll(() => lastSavedTags(sent), { timeout: 30_000 })
    .toEqual(["zebra husbandry", "ART"]);
});

test("a typed tag adopts the spelling the platform already uses", async ({
  page,
}) => {
  // The free half of normalization: no AI, no destructive case-folding of what
  // the creator typed, and `zcash` stops fraying into `ZCASh` on its own.
  const sent = await stubApi(page);
  const input = await openPublishSheet(page);

  await input.fill("ZCASh");
  // Wait for the corpus to arrive, the way a creator does by pausing: the
  // suggestion lookup is debounced, and a snap can only use what it has.
  await expect(page.getByRole("option", { name: /zcash/ })).toBeVisible();
  await input.press("Enter");

  await expect
    .poll(() => lastSavedTags(sent), { timeout: 30_000 })
    .toEqual([...UNKNOWN_TAGS, "ART", "zcash"]);
});
