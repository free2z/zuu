import { expect, test, type Page } from "@playwright/test";

/**
 *a just-charged platform fee read "in 4 hours" on the notifications
 * page for a viewer in EDT. The events API sent `created_at` with no offset
 * ("2026-09-28 18:00:00") and the browser read that UTC wall-clock time as
 * LOCAL time. The browser here is pinned to America/New_York because under
 * UTC -- what CI runners default to -- the bug cannot be seen at all.
 *
 * Both wire formats are served: the legacy offset-less one (what production
 * sent until this fix, and what a cached or older backend could still send)
 * and the fixed ISO 8601 one with `Z`. Each must read as "now".
 */
test.use({ timezoneId: "America/New_York" });
test.describe.configure({ timeout: 90_000 });

const CREATOR = {
  id: 2285,
  username: "tz-fixture-user",
  full_name: "TZ Fixture User",
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** The pre-fix wire format: UTC wall-clock, no offset. */
function offsetlessUtc(date: Date) {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-` +
    `${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:` +
    `${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

function feeEvent(id: string, createdAt: string) {
  return {
    id,
    type: "PLATFORM_FEE",
    amount: 3,
    receiving_user: CREATOR,
    contributor: null,
    payee: null,
    message: "ignored by the client formatter",
    content_url: null,
    content_title: null,
    content_available: true,
    created_at: createdAt,
    read: false,
  };
}

async function installMocks(page: Page) {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "tz-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.addInitScript((creator) => {
    localStorage.setItem(
      "auth",
      JSON.stringify({
        status: "authenticated",
        isAuthenticated: true,
        creator,
        loading: false,
      }),
    );
  }, CREATOR);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (pathname === "/api/auth/user/") {
      await route.fulfill({ json: CREATOR });
      return;
    }
    if (pathname === "/api/events/has/") {
      await route.fulfill({ json: { has_events: true } });
      return;
    }
    if (pathname === "/api/events/unread_count/") {
      await route.fulfill({
        json: { unread_count: 2, recipient_username: CREATOR.username },
      });
      return;
    }
    if (pathname === "/api/events/" && request.method() === "GET") {
      // Stamped when the page asks, so "just charged" is literally true.
      const now = new Date();
      const events = [
        feeEvent("fee-offsetless", offsetlessUtc(now)),
        feeEvent("fee-iso", now.toISOString()),
      ];
      await route.fulfill({
        json: { count: events.length, next: null, results: events },
      });
      return;
    }
    await route.fulfill({ json: { count: 0, results: [], next: null } });
  });
}

test("a just-charged platform fee reads as now in EDT, never in the future", async ({
  page,
}) => {
  await installMocks(page);
  await page.goto(`/${CREATOR.username}/dashboard/notifications`, {
    waitUntil: "domcontentloaded",
  });

  // The browser really is west of UTC; otherwise this spec proves nothing.
  expect(
    await page.evaluate(() =>
      new Date("2026-09-28T12:00:00Z").getTimezoneOffset(),
    ),
  ).toBe(240);

  const fees = page.getByText("Platform fee: 3 2Z.");
  await expect(fees).toHaveCount(2, { timeout: 30_000 });

  const times = page.locator("time[datetime]");
  await expect(times).toHaveCount(2);
  for (const text of await times.allTextContents()) {
    expect(text.trim()).not.toMatch(/^in\b/i);
    expect(text.trim()).toMatch(/^(now|\d+ seconds? ago|1 minute ago)$/i);
  }
});
