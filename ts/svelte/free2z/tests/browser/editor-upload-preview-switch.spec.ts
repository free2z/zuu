import { expect, test, type Page } from "@playwright/test";

// A cold Vite server transforms the full /edit graph on its first navigation.
// Give that boot enough room without spending the whole test's time budget on
// the first visibility assertion.
test.setTimeout(120_000);

/**
 * An inline image upload must survive a Write -> Preview switch.
 *
 * `/edit` mounts the composer under `{#if mode === "write" || mode ===
 * "split"}`, so switching to Preview DESTROYS `EditorContentField` while the
 * creator is still very much on the page. Since the upload-limit work the send
 * waits on `GET /api/uploads/limits/` first, which opens a real window — and on
 * the editor page that window is on the FIRST drop of every session, because
 * nothing there warms the limit cache.
 *
 * A guard that reads the content field's own lifecycle treats that switch as
 * "the creator left", abandons the upload, and — worse — leaves the
 * `![Uploading image…](token)` placeholder behind, because
 * `stripUploadPlaceholders` in `+page.svelte` only cleans the outgoing PAYLOAD.
 * The creator gets a saved article with no image and a ghost in local state.
 *
 * This is the sequence no unit test can reach: it needs a real component
 * teardown between the request and its answer. Everything else about the
 * upload limit is covered in `tests/upload-size-limit.test.mjs`.
 */

const TEST_CREATOR = {
  id: 7311,
  username: "preview-switch-user",
  full_name: "Preview Switch User",
};

const UPLOADED_URL = "/uploadz/public/preview-switch-user/dropped.png";

/** A 1x1 PNG. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function installMocks(page: Page) {
  // ORDER MATTERS: Playwright tries the most recently registered matching
  // handler first, so the catch-all goes down FIRST and the specific routes
  // after it. Registered the other way round, `**/api/**` swallows the limits
  // request and the hold below never happens.
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;

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

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, results: [] }),
    });
  });

  const uploadRequests: string[] = [];
  await page.route("**/uploads/single-public", async (route) => {
    uploadRequests.push(route.request().method());
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ id: 99, url: UPLOADED_URL }),
    });
  });

  // Held until the test releases it, so the Preview switch lands exactly
  // inside the awaited limit read.
  let markRequested = () => {};
  const limitsRequested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  let releaseLimits = () => {};
  const limitsReleased = new Promise<void>((resolve) => {
    releaseLimits = resolve;
  });

  await page.route("**/api/uploads/limits/", async (route) => {
    markRequested();
    await limitsReleased;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tuzis: 0,
        max_bytes: 5 * 1024 * 1024,
        tiers: [
          { min_tuzis: 0, max_bytes: 5 * 1024 * 1024 },
          { min_tuzis: 1, max_bytes: 250 * 1024 * 1024 },
          { min_tuzis: 5000, max_bytes: 250 * 1024 * 1024 },
        ],
      }),
    });
  });

  return {
    limitsRequested,
    releaseLimits: () => releaseLimits(),
    uploadRequests,
  };
}

/** Drop one image file onto the body textarea, the way a creator would. */
async function dropImage(page: Page, base64: string) {
  await page.evaluate(async (data) => {
    const textarea = document.querySelector(
      "textarea.writing-area-textarea",
    ) as HTMLTextAreaElement | null;
    if (!textarea) throw new Error("no editor textarea");

    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const file = new File([bytes], "dropped.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);

    textarea.focus();
    textarea.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  }, base64);
}

test("an inline upload survives a Write -> Preview switch", async ({
  page,
}) => {
  const { limitsRequested, releaseLimits, uploadRequests } =
    await installMocks(page);

  await page.goto("/edit");
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible({ timeout: 30_000 });

  await dropImage(page, PNG_BASE64);

  // The placeholder is inserted synchronously, before the limit read resolves.
  await expect(body).toHaveValue(/Uploading image/);
  await limitsRequested;

  // ...and NOW the creator switches to Preview, destroying the content field
  // while its upload job is parked on that request.
  // `.last()`: each mode control is a Button inside a Tooltip.Trigger button,
  // so the outer wrapper derives the same accessible name from its content.
  await page.getByRole("button", { name: "Preview" }).last().click();
  await expect(body).toHaveCount(0);

  releaseLimits();

  // The upload must still happen.
  await expect.poll(() => uploadRequests.length, { timeout: 10_000 }).toBe(1);

  // Back to Write: the image landed and no ghost placeholder is stranded.
  await page.getByRole("button", { name: "Write" }).last().click();
  await expect(body).toBeVisible();
  await expect(body).toHaveValue(`![dropped](${UPLOADED_URL})`);
  await expect(body).not.toHaveValue(/Uploading image/);
});
