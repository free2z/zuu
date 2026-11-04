import { expect, test, type Page, type Route } from "@playwright/test";

// The publication export dialog under a flaky backend.
//
// Before the fix the dialog polled with a bare setInterval and, on ANY failed
// status poll, cleared the interval and set nothing: "Generating your
// publication archive…" then spun forever, with the Start button hidden. One
// transient 502 — a rolling deploy draining pods mid-export — was enough. And
// the initial "latest export" lookup swallowed every error as "no export yet",
// so a 500 offered "Start export" over a job that might already be running.
//
// Every assertion here is POSITIVE on the new state (the completion message,
// the give-up message, the load-failed message) rather than on the absence of
// a spinner: an absence assertion passes on a page that failed to render.
//
// The backend is mocked per-test with page.route, and the clock is faked so
// the 2s/4s/8s/16s backoff runs in milliseconds.

// Fixture literals are duplicated in tests/browser/mock-api.mjs (the
// profile-dashboard session); keep in sync.
const FIXTURE_SESSION = "profile-fixture-session";
const FIXTURE_USER = "profilefixture";
const PAGES_URL = `/${FIXTURE_USER}/dashboard/pages`;

const JOB_ID = "8f3c2a8e-2051-4c1e-9d6b-0c9a1b2c3d4e";

function job(status: string) {
  return {
    id: JOB_ID,
    status,
    article_count: 12,
    asset_count: 3,
    file_size: 204800,
    file_name: "publication-export.zip",
    warnings: [],
    error_message: "",
    is_expired: false,
    created_at: "2026-09-22T00:00:00Z",
    started_at: "2026-09-22T00:00:01Z",
    finished_at: status === "ready" ? "2026-09-22T00:01:00Z" : null,
    expires_at: null,
  };
}

type Reply = { status: number; body?: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const fail = (status: number): Reply => ({
  status,
  body: { detail: `mock ${status}` },
});

/**
 * Route the two export endpoints from scripts. The last reply of each script
 * repeats forever. Returns live hit counters.
 */
async function mockExports(
  page: Page,
  scripts: { latest: Reply[]; detail?: Reply[] },
) {
  const hits = { latest: 0, detail: 0 };
  const take = (list: Reply[]) => (list.length > 1 ? list.shift()! : list[0]);
  await page.route(/\/api\/exports\/publications\//, async (route: Route) => {
    const url = new URL(route.request().url());
    let reply: Reply;
    if (/\/api\/exports\/publications\/?$/.test(url.pathname)) {
      hits.latest += 1;
      reply = take(scripts.latest);
    } else if (
      new RegExp(`/api/exports/publications/${JOB_ID}/?$`).test(url.pathname)
    ) {
      hits.detail += 1;
      reply = take(scripts.detail ?? [fail(500)]);
    } else {
      return route.fallback();
    }
    await route.fulfill({
      status: reply.status,
      contentType: "application/json",
      body: JSON.stringify(reply.body ?? {}),
    });
  });
  return hits;
}

async function openDialog(page: Page) {
  await page.goto(PAGES_URL);
  const trigger = page.getByRole("button", { name: "Export articles" });
  const dialog = page.getByRole("dialog");
  // The button is inert until hydration — and the first visit to this route
  // on a cold dev server compiles it — so retry the click until it opens.
  await expect(async () => {
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 45_000 });
  return dialog;
}

/** Advance the fake clock in steps until `check` passes. */
async function advanceUntil(
  page: Page,
  check: () => Promise<void>,
  timeout = 30_000,
) {
  await expect(async () => {
    await page.clock.runFor(1_000);
    await check();
  }).toPass({ timeout });
}

test.beforeEach(async ({ page }) => {
  // Room for a cold dev-server compile of the dashboard route (see openDialog).
  test.setTimeout(90_000);
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: "sessionid",
      value: FIXTURE_SESSION,
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.clock.install();
});

test("one failed status poll is retried and the finished export is shown", async ({
  page,
}) => {
  const hits = await mockExports(page, {
    latest: [ok(job("running"))],
    detail: [ok(job("running")), fail(502), ok(job("ready"))],
  });
  const dialog = await openDialog(page);
  await expect(
    dialog.getByText("Generating your publication archive…"),
  ).toBeVisible();

  // Gated on the completion message itself, not on the retry note: against
  // the unfixed dialog this is the assertion that has to fail.
  await advanceUntil(page, async () => {
    await expect(
      dialog.getByText("Your publication archive is ready."),
    ).toBeVisible({ timeout: 200 });
  });
  await expect(
    dialog.getByRole("button", { name: "Download archive" }),
  ).toBeVisible();
  expect(hits.detail).toBe(3);
});

test("persistent status-poll failure gives up with a visible, retryable error", async ({
  page,
}) => {
  const detail: Reply[] = [fail(502)];
  const hits = await mockExports(page, {
    latest: [ok(job("running"))],
    detail,
  });
  const dialog = await openDialog(page);

  // While it is still retrying it says so, and keeps the job in view.
  await advanceUntil(page, async () => {
    await expect(
      dialog.getByText("Having trouble reaching the server — retrying…"),
    ).toBeVisible({ timeout: 200 });
  });
  await expect(
    dialog.getByText("Generating your publication archive…"),
  ).toBeVisible();

  const gaveUp = dialog.getByRole("alert").filter({
    hasText: "Couldn't check your export's status. It may still be running.",
  });
  await advanceUntil(
    page,
    async () => {
      await expect(gaveUp).toBeVisible({ timeout: 200 });
    },
    60_000,
  );
  await expect(
    dialog.getByRole("button", { name: "Check again" }),
  ).toBeVisible();
  const pollsAtGiveUp = hits.detail;
  expect(pollsAtGiveUp).toBe(4);

  // Having given up, it stays given up: no more requests on its own.
  await page.clock.runFor(120_000);
  expect(hits.detail).toBe(pollsAtGiveUp);

  // "Check again" polls immediately and recovers once the backend does.
  detail.splice(0, detail.length, ok(job("ready")));
  await dialog.getByRole("button", { name: "Check again" }).click();
  await advanceUntil(page, async () => {
    await expect(
      dialog.getByText("Your publication archive is ready."),
    ).toBeVisible({ timeout: 200 });
  });
});

test("a backend error on first load is 'failed to load', not 'no export yet'", async ({
  page,
}) => {
  const latest: Reply[] = [fail(500)];
  await mockExports(page, { latest });
  const dialog = await openDialog(page);

  await expect(
    dialog.getByRole("alert").filter({
      hasText: "Couldn't load your export status.",
    }),
  ).toBeVisible();
  // We do not know whether a job is running, so we must not offer to start one.
  await expect(
    dialog.getByRole("button", { name: "Start export" }),
  ).toHaveCount(0);

  // Retrying against a backend that now answers 404 = genuinely no export yet.
  latest.splice(0, latest.length, fail(404));
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(
    dialog.getByRole("button", { name: "Start export" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Couldn't load your export status."),
  ).toHaveCount(0);
});

test("a first lookup that never answers shows 'failed to load' within its 15s bound", async ({
  page,
}) => {
  // The lookup request is held forever: a backend that stalls mid-deploy.
  let lookups = 0;
  await page.route(/\/api\/exports\/publications\/?$/, async () => {
    lookups += 1;
    // never fulfilled
  });
  const dialog = await openDialog(page);
  await expect.poll(() => lookups).toBeGreaterThan(0);
  await expect(dialog.getByText("Loading…")).toBeVisible();

  const loadFailed = dialog.getByRole("alert").filter({
    hasText: "Couldn't load your export status.",
  });
  // Just inside the bound it is still loading...
  await page.clock.runFor(14_000);
  await expect(loadFailed).toHaveCount(0);
  await expect(dialog.getByText("Loading…")).toBeVisible();
  //...and just past it, the error is shown (positively), with a way out.
  await page.clock.runFor(2_000);
  await expect(loadFailed).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Start export" }),
  ).toHaveCount(0);
});

test("a 404 on first load is 'no export yet' and offers Start export", async ({
  page,
}) => {
  await mockExports(page, { latest: [fail(404)] });
  const dialog = await openDialog(page);
  await expect(
    dialog.getByRole("button", { name: "Start export" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Couldn't load your export status."),
  ).toHaveCount(0);
});

test("a stale lookup that fails after close/reopen cannot hide the current export", async ({
  page,
}) => {
  // Lookup A is held until lookup B (after close + reopen) has answered;
  // then A fails. A must be ignored: it belongs to a dialog session that no
  // longer exists.
  let releaseA!: () => void;
  const aHeld = new Promise<void>((resolve) => (releaseA = resolve));
  let latestHits = 0;
  let staleDelivered = false;
  await page.route(/\/api\/exports\/publications\//, async (route: Route) => {
    const url = new URL(route.request().url());
    if (!/\/api\/exports\/publications\/?$/.test(url.pathname)) {
      return route.fallback();
    }
    latestHits += 1;
    if (latestHits === 1) {
      await aHeld;
      // Closing the dialog aborts this request, so the browser may already
      // have dropped it; either way the stale 502 must change nothing.
      await route
        .fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ detail: "mock 502" }),
        })
        .catch(() => {});
      staleDelivered = true;
      return;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(job("ready")),
    });
  });

  const dialog = await openDialog(page);
  await expect.poll(() => latestHits).toBe(1);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole("button", { name: "Export articles" }).click();
  await expect(
    dialog.getByText("Your publication archive is ready."),
  ).toBeVisible();

  // Now let the stale 502 land, and give it every chance to be applied.
  releaseA();
  await expect.poll(() => staleDelivered).toBe(true);
  await page.clock.runFor(5_000);
  await expect(
    dialog.getByRole("button", { name: "Download archive" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Couldn't load your export status."),
  ).toHaveCount(0);
});
