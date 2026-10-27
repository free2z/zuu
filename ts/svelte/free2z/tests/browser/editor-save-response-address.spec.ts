import { expect, test } from "@playwright/test";

//a zPage write now answers with the READ representation, and a read's
// `p2paddr` is the EFFECTIVE support address -- the page's own, else the
// creator's. The editor must not copy that back into the address field: a
// creator who leaves it empty is asking to inherit their profile address, and
// adopting the effective value would pin a copy of it onto the article on the
// very next autosave, so a later profile-address change would silently stop
// reaching this article's supporters.

test.setTimeout(120_000);

const ARTICLE_ID = "address-inherit-fixture";
const CREATOR_ADDRESS = "u1creatorprofileaddressfixture";
const CREATOR = {
  id: 8248,
  username: "address-inherit-user",
  full_name: "Address Inherit User",
  p2paddr: CREATOR_ADDRESS,
};

type Write = { method: string; body: Record<string, unknown> };

test("an inherited support address stays inherited across saves", async ({
  page,
}) => {
  const writes: Write[] = [];

  function detail(body: Record<string, unknown>) {
    // The shape zPageDetailSerializer answers a write with since.
    return {
      id: 2048,
      free2zaddr: ARTICLE_ID,
      vanity: ARTICLE_ID,
      title: body.title || "",
      description: body.description || "",
      canonical_url: body.canonical_url || "",
      content: body.content || "",
      tags: body.tags || [],
      p2paddr: (body.p2paddr as string) || CREATOR_ADDRESS,
      featured_image: null,
      is_published: false,
      is_subscriber_only: false,
      publish_at: null,
      creator: CREATOR,
      source_language: "en",
      actual_language: "en",
      requested_language: "en",
      available_languages: ["en"],
      variant_is_published: false,
      created_at: "2026-09-22T00:00:00Z",
      updated_at: "2026-09-22T00:00:00Z",
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

      const isCreate = pathname === "/api/zpage/" && method === "POST";
      const isUpdate =
        pathname === `/api/zpage/${ARTICLE_ID}/` &&
        (method === "PUT" || method === "PATCH");
      if (isCreate || isUpdate) {
        const body = JSON.parse(request.postData() || "{}");
        writes.push({ method, body });
        await route.fulfill({
          status: isCreate ? 201 : 200,
          json: detail(body),
          headers: { ETag: `"rev-${writes.length}"` },
        });
        return;
      }

      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  await page.goto("/edit");
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible({ timeout: 30_000 });

  await page.locator("textarea").first().fill("Inherited address");
  await body.fill("The first paragraph.");
  await expect.poll(() => writes.length, { timeout: 15_000 }).toBe(1);
  expect(writes[0].method).toBe("POST");
  expect(writes[0].body.p2paddr).toBe("");

  await body.fill("The first paragraph. And a second one.");
  await expect.poll(() => writes.length, { timeout: 15_000 }).toBe(2);
  expect(writes[1].method).toBe("PUT");
  // The response said CREATOR_ADDRESS; the creator never typed it.
  expect(writes[1].body.p2paddr).toBe("");
});
