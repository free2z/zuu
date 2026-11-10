import { expect, test, type Page, type Request } from "@playwright/test";
import { devSourceModuleLoader } from "./dev-source-module";

//  -- one broadcast at a time. The server owns the rule (a broadcaster
// seat per creator, 409 `already_live_elsewhere` for anyone else); these pin
// the page's side of it: a second tab says so and offers a deliberate
// take-over instead of silently starting a shadow broadcast, a sibling tab in
// the same browser is recognised without waiting on the server, and the
// creator's own public page only ever asks to join as a viewer.
//
// No spec here reaches RealtimeKit: every start is answered by a route stub
// that either refuses (409) or fails (503), so the assertions are about what
// the page ASKED the server for, which is the contract that matters.

const SESSION = "stream-audience-owner-session";
const USER = "streamaudienceowner";
const STREAM_URL = `/${USER}/dashboard/stream`;
const SEAT_PATH = `/api/dyte/${USER}/host-session`;
const LIVE_STREAM_STORE_LOADER = devSourceModuleLoader(
  "/src/lib/stores/liveStreamStore.ts",
);

async function authenticate(page: Page, session = SESSION) {
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([
      { name: "sessionid", value: session, domain: "127.0.0.1", path: "/" },
    ]);
}

function seatStatus(page: Page, status: Record<string, unknown>) {
  return page.route(`**${SEAT_PATH}`, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        host_session: null,
        meeting_type: null,
        last_seen_at: null,
        ttl_seconds: 60,
        ...status,
      }),
    });
  });
}

/** Record every start/join POST and answer it with `reply`. */
async function captureStarts(
  page: Page,
  type: string,
  reply: { status: number; body: unknown },
) {
  const bodies: Record<string, unknown>[] = [];
  await page.route(`**/api/dyte/${USER}/${type}`, (route) => {
    const request: Request = route.request();
    if (request.method() !== "POST") return route.fallback();
    bodies.push(request.postDataJSON() ?? {});
    return route.fulfill({
      status: reply.status,
      contentType: "application/json",
      body: JSON.stringify(reply.body),
    });
  });
  return bodies;
}

async function openDashboard(page: Page, language = "en") {
  const hydratedAuth = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/auth/user/",
  );
  await page.goto(`${STREAM_URL}?lang=${language}`);
  expect((await hydratedAuth).status()).toBe(200);
  await expect(page.getByTestId("stream-audience-grid")).toBeVisible();
}

for (const [language, expected] of [
  [
    "en",
    "Your account no longer meets the requirements to start a stream. Refresh your balance and try again.",
  ],
  [
    "es",
    "Tu cuenta ya no cumple los requisitos para iniciar una transmisión. Actualiza tu saldo e inténtalo de nuevo.",
  ],
]) {
  test(`host eligibility changes are shown safely in ${language}`, async ({
    page,
  }) => {
    await seatStatus(page, { active: false });
    const starts: Record<string, unknown>[] = [];
    await page.route(`**/api/dyte/${USER}/subscribers-only`, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      starts.push(route.request().postDataJSON() ?? {});
      return route.fulfill({
        status: 400,
        contentType: "text/plain",
        body: "You need at least 150 to go live!",
      });
    });

    await openDashboard(page, language);
    await page.locator('label[for="stream-audience-subscribers-only"]').click();
    await page.getByTestId("stream-start").click();

    await expect.poll(() => starts.length).toBe(1);
    expect(starts[0]).toMatchObject({ role: "host" });
    await expect(page.getByText(expected, { exact: true })).toBeVisible();
    await expect(
      page.getByText("You need at least 150 to go live!"),
    ).toHaveCount(0);
    await expect(page.getByText("Failed to start the stream.")).toHaveCount(0);
    await expect(page.locator("rtk-meeting")).toHaveCount(0);
  });
}

test("known host maintenance failures are actionable and safe to retry", async ({
  page,
}) => {
  await seatStatus(page, { active: false });
  const starts: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route(`**/api/dyte/${USER}/broadcast`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    starts.push(route.request().postDataJSON() ?? {});
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "provider_unavailable",
        retryable: true,
        failure: {
          stage: "create_room",
          code: "transport_error",
          provider_status: 503,
          request_id: "f63f2b7e2a1e4bb0a092de91c8ac7bd4",
        },
        error: "provider detail and credentials must not be exposed",
      }),
    });
  });

  await openDashboard(page);
  await page.getByTestId("stream-start").click();
  await expect(
    page.getByText(
      "Stream startup is temporarily unavailable. Please try again shortly.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByTestId("stream-start")).toBeEnabled();
  await page.getByTestId("stream-start").click();
  await expect.poll(() => starts.length).toBe(2);
  expect(starts[0].host_session).toBe(starts[1].host_session);
  await expect.poll(() => warnings.length).toBeGreaterThanOrEqual(2);
  expect(warnings.join("\n")).toContain(
    "code: provider_unavailable, status: 503, request_id: f63f2b7e2a1e4bb0a092de91c8ac7bd4",
  );
  expect(warnings.join("\n")).not.toContain("credentials");
  expect(errors.join("\n")).not.toContain("API request failed");
  await expect(
    page.getByText("provider detail and credentials must not be exposed"),
  ).toHaveCount(0);
  await expect(page.locator("rtk-meeting")).toHaveCount(0);
});

test("an unrelated 400 is treated as invalid settings, not lost eligibility", async ({
  page,
}) => {
  await seatStatus(page, { active: false });
  let posted: Record<string, unknown> | null = null;
  await page.route(`**/api/dyte/${USER}/ppv`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posted = route.request().postDataJSON() ?? {};
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        code: "invalid_price",
        error: "Price must be positive",
      }),
    });
  });

  await openDashboard(page);
  await page.locator('label[for="stream-audience-ppv"]').click();
  await page.getByTestId("stream-start").click();

  await expect.poll(() => posted).not.toBeNull();
  expect(posted).toMatchObject({ role: "host", price_per_minute: "1" });
  await expect(
    page.getByText("Check the stream settings and try again.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/no longer meets the requirements/i)).toHaveCount(
    0,
  );
  await expect(page.getByText("Price must be positive")).toHaveCount(0);
});

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test("a second tab is told it is live elsewhere and can take over deliberately", async ({
  page,
}) => {
  await seatStatus(page, {
    active: true,
    host_session: "11111111-1111-4111-8111-111111111111",
    meeting_type: "ppv",
    last_seen_at: new Date().toISOString(),
  });
  const starts = await captureStarts(page, "ppv", {
    status: 503,
    body: "provider down",
  });

  await openDashboard(page);

  const panel = page.getByTestId("stream-seat-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-seat-state", "elsewhere");
  await expect(
    panel.getByRole("heading", {
      name: "You're already live in another tab or device",
    }),
  ).toBeVisible();
  await expect(panel).toContainText("Your Pay Per View stream");
  // No Go live button while another tab holds the seat: the only way on air
  // from here is the deliberate take-over.
  await expect(page.getByTestId("stream-start")).toHaveCount(0);
  expect(starts).toHaveLength(0);

  // Selecting Private first must not turn "Take over here" into a new
  // private room (codex review): the take-over continues the LIVE stream.
  await page.locator('label[for="stream-audience-private"]').click();
  await expect(
    page.getByRole("radio", { name: "Private", checked: true }),
  ).toHaveCount(1);

  await panel.getByTestId("stream-seat-takeover").click();

  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ role: "host", takeover: true });
  expect(String(starts[0].host_session)).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  // The take-over continued the LIVE stream's type (ppv), not the card this
  // tab had selected by default (broadcast).
  await expect(
    page.getByRole("radio", { name: "Pay Per View", checked: true }),
  ).toHaveCount(1);
});

test("a start the server refuses shows the live-elsewhere state, not a duplicate", async ({
  page,
}) => {
  await seatStatus(page, { active: false });
  const starts = await captureStarts(page, "broadcast", {
    status: 409,
    body: {
      code: "already_live_elsewhere",
      error: "You are already live in another tab or on another device.",
      meeting_type: "broadcast",
      last_seen_at: new Date().toISOString(),
    },
  });

  await openDashboard(page);
  const start = page.getByTestId("stream-start");
  await expect(start).toBeEnabled();
  await start.click();

  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toMatchObject({ role: "host" });
  expect(starts[0].takeover).toBeUndefined();
  const panel = page.getByTestId("stream-seat-panel");
  await expect(panel).toHaveAttribute("data-seat-state", "elsewhere");
  await expect(panel).toContainText("Your Broadcast stream");
  await expect(page.locator("rtk-meeting")).toHaveCount(0);
});

test("a live sibling tab in the same browser is recognised at once", async ({
  page,
}) => {
  // The server has not seen the sibling yet; the BroadcastChannel has.
  await seatStatus(page, { active: false });
  await openDashboard(page);
  await expect(page.getByTestId("stream-start")).toBeEnabled();

  const sibling = await page.context().newPage();
  await sibling.goto("/robots.txt");
  await sibling.evaluate((user) => {
    const channel = new BroadcastChannel(`f2z:host-seat:${user}`);
    channel.postMessage({
      kind: "live",
      session: "sibling-tab",
      meetingType: "subscribers-only",
    });
    channel.close();
  }, USER);

  const panel = page.getByTestId("stream-seat-panel");
  await expect(panel).toHaveAttribute("data-seat-state", "elsewhere");
  await expect(panel).toContainText("Your Subscribers stream");
  await sibling.close();
});

test("the creator's own public stream page joins as a viewer, never a host", async ({
  page,
}) => {
  const OWNER = "livefixture";
  // Sign the browser in as the stream's own creator: a real session for the
  // cookie, with the username swapped to the page's creator.
  await authenticate(page, "profile-fixture-session");
  await page.route("**/api/auth/user/", async (route) => {
    const response = await route.fetch();
    const user = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({ ...user, username: OWNER }),
    });
  });
  const joins: Record<string, unknown>[] = [];
  await page.route(`**/api/dyte/${OWNER}/broadcast`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    joins.push(route.request().postDataJSON() ?? {});
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify("Not Live"),
    });
  });

  await page.goto(`/${OWNER}/broadcast?lang=en`);

  await expect.poll(() => joins.length).toBeGreaterThan(0);
  for (const body of joins) {
    expect(body).toEqual({ role: "viewer" });
  }
  await expect(page.getByTestId("owner-viewer-notice")).toBeVisible();
  await expect(page.getByTestId("owner-viewer-notice")).toHaveAttribute(
    "href",
    `/${OWNER}/dashboard/stream`,
  );
});

test("public recovery observes disconnected state without an error and connected cancels stale retry", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const owner = "recoveryfixture";
  let joins = 0;
  await page.route(`**/api/dyte/${owner}/broadcast`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    joins++;
    return route.fulfill({ status: 503, body: "temporary provider outage" });
  });
  await page.route(`**/api/dyte/${owner}/live-status`, (route) =>
    route.fulfill({ json: { is_live: false, streams: [] } }),
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(`/${owner}/broadcast?lang=en`);
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.waitForTimeout(1_000);
    }
  }
  await expect.poll(() => joins).toBe(1);

  const store = async (status: "connected" | "disconnected") =>
    page.evaluate(
      async ({ next, loader }) => {
        const { liveStreamStore } = await new Function(loader)();
        liveStreamStore.setError(null);
        liveStreamStore.setConnectionStatus(next);
      },
      { next: status, loader: LIVE_STREAM_STORE_LOADER },
    );

  await store("connected");
  await page.waitForTimeout(2_000);
  expect(joins).toBe(1);

  await store("disconnected");
  await page.waitForTimeout(22_000);
  await expect.poll(() => joins).toBe(2);
});
