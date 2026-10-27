import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * A save the server never answers ends — visibly — and the editor recovers
 *.
 *
 * Before the bound, `apiFetch` handed `fetch` no signal: a save that never
 * settled left `isSaving` true forever, so the topbar said "Saving..." with no
 * end, every autosave returned "in-flight", and Publish awaited the hung
 * promise. The unit tests (`tests/api-request-timeout.test.mjs`) prove the
 * bound fires; this proves the editor turns it into a visible state, that an
 * UPDATE is retried and goes through, and that a CREATE sent without an
 * Idempotency-Key is not blindly re-sent (it may have committed, and every
 * keyless POST mints a new page). The keyed create's safe retry is
 * editor-create-idempotency.spec.ts.
 */

// The first test after a cold `vite dev` start compiles the whole /edit
// module graph on demand; leave room for that boot.
test.setTimeout(120_000);

/** Kept in sync with API_WRITE_TIMEOUT_MS in src/lib/api/request-timeout.js. */
const WRITE_BOUND_MS = 30_000;
/** AUTOSAVE_DELAY in src/routes/edit/+page.svelte. */
const AUTOSAVE_DELAY_MS = 2_500;

const CREATOR = {
  id: 8120,
  username: "hung-save-user",
  full_name: "Hung Save User",
};

const TIMED_OUT =
  "The server did not answer in time. Your changes are still here — try saving again.";
const CREATE_TIMED_OUT =
  "The server did not answer in time, and this new page may have been created anyway.";

function savedPage(payload: Record<string, unknown>) {
  const language = (payload.source_language as string) || "en";
  return {
    id: 2046,
    free2zaddr: "hung-save-fixture",
    vanity: "hung-save-fixture",
    title: payload.title || "",
    description: "",
    canonical_url: "",
    content: payload.content || "",
    tags: [],
    p2paddr: "",
    featured_image: null,
    is_published: false,
    is_subscriber_only: false,
    publish_at: null,
    creator: CREATOR,
    source_language: language,
    actual_language: language,
    requested_language: language,
    available_languages: [language],
    variant_is_published: false,
    created_at: "2026-09-22T00:00:00Z",
    updated_at: "2026-09-22T00:00:00Z",
  };
}

/**
 * Assert `read()` STAYS at `expected` for a window of real time.
 *
 * An absence cannot be asserted at one instant: a duplicate POST is born
 * asynchronously (the CSRF await, then the network hop to the route), so a
 * synchronous check right after `clock.runFor` passes while the duplicate is
 * still in flight — which is exactly how this spec once stayed green with
 * the create latch removed. Sampling over a window that comfortably exceeds
 * that hop (a local route answers in milliseconds) makes the count itself
 * the failing assertion. Uses the test runner's clock, which `page.clock`
 * does not touch.
 */
async function expectHeld(
  read: () => number,
  expected: number,
  windowMs = 2_000,
  message = "value changed during the hold window",
) {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    expect(read(), message).toBe(expected);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(read(), message).toBe(expected);
}

/**
 * Route the editor's API. `hang(method, n)` decides whether the n-th request
 * (1-based) of that method to the save endpoint is held forever — the
 * server, which takes the request and never says a word.
 */
async function openEditor(
  page: Page,
  hang: (method: "POST" | "PUT", n: number) => boolean,
) {
  // Fake timers, so the 30 s bound elapses in milliseconds. The clock still
  // flows on its own after install; runFor only jumps it.
  await page.clock.install();

  const saves: { method: string; route: Route }[] = [];
  const counts = { POST: 0, PUT: 0 };

  // Predicate, not a "**/api/**" glob: Vite serves /src/lib/api/*.ts, which a
  // glob would also intercept (see editor-empty-draft-save-state.spec.ts).
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
        pathname === "/api/zpage/hung-save-fixture/" && method === "PUT";
      if (isCreate || isUpdate) {
        const verb = isCreate ? "POST" : "PUT";
        counts[verb] += 1;
        saves.push({ method: verb, route });
        if (hang(verb, counts[verb])) return;
        const payload = JSON.parse(request.postData() || "{}");
        await route.fulfill({
          status: isCreate ? 201 : 200,
          json: savedPage(payload),
        });
        return;
      }

      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  await page.goto("/edit");
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible({ timeout: 30_000 });
  const chip = page.locator('[role="status"][aria-live="polite"]');
  return { body, chip, saves, counts };
}

test("a hung autosave UPDATE times out visibly, then retries and saves", async ({
  page,
}) => {
  const { body, chip, counts } = await openEditor(
    page,
    (method, n) => method === "PUT" && n === 1,
  );

  // First the page is created normally.
  await page.locator("textarea").first().fill("A title");
  await body.fill("Words that must not be lost.");
  await page.clock.runFor(AUTOSAVE_DELAY_MS + 500);
  await expect.poll(() => counts.POST).toBe(1);
  await expect(chip).toContainText("Saved");

  // Then an edit's autosave PUT hangs.
  await body.fill("Words that must not be lost. More words.");
  await page.clock.runFor(AUTOSAVE_DELAY_MS + 500);
  await expect.poll(() => counts.PUT).toBe(1);
  await expect(chip).toContainText("Saving...");

  // Past the bound. Before  no timer existed to fire.
  await page.clock.runFor(WRITE_BOUND_MS + 500);

  const notice = page.locator('[role="status"]').filter({ hasText: TIMED_OUT });
  await expect(notice).toBeVisible({ timeout: 5_000 });
  await expect(chip).not.toContainText("Saving...");
  await expect(chip).toContainText("Failed to save article");
  // Publish is usable again: nothing is holding `isSaving`.
  await expect(page.getByRole("button", { name: "Publish" })).toBeEnabled();
  await expect(body).toHaveValue("Words that must not be lost. More words.");

  // The autosave retry (AUTOSAVE_DELAY * 2 ** 1) goes out and succeeds.
  await page.clock.runFor(AUTOSAVE_DELAY_MS * 2 + 500);
  await expect.poll(() => counts.PUT, { timeout: 10_000 }).toBe(2);
  await expect(chip).toContainText("Saved", { timeout: 10_000 });
  await expect(notice).toHaveCount(0);
  expect(counts.POST).toBe(1);
});

test("a hung CREATE without an Idempotency-Key times out visibly and is not re-sent on its own", async ({
  page,
}) => {
  //a create normally carries a key and is retried safely under it
  // (editor-create-idempotency.spec.ts). A browser that cannot mint one —
  // `randomUUID` exists only in a secure context — keeps this latch.
  await page.addInitScript(() => {
    delete (Crypto.prototype as { randomUUID?: unknown }).randomUUID;
  });
  const { body, chip, counts, saves } = await openEditor(
    page,
    (method, n) => method === "POST" && n === 1,
  );

  await page.locator("textarea").first().fill("A title");
  await body.fill("A brand-new page.");
  await page.clock.runFor(AUTOSAVE_DELAY_MS + 500);
  await expect.poll(() => counts.POST).toBe(1);
  await expect(chip).toContainText("Saving...");
  // The precondition of this test: the create really went out keyless.
  expect(
    await saves[0].route.request().headerValue("idempotency-key"),
  ).toBeNull();

  // A manual save queued BEHIND the hung create predates the warning, so it
  // must not become a second POST when the create times out.
  await page.keyboard.press("Control+s");

  await page.clock.runFor(WRITE_BOUND_MS + 500);

  // The queued Ctrl+S resumes the instant the create times out. Held over a
  // window BEFORE anything else is asserted, so this count is what fails if
  // the queued-save guard is removed.
  await expectHeld(
    () => counts.POST,
    1,
    2_000,
    "a save queued before the timeout re-sent the create",
  );

  const notice = page
    .locator('[role="status"]')
    .filter({ hasText: CREATE_TIMED_OUT });
  await expect(notice).toBeVisible({ timeout: 5_000 });
  await expect(chip).not.toContainText("Saving...");
  await expect(page.getByRole("button", { name: "Publish" })).toBeEnabled();

  // Well past every autosave retry, and after another edit: the first POST
  // may have committed, so autosave must not create a second page unasked.
  // Each clock jump is followed by a real-time hold, because a duplicate
  // would be scheduled by the jump but reach the route only afterwards.
  await page.clock.runFor(AUTOSAVE_DELAY_MS * 16);
  await expectHeld(
    () => counts.POST,
    1,
    2_000,
    "autosave retried a timed-out create",
  );
  await body.fill("A brand-new page, edited.");
  await page.clock.runFor(AUTOSAVE_DELAY_MS * 4);
  await expectHeld(
    () => counts.POST,
    1,
    2_000,
    "an edit after a timed-out create autosaved a second create",
  );
  await expect(notice).toBeVisible();

  // A save the creator asks for goes through.
  await page.keyboard.press("Control+s");
  await expect.poll(() => counts.POST, { timeout: 10_000 }).toBe(2);
  await expect(chip).toContainText("Saved", { timeout: 10_000 });
});

test("New post after a timed-out keyless create autosaves the new draft", async ({
  page,
}) => {
  // The create latch belongs to the draft whose create timed out: it stops
  // autosave from minting a duplicate of THAT draft. New post hydrates a
  // different document in the same mounted editor, and its first
  // create can duplicate nothing, so the latch must not follow it there.
  await page.addInitScript(() => {
    delete (Crypto.prototype as { randomUUID?: unknown }).randomUUID;
  });
  const { body, counts } = await openEditor(
    page,
    (method, n) => method === "POST" && n === 1,
  );
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  await page.locator("textarea").first().fill("A title");
  await body.fill("A brand-new page.");
  await page.clock.runFor(AUTOSAVE_DELAY_MS + 500);
  await expect.poll(() => counts.POST).toBe(1);
  await page.clock.runFor(WRITE_BOUND_MS + 500);
  await expect(
    page.locator('[role="status"]').filter({ hasText: CREATE_TIMED_OUT }),
  ).toBeVisible({ timeout: 5_000 });

  // The unsaved first draft is left only on the creator's say-so.
  await page.getByTestId("navbar-profile-trigger").click();
  await page.getByTestId("user-menu-new-post").click();
  await expect.poll(() => dialogs.length).toBe(1);
  await expect(body).toHaveValue("");

  await page.locator("textarea").first().fill("Second title");
  await body.fill("The second draft must autosave.");
  await page.clock.runFor(AUTOSAVE_DELAY_MS + 500);
  await expect
    .poll(() => counts.POST, {
      timeout: 10_000,
      message: "the new draft's autosave was held by the old draft's latch",
    })
    .toBe(2);
});
