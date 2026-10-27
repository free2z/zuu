import { expect, test, type Page } from "@playwright/test";

// The one thing the unit suite cannot prove about this feature: that the URL
// which actually reaches the article body after a promotion is the one the
// SERVER returned.
//
// `GenericFile._get_prefix()` derives the URL from the access level, so a
// private file lives at `/uploadz/…` and the same file, once public, lives at
// `/uploadz/public/…`. The wiring can be entirely correct in the source and
// still insert the pre-promotion URL — the markdown is built several frames
// and one component boundary away from the PATCH — and the result is exactly
// the broken image the gate exists to prevent, now with a successful write
// behind it. So this spec drives the real flow and reads the textarea.
//
// Everything else about the rule (which tier satisfies which slot, least
// privilege on a subscribers-only page, what a refused PATCH does) is pure
// logic and is pinned in tests/editor-media-access.test.mjs, which costs
// milliseconds instead of a browser.

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

const TEST_CREATOR = {
  id: 4243,
  username: "media-gate-user",
  full_name: "Media Gate User",
};

const PRIVATE_IMAGE = {
  id: 909,
  title: "Sunset",
  name: "sunset.png",
  mime_type: "image/png",
  access: "private",
  url: "/uploadz/sunset.png",
  thumbnail: "/uploadz/sunset.webp",
};

const PROMOTED_IMAGE = {
  ...PRIVATE_IMAGE,
  access: "public",
  url: "/uploadz/public/sunset.png",
  thumbnail: "/uploadz/public/sunset.webp",
};

type Patch = { url: string; method: string; body: unknown };

async function installApiMocks(page: Page, patches: Patch[]) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    // Vite serves source modules from paths such as /src/lib/api/config.ts.
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    if (pathname === "/api/auth/user/") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(TEST_CREATOR),
      });
      return;
    }

    if (pathname === `/api/myuploads/${PRIVATE_IMAGE.id}/`) {
      patches.push({
        url: pathname,
        method: request.method(),
        body: JSON.parse(request.postData() ?? "null"),
      });
      // The GET is the pre-write re-read: it answers with the file as it still
      // stands, which is what makes the PATCH necessary. The PATCH answers
      // with the WHOLE re-serialized record, at its new prefix — that is what
      // the client has to use.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          request.method() === "GET" ? PRIVATE_IMAGE : PROMOTED_IMAGE,
        ),
      });
      return;
    }

    if (pathname === "/api/myuploads/") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          count: 1,
          next: null,
          results: [PRIVATE_IMAGE],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, results: [] }),
    });
  });
}

/**
 * `/edit`, with one retry.
 *
 * This spec is the first in the suite to open the image picker, which pulls in
 * a set of modules nothing else here loads. The dev server the suite runs
 * against re-optimizes its dependency graph the first time that happens, and
 * the very next navigation — in a fresh context, so a reload is the only
 * recovery — comes back as a 200 with an EMPTY `<body>` and no client
 * bootstrap. It is a Vite artifact, not the application: the load after that
 * is fine, and a `page.reload()` fixes it immediately. Measured here, not
 * guessed: the test straight after the first picker run failed every time and
 * the one after it always passed.
 */
async function gotoEditor(page: Page) {
  const body = page.locator("textarea.writing-area-textarea");
  await page.goto("/edit");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await expect(body).toBeVisible({ timeout: 5_000 });
      return body;
    } catch {
      await page.reload();
    }
  }

  await expect(body).toBeVisible();
  return body;
}

async function openCloudTab(page: Page, patches: Patch[]) {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installApiMocks(page, patches);

  const body = await gotoEditor(page);

  await page.getByTestId("editor-insert-trigger").click();
  await page.locator("#editor-command-menu").getByText("Image").first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Your Cloud" }).click();

  return { body, dialog };
}

test("a private upload is listed, labelled, and refused until the creator says yes", async ({
  page,
}) => {
  const patches: Patch[] = [];
  const { body, dialog } = await openCloudTab(page, patches);

  // Listed, not filtered away — the creator can see the file they are looking
  // for and is told why it is a problem.
  const card = dialog.getByRole("button", { name: /Sunset/ });
  await expect(card).toBeVisible();
  await expect(dialog.locator('[data-media-access="private"]')).toHaveText(
    "Private",
  );

  await card.click();

  const gate = dialog.locator('[data-media-access-gate="public"]');
  await expect(gate).toBeVisible();
  await expect(gate).toContainText("Sunset");

  const writes = () => patches.filter((call) => call.method !== "GET");

  // Nothing has been WRITTEN, and nothing is in the article. The read that
  // decided the gate is expected; a write is not.
  expect(writes()).toHaveLength(0);
  await expect(body).toHaveValue("");

  await gate.locator('[data-media-access-gate-action="cancel"]').click();
  await expect(gate).toHaveCount(0);
  expect(writes()).toHaveLength(0);
  await expect(body).toHaveValue("");
  // Cancelling returns them to the library, not out of the picker.
  await expect(card).toBeVisible();
});

test("confirming promotes the file and inserts the SERVER's new URL", async ({
  page,
}) => {
  const patches: Patch[] = [];
  const { body, dialog } = await openCloudTab(page, patches);

  await dialog.getByRole("button", { name: /Sunset/ }).click();
  await dialog.locator('[data-media-access-gate-action="promote"]').click();

  await expect(dialog).toHaveCount(0);

  // Two reads and exactly one write, in that order. The reads are what keep a
  // picker holding a stale snapshot from downgrading a file somebody already
  // made public in another tab: one before the gate is raised, one immediately
  // before the write — the human's decision time sits between them.
  expect(patches.map((call) => call.method)).toEqual(["GET", "GET", "PATCH"]);
  expect(patches.at(-1)).toEqual({
    url: `/api/myuploads/${PRIVATE_IMAGE.id}/`,
    method: "PATCH",
    body: { access: "public" },
  });

  const markdown = await body.inputValue();
  // The whole point. `/uploadz/sunset.png` is where the file was BEFORE the
  // PATCH; serving it from there now 404s/401s for every reader.
  expect(markdown).toContain(PROMOTED_IMAGE.url);
  expect(markdown).not.toContain(`(${PRIVATE_IMAGE.url})`);
});
