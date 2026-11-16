import { expect, test, type Page } from "@playwright/test";

const OWNER = "livefixture";
const OWNER_ID = 8811;
const WATCH = `/${OWNER}/subscribers-only`;
const VIEWER = {
  // Match the billing-fixture-session identity used by the real server loader.
  id: 4301,
  username: "fixtureowner",
  full_name: "Viewer",
  tuzis: "100.000",
};

async function fixture(
  page: Page,
  signedIn = true,
  member = false,
  holdAdmission = false,
  offline = false,
) {
  let authenticated = signedIn;
  let subscribed = member;
  let actor = VIEWER;
  let authStatus = 200;
  let creatorStatus = 200;
  let creatorId = OWNER_ID;
  let membershipKnown = true;
  let holdCreator = false;
  let releaseCreator: (() => void) | undefined;
  const joins: unknown[] = [];
  const purchases: { body: unknown; key: string | undefined }[] = [];
  let resolvePurchase: (() => void) | undefined;
  let holdPurchase = false;
  let unconfirmedPurchase = false;
  let releaseAdmission!: () => void;
  const admissionReady = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  if (signedIn)
    await page.context().addCookies([
      {
        name: "sessionid",
        value: "billing-fixture-session",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({
      status: authenticated ? authStatus : 401,
      json: authenticated
        ? {
            ...actor,
            ...(membershipKnown
              ? {
                  star_ids: subscribed ? [OWNER_ID] : [],
                  stars: subscribed ? [OWNER] : [],
                }
              : {}),
          }
        : { detail: "Not authenticated" },
    }),
  );
  await page.route("**/api/auth/login/", async (route) => {
    authenticated = true;
    await page.context().addCookies([
      {
        name: "sessionid",
        value: "billing-fixture-session",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    await route.fulfill({ json: { key: "synthetic-session" } });
  });
  await page.route(`**/api/creator/${OWNER}/`, async (route) => {
    if (holdCreator)
      await new Promise<void>((resolve) => {
        releaseCreator = resolve;
      });
    return route
      .fulfill({
        status: creatorStatus,
        json: {
          id: creatorId,
          username: OWNER,
          full_name: "Live Fixture Creator",
          member_price: "25",
          membership_benefits: [],
          avatar_image: null,
        },
      })
      .catch(() => {});
  });
  await page.route(`**/api/dyte/${OWNER}/live-status`, (route) =>
    route.fulfill({
      json: {
        is_live: !offline,
        participant_count: offline ? 0 : 1,
        streams: offline
          ? []
          : [{ type: "subscribers-only", participant_count: 1 }],
      },
    }),
  );
  await page.route(`**/api/dyte/${OWNER}/subscribers-only`, async (route) => {
    joins.push(route.request().postDataJSON());
    if (holdAdmission) await admissionReady;
    if (offline)
      return route.fulfill({ status: 404, json: { detail: "Not found" } });
    return route.fulfill(
      subscribed
        ? { json: { auth_token: "synthetic-viewer-token" } }
        : {
            status: 402,
            json: {
              code: "subscription_required",
              error: "You must be subscribed to join this meeting",
              action: "stream_join",
            },
          },
    );
  });
  await page.route(
    `**/api/tuzis/subscribe-confirmed/${OWNER}`,
    async (route) => {
      purchases.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"],
      });
      if (holdPurchase)
        await new Promise<void>((resolve) => {
          resolvePurchase = resolve;
        });
      if (unconfirmedPurchase)
        return route.fulfill({
          status: 409,
          json: { code: "request_in_progress" },
        });
      subscribed = true;
      await route
        .fulfill({ json: { success: true, replayed: false } })
        .catch(() => {});
    },
  );
  return {
    joins,
    purchases,
    releaseAdmission,
    failAuth: () => {
      authStatus = 503;
    },
    failCreator: () => {
      creatorStatus = 404;
    },
    replaceCreator: () => {
      creatorId = OWNER_ID + 1;
    },
    unknownMembership: () => {
      membershipKnown = false;
    },
    holdCreator: () => {
      holdCreator = true;
    },
    creatorHeld: () => Boolean(releaseCreator),
    releaseCreator: () => releaseCreator?.(),
    resetActor: () => {
      actor = VIEWER;
    },
    setActorUsername: (username: string) => {
      actor = { ...actor, username };
    },
    unconfirmed: () => {
      unconfirmedPurchase = true;
    },
    setMembership: (active: boolean) => {
      subscribed = active;
    },
    hold: () => {
      holdPurchase = true;
    },
    release: () => resolvePurchase?.(),
    changeActor: () => {
      actor = { ...VIEWER, id: 8107, username: "other-viewer" };
    },
  };
}

async function installSyntheticSdk(page: Page) {
  await page.evaluate(async () => {
    const source = await (await fetch("/src/lib/utils/rtk-manager.ts")).text();
    const sdkPath = source.match(
      /from \"([^\"]*cloudflare_realtimekit[^\"]*)\"/,
    )?.[1];
    if (!sdkPath) throw new Error("Shipping manager SDK import not found");
    const { default: SDK } = await import(sdkPath);
    (window as any).subscriberSdk = { init: 0, join: 0, defaults: null };
    SDK.init = async (options: any) => {
      (window as any).subscriberSdk.init++;
      (window as any).subscriberSdk.defaults = options.defaults;
      return {
        meta: {},
        self: { roomJoined: false, on: () => {}, off: () => {} },
        participants: {
          on: () => {},
          off: () => {},
          joined: { on: () => {}, off: () => {}, toArray: () => [] },
        },
        join: async () => {
          (window as any).subscriberSdk.join++;
        },
        leave: async () => {},
      };
    };
  });
}

async function navigate(page: Page, path: string) {
  await page.evaluate(async (path) => {
    const module =
      "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
    await (await import(module)).goto(path);
  }, path);
}

async function openSubscription(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Subscribers-only stream" }),
  ).toBeVisible();
  const button = page.getByRole("button", {
    name: `Subscribe to ${OWNER}`,
    exact: true,
  });
  await expect(button).toBeInViewport();
  await button.click();
  const confirm = page
    .getByRole("dialog")
    .getByRole("button", { name: /Subscribe for/ });
  await expect(confirm).toContainText("25");
  await expect(confirm).toBeInViewport();
  return confirm;
}

test("mobile offline subscriber entry offers one confirmed membership and stays honestly offline", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const state = await fixture(page, false, false, false, true);
  await page.goto(WATCH);
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(WATCH)}`);
  const login = page.getByRole("dialog");
  await login.locator("#username").fill(VIEWER.username);
  await login.locator("#password").fill("fixture-password");
  await login.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(WATCH);
  await expect.poll(() => state.joins.length).toBe(1);
  await installSyntheticSdk(page);
  const subscribe = page.getByRole("button", {
    name: `Subscribe to ${OWNER}`,
    exact: true,
  });
  await expect(subscribe).toBeInViewport();
  await expect(
    page.getByText("This creator is not currently live.", { exact: true }),
  ).toBeInViewport();
  await expect(page.getByRole("heading", { name: /is live/i })).toHaveCount(0);
  await expect(page).not.toHaveTitle(/is live/i);
  await page.screenshot({
    path: testInfo.outputPath("offline-subscription-offer.png"),
  });
  await (await openSubscription(page)).click();
  await expect.poll(() => state.joins.length).toBe(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(subscribe).toHaveCount(0);
  await expect(
    page.getByText("This creator is not currently live.", { exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeInViewport();
  expect(state.purchases).toHaveLength(1);
  expect(state.purchases[0].body).toEqual({
    expected_price: "25",
    creator_id: OWNER_ID,
  });
  expect(state.purchases[0].key).toBeTruthy();
  expect(state.joins).toEqual([{ role: "viewer" }, { role: "viewer" }]);
  expect(await page.evaluate(() => (window as any).subscriberSdk)).toEqual({
    init: 0,
    join: 0,
    defaults: null,
  });
  await page.screenshot({ path: testInfo.outputPath("offline-member.png") });
});

test("an offline member sees the unavailable stream without another subscription offer", async ({
  page,
}) => {
  const state = await fixture(page, true, true, false, true);
  await page.goto(WATCH);
  await expect(
    page.getByText("This creator is not currently live.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: `Subscribe to ${OWNER}`, exact: true }),
  ).toHaveCount(0);
  expect(state.purchases).toEqual([]);
  expect(state.joins).toHaveLength(1);
});

test("offline creator verification cannot survive an account round trip", async ({
  page,
}) => {
  const state = await fixture(page, true, false, true, true);
  await page.goto(WATCH);
  await expect.poll(() => state.joins.length).toBe(1);
  state.holdCreator();
  state.releaseAdmission();
  await expect.poll(state.creatorHeld).toBe(true);
  for (const change of [state.changeActor, state.resetActor]) {
    change();
    await page.evaluate(async () => {
      const path = "/src/lib/stores/auth.ts";
      await (
        await import(path)
      ).authStore.checkAuth({ force: true, fresh: true, silent: true });
    });
  }
  state.releaseCreator();
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Subscribe to ${OWNER}`, exact: true }),
  ).toHaveCount(0);
  expect(state.purchases).toEqual([]);
});

test("a case-colliding username does not show another creator's management link", async ({
  page,
}) => {
  const state = await fixture(page, true, false, false, true);
  state.setActorUsername("LiVeFiXtUrE");
  await page.goto(WATCH);
  await expect(
    page.getByText("This creator is not currently live.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("owner-viewer-notice")).toHaveCount(0);
  expect(state.purchases).toEqual([]);
});

for (const boundary of [
  "auth-error",
  "creator-error",
  "creator-changed",
  "membership-unknown",
  "account-changed",
] as const) {
  test(`offline subscription prompt requires fresh matching identity: ${boundary}`, async ({
    page,
  }) => {
    const state = await fixture(page, true, false, true, true);
    await page.goto(WATCH);
    await expect.poll(() => state.joins.length).toBe(1);
    await installSyntheticSdk(page);
    if (boundary === "auth-error") state.failAuth();
    if (boundary === "creator-error") state.failCreator();
    if (boundary === "creator-changed") state.replaceCreator();
    if (boundary === "membership-unknown") state.unknownMembership();
    if (boundary === "account-changed") state.changeActor();
    state.releaseAdmission();
    await expect(
      page.getByRole("button", { name: "Try again", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Subscribe to ${OWNER}`, exact: true }),
    ).toHaveCount(0);
    expect(state.purchases).toEqual([]);
    expect(await page.evaluate(() => (window as any).subscriberSdk)).toEqual({
      init: 0,
      join: 0,
      defaults: null,
    });
  });
}

test("mobile login returns to the stream and one confirmed subscription joins automatically", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const state = await fixture(page, false);
  await page.goto(WATCH);
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(WATCH)}`);
  const login = page.getByRole("dialog");
  await expect(
    login.getByRole("button", { name: "Log in", exact: true }),
  ).toBeInViewport();
  await login.locator("#username").fill(VIEWER.username);
  await login.locator("#password").fill("fixture-password");
  await login.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(WATCH);
  await expect.poll(() => state.joins.length).toBe(1);
  await installSyntheticSdk(page);
  await (await openSubscription(page)).click();
  await expect.poll(() => state.joins.length).toBe(2);
  await expect
    .poll(() => page.evaluate(() => (window as any).subscriberSdk.join))
    .toBe(1);
  expect(state.purchases).toHaveLength(1);
  expect(state.purchases[0].body).toEqual({
    expected_price: "25",
    creator_id: OWNER_ID,
  });
  expect(state.purchases[0].key).toBeTruthy();
  expect(state.joins).toEqual([{ role: "viewer" }, { role: "viewer" }]);
  expect(
    await page.evaluate(() => (window as any).subscriberSdk.defaults),
  ).toEqual({ audio: false, video: false });
  await expect(
    page.getByRole("heading", { name: "Unable to Join" }),
  ).toHaveCount(0);
});

test("an existing member joins without a subscription request", async ({
  page,
}) => {
  const state = await fixture(page, true, true, true);
  // Direct entry lets SvelteKit finish its initial load. Hold only the
  // admission response so the SDK fixture is installed before the token arrives.
  await page.goto(WATCH);
  await expect.poll(() => state.joins.length).toBe(1);
  await installSyntheticSdk(page);
  state.releaseAdmission();
  await expect
    .poll(() => page.evaluate(() => (window as any).subscriberSdk.join))
    .toBe(1);
  expect(state.joins).toEqual([{ role: "viewer" }]);
  expect(state.purchases).toEqual([]);
});

for (const outcome of [
  "active",
  "expired",
  "pending",
  "account-changed",
] as const) {
  test(`subscription recovery continues only for current active membership: ${outcome}`, async ({
    page,
  }) => {
    const state = await fixture(page);
    state.unconfirmed();
    let releaseRecovery!: () => void;
    const recoveryReady = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const recoveries: unknown[] = [];
    await page.route(
      `**/api/tuzis/subscribe-recovery/${OWNER_ID}`,
      async (route) => {
        recoveries.push(route.request().postDataJSON());
        if (outcome === "account-changed") await recoveryReady;
        state.setMembership(
          outcome === "active" || outcome === "account-changed",
        );
        await route.fulfill({
          json: { status: outcome === "pending" ? "unchanged" : "resolved" },
        });
      },
    );
    await page.goto(WATCH);
    await expect.poll(() => state.joins.length).toBe(1);
    await installSyntheticSdk(page);
    await (await openSubscription(page)).click();
    const recoveryButton = page.getByRole("button", {
      name: "Resolve previous attempt",
    });
    await recoveryButton.click();
    await expect.poll(() => recoveries.length).toBe(1);
    expect(recoveries[0]).toEqual({
      key: state.purchases[0].key,
      username: OWNER,
      expected_price: "25",
    });
    if (outcome === "account-changed") {
      state.changeActor();
      await page.evaluate(async () => {
        const path = "/src/lib/stores/auth.ts";
        await (
          await import(path)
        ).authStore.checkAuth({ force: true, fresh: true, silent: true });
      });
      releaseRecovery();
      await expect(recoveryButton).toBeEnabled();
    } else if (outcome === "active") {
      await expect.poll(() => state.joins.length).toBe(2);
      await expect
        .poll(() => page.evaluate(() => (window as any).subscriberSdk.join))
        .toBe(1);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } else if (outcome === "expired") {
      await expect(
        page.getByRole("dialog").getByRole("button", { name: /Subscribe for/ }),
      ).toBeEnabled();
    } else {
      await expect(page.getByTestId("payment-outcome-error")).toContainText(
        "previous attempt is still pending",
      );
    }
    if (outcome !== "active") {
      expect(state.joins).toHaveLength(1);
      expect(
        await page.evaluate(() => (window as any).subscriberSdk.join),
      ).toBe(0);
    }
    expect(state.purchases).toHaveLength(1);
  });
}

test("navigation started during initial load tolerates an unset source URL", async ({
  page,
}) => {
  await fixture(page);
  let releaseInitial!: () => void;
  let initialRequested!: () => void;
  const initialReady = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const initialRequest = new Promise<void>((resolve) => {
    initialRequested = resolve;
  });
  await page.route("**/src/routes/+page.svelte*", async (route) => {
    initialRequested();
    await initialReady;
    await route.continue();
  });
  let releaseDestination!: () => void;
  let destinationRequested!: () => void;
  const destinationReady = new Promise<void>((resolve) => {
    releaseDestination = resolve;
  });
  const destinationRequest = new Promise<void>((resolve) => {
    destinationRequested = resolve;
  });
  await page.route(`**${WATCH}/__data.json*`, async (route) => {
    destinationRequested();
    await destinationReady;
    await route.continue();
  });
  const hydratedAuth = page.waitForResponse("**/api/auth/user/");
  await page.goto("/", { waitUntil: "commit" });
  await initialRequest;
  // Capture the source while SvelteKit has no initialized page. Finish
  // hydration before the destination loads, so the real layout callback runs
  // with that captured null URL instead of starting a second application root.
  const navigation = navigate(page, WATCH);
  await destinationRequest;
  releaseInitial();
  await hydratedAuth;
  releaseDestination();
  await navigation;
  await expect(page).toHaveURL(WATCH);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Subscribers-only stream" }),
  ).toBeVisible();
});

for (const boundary of ["account", "route"] as const) {
  test(`a late subscription success cannot join after the ${boundary} changes`, async ({
    page,
  }) => {
    const state = await fixture(page);
    state.hold();
    await page.goto(WATCH);
    await expect.poll(() => state.joins.length).toBe(1);
    await installSyntheticSdk(page);
    await (await openSubscription(page)).click();
    await expect.poll(() => state.purchases.length).toBe(1);
    if (boundary === "account") {
      state.changeActor();
      await page.evaluate(async () => {
        const path = "/src/lib/stores/auth.ts";
        await (
          await import(path)
        ).authStore.checkAuth({ force: true, fresh: true, silent: true });
      });
    } else {
      await navigate(page, "/search");
    }
    state.release();
    await page.waitForTimeout(500);
    expect(state.joins).toHaveLength(1);
    expect(await page.evaluate(() => (window as any).subscriberSdk.join)).toBe(
      0,
    );
  });
}
