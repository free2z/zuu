import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * An upload that fails must say so — on screen, naming the file and its size,
 * with the spinner stopped (RCA ).
 *
 * For 19 days every upload over 1 MiB got an nginx 500 while the body was
 * still streaming. The browser never settled the request, so Settings showed
 * "Saving…" forever with no error: 57 failures, nobody reported one. The unit
 * tests (`tests/upload-request.test.mjs`) drive the transport against a fake
 * XHR; this drives the real page against a server that NEVER answers, which
 * is the one thing a unit test cannot show — that the error reaches the DOM.
 *
 * Settings is the surface the owner found the outage on. The mock API is the
 * shared fixture (`mock-api.mjs`); only the upload and the limit are routed
 * here.
 */

// Fixture literals are duplicated in tests/browser/mock-api.mjs; keep in sync.
const SESSION = "billing-fixture-session";
const USER = "fixtureowner";
const SETTINGS_URL = `/${USER}/dashboard/settings`;

const MB = 1024 * 1024;
/** Kept in sync with UPLOAD_RESPONSE_TIMEOUT_MS in uploadRequest.ts. */
const LONGEST_BOUND_MS = 610_000;

function limitPayload(maxBytes: number) {
  return {
    tuzis: 0,
    max_bytes: maxBytes,
    tiers: [
      { min_tuzis: 0, max_bytes: maxBytes },
      { min_tuzis: 1, max_bytes: 250 * MB },
    ],
  };
}

async function openSettings(page: Page, limitBytes = 5 * MB) {
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([
      { name: "sessionid", value: SESSION, domain: "127.0.0.1", path: "/" },
    ]);
  await page.route("**/api/uploads/limits/", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(limitPayload(limitBytes)),
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SETTINGS_URL);
  // The button is server-rendered before its handler exists; clicking a
  // pre-hydration button is a no-op and looks exactly like the bug.
  await page.waitForLoadState("networkidle");
}

async function pickAvatar(page: Page, bytes: number) {
  // A real PNG header on an incident-sized body: 1.7 MB is the owner's avatar
  // from the RCA. Only the MIME type is checked client-side.
  const header = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const buffer = Buffer.concat([header, Buffer.alloc(bytes - header.length)]);
  await page.getByLabel("Upload avatar").setInputFiles({
    name: "my-avatar.png",
    mimeType: "image/png",
    buffer,
  });
}

test("an upload the server never answers ends in a visible error", async ({
  page,
}) => {
  // Fake timers so the stall bound elapses in milliseconds, not minutes. The
  // clock still flows on its own after install; runFor only jumps it.
  await page.clock.install();
  await openSettings(page);
  await pickAvatar(page, 1.7 * MB);

  // The  server: takes the request and never says a word.
  let markRequested = () => {};
  const uploadRequested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const held: Route[] = [];
  await page.route("**/uploads/single-public", (route) => {
    held.push(route);
    markRequested();
  });

  const save = page.getByTestId("settings-save-mobile");
  await save.click();
  await uploadRequested;
  await expect(save).toBeDisabled();
  await expect(save).toContainText("Saving");

  // Past both bounds: the stall window while bytes go up and the longer
  // response window once they have. Before  no timer existed to fire.
  await page.clock.runFor(LONGEST_BOUND_MS + 1_000);

  const error = page.getByTestId("settings-save-error");
  await expect(error).toBeVisible({ timeout: 5_000 });
  await expect(error).toHaveAttribute("role", "alert");
  // Which file, how big, and what to do — not "Failed to save settings."
  await expect(error).toContainText("my-avatar.png");
  await expect(error).toContainText("1.7 MB");
  await expect(error).toContainText("stopped uploading");
  //...and the spinner is gone: the button is usable again.
  await expect(save).toBeEnabled();
  await expect(save).toContainText("Save Changes");
  expect(held).toHaveLength(1);
});

test("nginx's bodiless 403 is explained, not shrugged at", async ({ page }) => {
  await openSettings(page);
  await pickAvatar(page, 1.7 * MB);

  // `@deny_upload`: `return 403`, no body at all.
  await page.route("**/uploads/single-public", (route) =>
    route.fulfill({ status: 403, body: "" }),
  );

  await page.getByTestId("settings-save-mobile").click();
  const error = page.getByTestId("settings-save-error");
  await expect(error).toBeVisible();
  // The re-read limit (5 MB) says the file fit, so it is not a quota story.
  await expect(error).toContainText("my-avatar.png (1.7 MB) was refused");
  await expect(error).toContainText("signed out");
});

test("a file over the server's limit is refused before a byte goes up", async ({
  page,
}) => {
  await openSettings(page, 1 * MB);

  let uploads = 0;
  await page.route("**/uploads/single-public", (route) => {
    uploads += 1;
    return route.fulfill({ status: 500, body: "" });
  });

  // Refused the moment it is picked, against the server's limit rather than
  // a hardcoded 5 MB  — before Save is even pressed.
  await pickAvatar(page, 1.7 * MB);
  const error = page.getByTestId("settings-save-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText(
    "my-avatar.png is 1.7 MB — your upload limit is 1 MB.",
  );
  await expect(error).toContainText("Hold 1 2Z");

  // The refused file was not kept: saving now never tries to upload it.
  await page.getByTestId("settings-save-mobile").click();
  await expect(page.getByTestId("settings-save-success")).toBeVisible();
  expect(uploads, "the pre-check must stop the request").toBe(0);
});
