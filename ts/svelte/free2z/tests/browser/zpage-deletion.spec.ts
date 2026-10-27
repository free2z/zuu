import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { browserMockApiOrigin } from "./ports";

const SESSION = "zpage-delete-fixture-session";
const USER = "zpagedeletefixture";
const URL = `/${USER}/dashboard/pages`;
const MOCK_API_ORIGIN = browserMockApiOrigin();
const TITLES = [
  "Delete fixture draft",
  "Delete fixture scheduled draft",
  "Delete fixture published page",
];
const IDS = [
  "zpage-delete-draft",
  "zpage-delete-scheduled",
  "zpage-delete-published",
];
const PAGE2_TITLE = "Delete fixture page 2 last item";
const PAGE2_ID = "zpage-delete-page2-last";

test.setTimeout(60_000);

async function authenticate(page: Page) {
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: "sessionid", value: SESSION, domain: "127.0.0.1", path: "/" },
    {
      name: "csrftoken",
      value: "zpage-delete-csrf",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
}

async function resetFixture(request: APIRequestContext, mode = "normal") {
  await request.post(`${MOCK_API_ORIGIN}/__zpage-delete/reset?mode=${mode}`);
}

type RecordedRequest = {
  method: string;
  path: string;
  ifMatch: string | null;
};

async function recordedDeletes(request: APIRequestContext, id: string) {
  const requests: RecordedRequest[] = await request
    .get(`${MOCK_API_ORIGIN}/__requests`)
    .then((response) => response.json());
  return requests.filter(
    (entry) => entry.method === "DELETE" && entry.path.includes(id),
  );
}

/** Open the delete dialog for row `index` and wait for its validator read. */
async function openDeleteDialog(page: Page, index: number) {
  const validatorRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new globalThis.URL(response.url()).pathname ===
        `/api/zpage/${IDS[index]}/`,
  );
  await page.getByRole("button", { name: "Delete page" }).nth(index).click();
  await expect(page.getByRole("dialog")).toContainText(TITLES[index]);
  return validatorRead;
}

async function openPages(page: Page, url = URL) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('[data-dashboard-pages-hydrated="true"]').waitFor();
}

test.beforeEach(async ({ page, request }) => {
  await resetFixture(request);
  await request.delete(`${MOCK_API_ORIGIN}/__requests`);
  await authenticate(page);
});

test("delete controls are available in card/list layouts on mobile and cancel is inert", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPages(page);

  const deleteButtons = page.getByRole("button", { name: "Delete page" });
  await expect(deleteButtons).toHaveCount(3);
  await deleteButtons.nth(0).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText(
    "canonical page and all of its translations",
  );
  await expect(page.getByRole("dialog")).toContainText("Delete fixture draft");
  await page.keyboard.press("Escape");
  await expect(deleteButtons).toHaveCount(3);
  await expect(deleteButtons.nth(0)).toBeFocused();

  await page.getByRole("button", { name: "List view" }).click();
  await expect(page.getByRole("button", { name: "Delete page" })).toHaveCount(
    3,
  );
  await page.getByRole("button", { name: "Delete page" }).nth(2).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText(
    "removed from public access",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(TITLES[2], { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete page" }).nth(2),
  ).toBeFocused();
});

for (const [index, title] of TITLES.entries()) {
  test(`creator can delete ${index === 0 ? "a draft" : index === 1 ? "a scheduled draft" : "a published page"}`, async ({
    page,
    request,
  }) => {
    await openPages(page);
    await openDeleteDialog(page, index);
    await page.getByRole("button", { name: "Delete permanently" }).click();

    await expect(
      page.getByRole("link", { name: new RegExp(title) }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete page" })).toHaveCount(
      2,
    );

    // Conditional on the version the dialog was opened against.
    const deletes = await recordedDeletes(request, IDS[index]);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].ifMatch).toBe(`"${IDS[index]}-v1"`);
  });
}

test("failed deletion keeps the page visible and gives an actionable error", async ({
  page,
  request,
}) => {
  await resetFixture(request, "failure");
  await openPages(page);
  await page.getByRole("button", { name: "Delete page" }).first().click();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  await expect(page.getByRole("alert")).toContainText("was not deleted");
  await expect(
    page.getByRole("link", { name: new RegExp(TITLES[0]) }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("a save while the dialog is open makes the delete a 412 that preserves the page", async ({
  page,
  request,
}) => {
  //the mock answers 412 ONLY to a stale `If-Match`, as Django does. A
  // dashboard that sends no validator deletes the page here and fails.
  await openPages(page);
  await openDeleteDialog(page, 2);
  // Another tab saves the article while the creator reads the warning.
  await request.post(`${MOCK_API_ORIGIN}/__zpage-delete/touch?id=${IDS[2]}`);
  await page.getByRole("button", { name: "Delete permanently" }).click();

  await expect(page.getByRole("alert")).toContainText("nothing was deleted");
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: new RegExp(TITLES[2]) }),
  ).toBeVisible();
  const deletes = await recordedDeletes(request, IDS[2]);
  expect(deletes).toHaveLength(1);
  expect(deletes[0].ifMatch).toBe(`"${IDS[2]}-v1"`);

  // Reload re-reads the list; the page is still there and deletes cleanly
  // against the newer version.
  await page.getByRole("button", { name: "Reload" }).click();
  await page.locator('[data-dashboard-pages-hydrated="true"]').waitFor();
  await openDeleteDialog(page, 2);
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(
    page.getByRole("link", { name: new RegExp(TITLES[2]) }),
  ).toHaveCount(0);
  const retried = await recordedDeletes(request, IDS[2]);
  expect(retried).toHaveLength(2);
  expect(retried[1].ifMatch).toBe(`"${IDS[2]}-v2"`);
});

test("confirming waits for the validator read: a version saved after the click is never authorized", async ({
  page,
  request,
}) => {
  // codex review of: a read still in flight when the creator confirms
  // can return a version saved AFTER they consented. So nothing may be
  // confirmed until the read has answered.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === `/api/zpage/${IDS[2]}/`,
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await held;
      await route.fallback();
    },
  );
  await openPages(page);
  await page.getByRole("button", { name: "Delete page" }).nth(2).click();
  const confirm = page.getByRole("button", { name: "Delete permanently" });
  await expect(confirm).toBeDisabled();
  await expect(confirm).toHaveAttribute("aria-busy", "true");
  await confirm.click({ force: true });
  expect(await recordedDeletes(request, IDS[2])).toHaveLength(0);

  release();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(
    page.getByRole("link", { name: new RegExp(TITLES[2]) }),
  ).toHaveCount(0);
  const deletes = await recordedDeletes(request, IDS[2]);
  expect(deletes).toHaveLength(1);
  expect(deletes[0].ifMatch).toBe(`"${IDS[2]}-v1"`);
});

test("a failed validator read deletes nothing until a retry succeeds", async ({
  page,
  request,
}) => {
  // Falling back to an unconditional DELETE when the read fails would switch
  // the protection off exactly when the backend is unhealthy (codex review).
  let reads = 0;
  await page.route(
    (url) => url.pathname === `/api/zpage/${IDS[2]}/`,
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      reads += 1;
      if (reads === 1) {
        await route.fulfill({ status: 503, json: { detail: "rolling" } });
        return;
      }
      await route.fallback();
    },
  );
  await openPages(page);
  await page.getByRole("button", { name: "Delete page" }).nth(2).click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not check this page's current version",
  );
  const confirm = page.getByRole("button", { name: "Delete permanently" });
  await expect(confirm).toBeDisabled();
  await confirm.click({ force: true });
  expect(await recordedDeletes(request, IDS[2])).toHaveLength(0);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(confirm).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await confirm.click();
  await expect(
    page.getByRole("link", { name: new RegExp(TITLES[2]) }),
  ).toHaveCount(0);
  const deletes = await recordedDeletes(request, IDS[2]);
  expect(deletes).toHaveLength(1);
  expect(deletes[0].ifMatch).toBe(`"${IDS[2]}-v1"`);
});

test("deleting the last row on a later page navigates back without restoring it", async ({
  page,
  request,
}) => {
  await resetFixture(request, "page2");
  await openPages(page, `${URL}?page=2`);

  await expect(page.getByText(PAGE2_TITLE)).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous" })).toBeEnabled();
  await page.getByRole("button", { name: "Delete page" }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  await expect(page).toHaveURL(/\/dashboard\/pages\?page=1$/);
  await expect(
    page.getByRole("link", { name: new RegExp(PAGE2_TITLE) }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Delete fixture page 1 item 1", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete page" })).toHaveCount(
    12,
  );
  await expect(page.getByRole("button", { name: "Previous" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);

  const requests = await request
    .get(`${MOCK_API_ORIGIN}/__requests`)
    .then((response) => response.json());
  expect(
    requests.some(
      (entry: { method: string; path: string }) =>
        entry.method === "DELETE" && entry.path.includes(PAGE2_ID),
    ),
  ).toBe(true);
});

test("a page protected by payment records shows the server's refusal, not a retry hint", async ({
  page,
  request,
}) => {
  await resetFixture(request, "protected");
  await openPages(page);
  await page.getByRole("button", { name: "Delete page" }).nth(2).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("cannot be deleted");
  await expect(alert).not.toContainText("Check your connection");
  await expect(page.getByRole("button", { name: "Reload" })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: new RegExp(TITLES[2]) }),
  ).toBeVisible();
});

test("deleting on a full first page pulls the next page's row forward and keeps totals honest", async ({
  page,
  request,
}) => {
  // 13 pages: 12 on page 1, one on page 2. Deleting one row on page 1 leaves
  // 12, so pagination disappears -- the row from page 2 must therefore be
  // shown here, or it is unreachable until a reload.
  await resetFixture(request, "page2");
  await openPages(page);

  await expect(
    page.getByRole("link", { name: new RegExp(PAGE2_TITLE) }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
  await page.getByRole("button", { name: "Delete page" }).first().click();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  await expect(
    page.getByText("Delete fixture page 1 item 1", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(PAGE2_TITLE)).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete page" })).toHaveCount(
    12,
  );
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);
});

// --- The editor's delete  ---------------------------------------------
//
// The editor has always passed the validator from its own load, but nothing
// pinned it: these run against the same mock, whose DELETE answers 412 only
// to a stale `If-Match`.

async function openEditor(page: Page, id: string) {
  await page.goto(`/edit?id=${encodeURIComponent(id)}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator("textarea.writing-area-textarea")).toHaveValue(
    "Deletion fixture content",
    { timeout: 30_000 },
  );
}

test("the editor's delete is conditional on the version it loaded", async ({
  page,
  request,
}) => {
  await openEditor(page, IDS[0]);
  await page.getByRole("button", { name: "Delete page" }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  await expect(page).toHaveURL(new RegExp(`/${USER}/dashboard/pages$`));
  await expect(page.getByText(TITLES[0], { exact: true })).toHaveCount(0);
  const deletes = await recordedDeletes(request, IDS[0]);
  expect(deletes).toHaveLength(1);
  expect(deletes[0].ifMatch).toBe(`"${IDS[0]}-v1"`);
});

test("the editor's delete after a save elsewhere is a 412 that keeps the page", async ({
  page,
  request,
}) => {
  await openEditor(page, IDS[0]);
  // Another tab saves the article after this editor loaded it.
  await request.post(`${MOCK_API_ORIGIN}/__zpage-delete/touch?id=${IDS[0]}`);
  await page.getByRole("button", { name: "Delete page" }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  await expect(page.getByText("nothing was deleted")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(page).toHaveURL(/\/edit\?id=/);
  const deletes = await recordedDeletes(request, IDS[0]);
  expect(deletes).toHaveLength(1);
  expect(deletes[0].ifMatch).toBe(`"${IDS[0]}-v1"`);

  // Still there: the dashboard lists it.
  await openPages(page);
  await expect(page.getByText(TITLES[0], { exact: true })).toBeVisible();
});
