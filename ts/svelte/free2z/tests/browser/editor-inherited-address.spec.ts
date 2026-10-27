import { expect, test, type Page } from "@playwright/test";

//a zPage READ answers `p2paddr` with the EFFECTIVE support address --
// the page's own, else the creator's profile address. The editor used to
// hydrate its address field from that and save it back, so merely opening an
// article that inherits the profile address and saving it pinned a copy of
// that address onto the article; a later profile-address change (a retired or
// compromised wallet) then never reached it, and support kept going to the old
// wallet. The field must hydrate from `p2paddr_override` (null = inherit).
//
// 's spec (editor-save-response-address) covers the WRITE response of a
// NEW article; this one covers OPENING an existing one, which is the path
//  left open.

test.describe.configure({ timeout: 90_000 });

const ARTICLE_ID = "inherited-address-fixture";
const CREATOR_ADDRESS = "u1creatorprofileaddressfixture2061";
const PAGE_ADDRESS = "u1pageownaddressfixture2061";
const CREATOR = {
  id: 2061,
  username: "inherit-2061",
  full_name: "Inherit Twenty Sixty-One",
  p2paddr: CREATOR_ADDRESS,
};

type Sent = { method: string; body: Record<string, unknown> };

/** What the read route answers: `override` undefined = an older backend. */
function article(override: string | null | undefined) {
  return {
    id: 2061,
    free2zaddr: ARTICLE_ID,
    vanity: ARTICLE_ID,
    title: "An article that pays whatever my profile says",
    description: "",
    canonical_url: "",
    content: "Body.",
    tags: [],
    category: "",
    is_published: true,
    is_subscriber_only: false,
    publish_at: null,
    p2paddr: override || CREATOR_ADDRESS,
    ...(override === undefined ? {} : { p2paddr_override: override }),
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

async function openAndSave(page: Page, override: string | null | undefined) {
  const writes: Sent[] = [];

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
      if (pathname === `/api/zpage/${ARTICLE_ID}/`) {
        if (method === "GET") {
          await route.fulfill({ json: article(override) });
          return;
        }
        const body = JSON.parse(request.postData() || "{}");
        writes.push({ method, body });
        // The read representation, computed the way the API does.
        const stored = (body.p2paddr as string) || null;
        await route.fulfill({
          json: {
            ...article(override === undefined ? undefined : stored),
            ...body,
            p2paddr: stored || CREATOR_ADDRESS,
          },
          headers: { ETag: `"rev-${writes.length}"` },
        });
        return;
      }
      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  await page.goto(`/edit?id=${ARTICLE_ID}`);
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible({ timeout: 30_000 });
  await expect(body).toHaveValue("Body.");

  // An edit that has nothing to do with the address.
  await body.fill("Body. And one more sentence.");
  await expect.poll(() => writes.length, { timeout: 15_000 }).toBe(1);
  return writes;
}

test("opening and saving an inheriting article leaves it inheriting", async ({
  page,
}) => {
  const writes = await openAndSave(page, null);
  expect(writes[0].body.content).toBe("Body. And one more sentence.");
  // The read said p2paddr = CREATOR_ADDRESS; the page never had its own.
  expect(writes[0].body.p2paddr).toBe("");
});

test("an article's own address survives the round trip", async ({ page }) => {
  const writes = await openAndSave(page, PAGE_ADDRESS);
  expect(writes[0].body.p2paddr).toBe(PAGE_ADDRESS);
});

test("against a backend without p2paddr_override, the creator's own address reads as inherited", async ({
  page,
}) => {
  // Rolling deploy: a new bundle against an older pod. The classic editor's
  // rule -- an effective address equal to the creator's is not an override.
  const writes = await openAndSave(page, undefined);
  expect(writes[0].body.p2paddr).toBe("");
});
