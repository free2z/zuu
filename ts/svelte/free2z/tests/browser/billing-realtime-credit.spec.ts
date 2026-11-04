import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { browserMockApiOrigin } from "./ports";
import {
  AUTH_STORE_LOADER,
  SONNER_LOADER,
  devSourceModuleLoader,
} from "./dev-source-module";

const TOAST_LOADER = devSourceModuleLoader("/src/lib/toast.ts");
const EVENT_NOTIFICATIONS_LOADER = devSourceModuleLoader(
  "/src/lib/stores/eventNotifications.ts",
);
const SVELTE_LOADER = devSourceModuleLoader("/tests/browser/svelte-runtime.ts");
const MEDIA_UPLOADER_LOADER = devSourceModuleLoader(
  "/src/lib/components/media/MediaUploader.svelte",
);

const creatorCoverChoices = {
  cover: [
    {
      id: "fixture-image-model",
      provider: "openai",
      model: "fixture-image-model",
      display_name: "Fixture image model",
      destination: "OpenAI",
      privacy_policy_url: "https://openai.com/policies/privacy-policy/",
      price_basis: "fixed",
      price_2z: 6,
      snapshot_token: "signed-fixture-image-snapshot",
      availability: "Configured; checked again at submission.",
      queue: "Processed synchronously; no queue position or SLA.",
    },
    {
      id: "fixture-alternate-model",
      provider: "xai",
      model: "fixture-alternate-model",
      display_name: "Alternate fixture model",
      destination: "xAI",
      privacy_policy_url: "https://x.ai/legal/privacy-policy",
      price_basis: "fixed",
      price_2z: 6,
      snapshot_token: "signed-fixture-alternate-snapshot",
      availability: "Configured; checked again at submission.",
      queue: "Processed synchronously; no queue position or SLA.",
    },
  ],
  completion: [],
};

async function routeCreatorCoverChoices(page: Page) {
  await page.route("**/api/ai/creator-options/", (route) =>
    route.fulfill({ json: creatorCoverChoices }),
  );
}

async function chooseAndAcceptCreatorCover(fixture: Locator) {
  const selector = fixture.getByLabel("Image model");
  await expect(selector).toBeEnabled();
  await selector.selectOption("fixture-image-model");
  await fixture.getByRole("checkbox").check();
}

// Let CI assign these independent cases to different shards. Each shard still
// uses one worker and its own mock API; before/afterEach reset every case.
test.describe.configure({ mode: "parallel" });

// The first navigation in a shard can pay Vite's cold SSR/client transform
// cost. Warm the billing route before any five-second functional assertions;
// the test cases still assert their own QR and account behavior.
test.beforeAll(async ({ browser }) => {
  test.setTimeout(60_000);
  await fetch(`${browserMockApiOrigin()}/__billing/reset`, {
    method: "POST",
  });
  const page = await browser.newPage();
  try {
    await page.context().addCookies([
      {
        name: "sessionid",
        value: "billing-fixture-session",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect(
      page.locator('main[data-zcash-auth-mounted="true"]'),
    ).toBeAttached({ timeout: 30_000 });
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await page.close();
  }
});

async function emit(
  page: Page,
  id: string,
  type: string,
  read = false,
  payment_reference?: {
    intent_id?: string;
    payment_id?: string;
    status: string;
  },
) {
  await page.evaluate(
    ({ id, type, read, payment_reference }) => {
      (window as any).purchaseSocket.onmessage({
        data: JSON.stringify({
          content: {
            id,
            type,
            read,
            payment_reference,
            amount: 2500,
            receiving_user: { username: "fixtureowner" },
            message:
              type === "ZEC_PENDING"
                ? "We can see your Zcash payment. About 2,500 2Z will be credited once it confirms."
                : "You bought 2,500 tuzi",
            created_at: new Date().toISOString(),
          },
        }),
      });
    },
    { id, type, read, payment_reference },
  );
}

function ownedUnreadCount(unreadCount: number) {
  return { unread_count: unreadCount, recipient_username: "fixtureowner" };
}

// Read authoritative identity before asserting account-owned controls. Cold
// hydration and a credential exchange are not settled by navigation alone.
async function billingInitialActorBarrier(page: Page, username: string) {
  // The page's mounted billing verifier owns the first forced auth check. Do
  // not start the initial observer until that request has been started.
  await expect(
    page.locator('main[data-zcash-auth-mounted="true"]'),
  ).toBeAttached({ timeout: 30_000 });
  // Join the page's current auth check instead of forcing a replacement: the
  // billing component's first verification owns QR readiness, and superseding
  // it can leave its generation stale even when this observer sees auth later.
  await expect
    .poll(
      () =>
        page.evaluate(async (loader) => {
          const { authStore } = await new Function(loader)();
          const accepted = await authStore.checkAuth({ silent: true });
          let actor: { status: string; username?: string } | undefined;
          authStore.subscribe((value: any) => {
            actor = { status: value.status, username: value.creator?.username };
          })();
          return { accepted, actor };
        }, AUTH_STORE_LOADER),
      { timeout: 15_000 },
    )
    .toEqual({
      accepted: true,
      actor: { status: "authenticated", username },
    });
}

// A server-side account transition must be confirmed by a new authoritative
// response. Cached state accepted by checkAuth({ silent: true }) is not proof
// that the new session reached the browser store.
async function billingFreshActorBarrier(page: Page, username: string) {
  await expect
    .poll(
      () =>
        page.evaluate(async (loader) => {
          const { authStore } = await new Function(loader)();
          const accepted = await authStore.checkAuth({
            force: true,
            fresh: true,
            silent: true,
          });
          let actor: { status: string; username?: string } | undefined;
          authStore.subscribe((value: any) => {
            actor = { status: value.status, username: value.creator?.username };
          })();
          return { accepted, actor };
        }, AUTH_STORE_LOADER),
      { timeout: 15_000 },
    )
    .toEqual({
      accepted: true,
      actor: { status: "authenticated", username },
    });
}

// Wait for the actual receipt scan, normal head/meta bodies, and subsequent
// auth body. Joining whichever check happens to be in flight is insufficient.
async function initialRecoveryBarrier(page: Page) {
  await page.addInitScript(() => {
    const native = window.fetch;
    let receipts = false;
    const normal = new Set<string>();
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.origin);
      const postHistory =
        url.pathname === "/api/auth/user/" && normal.size === 3;
      const response = await native(...args);
      if (response.ok && url.pathname.startsWith("/api/")) {
        await response
          .clone()
          .json()
          .catch(() => {});
        if (url.pathname === "/api/events/" && url.searchParams.has("recovery"))
          receipts = true;
        else if (
          receipts &&
          [
            "/api/events/",
            "/api/events/has/",
            "/api/events/unread_count/",
          ].includes(url.pathname)
        )
          normal.add(url.pathname);
        if (postHistory) (window as any).initialRecoverySettled = true;
      }
      return response;
    };
  });
}

test.beforeEach(async ({ page, request }) => {
  await request.post(`${browserMockApiOrigin()}/__billing/reset`);
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    class PurchaseSocket {
      onopen: any;
      onclose: any;
      onmessage: any;
      onerror: any;
      constructor() {
        (window as any).purchaseSocket = this;
        setTimeout(() => this.onopen?.({}), 0);
      }
      close() {}
      send(data: string) {
        const value = JSON.parse(data);
        if (value.type === "ping")
          this.onmessage?.({
            data: JSON.stringify({ type: "pong", id: value.id }),
          });
      }
    }
    window.WebSocket = new Proxy(Native, {
      construct(target, args) {
        return /\/ws\/profile(?:[/?#]|$)/.test(String(args[0]))
          ? new PurchaseSocket()
          : Reflect.construct(target, args);
      },
    });
  });
});

test.afterEach(async ({ request }) => {
  await request.post(`${browserMockApiOrigin()}/__billing/reset`);
});

test("legacy unread counts are retried without applying a count missing recipient provenance", async ({
  page,
}) => {
  test.setTimeout(30_000);
  let countRequests = 0;
  let releaseEnvelope!: () => void;
  const envelopeGate = new Promise<void>((resolve) => {
    releaseEnvelope = resolve;
  });
  let signalEnvelopeRequest!: () => void;
  const envelopeRequest = new Promise<void>((resolve) => {
    signalEnvelopeRequest = resolve;
  });

  await page.route("**/api/events/unread_count/**", async (route) => {
    countRequests += 1;
    if (countRequests <= 2) return route.fulfill({ json: 9 });
    signalEnvelopeRequest();
    await envelopeGate;
    return route.fulfill({ json: ownedUnreadCount(7) });
  });

  try {
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await billingInitialActorBarrier(page, "fixtureowner");
    await expect
      .poll(() => countRequests, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3);
    await envelopeRequest;

    const unreadBadge = page
      .getByTestId("navbar-notifications")
      .locator("span")
      .first();
    await expect(unreadBadge).toHaveCount(0);

    releaseEnvelope();
    await expect(unreadBadge).toHaveText("7");
  } finally {
    releaseEnvelope();
  }
});

test("receipt delivery shows one snackbar, keeps a normal notification, and refreshes every balance source", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000); // cold editor/billing compilation + deliberate persistence wait
  await initialRecoveryBarrier(page);
  let persistedUnread = 0;
  await page.route("**/api/events/unread_count/**", async (route) =>
    route.fulfill({ json: ownedUnreadCount(persistedUnread) }),
  );
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  // The request belongs to an authenticated account: wait for hydration before
  // checking the QR that its account-specific memo can then generate.
  await expect(
    page.getByRole("button", { name: "Profile", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as any).purchaseSocket?.onmessage)),
    )
    .toBe(true);
  await expect(page.getByTestId("billing-balance-value")).toHaveText(
    "64,672.23",
  );

  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as any).initialRecoverySettled)),
    )
    .toBe(true);

  const editedMaximum = page.locator('input[name="maxPrice"]').first();
  await editedMaximum.fill("50");
  const initialUnread = await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    let unread = 0;
    eventNotifications.subscribe(
      (value: any) => (unread = value.unreadCount),
    )();
    return unread;
  });
  persistedUnread++;
  await emit(page, "pending-note", "ZEC_PENDING");
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Your Zcash payment was detected." }),
  ).toHaveCount(1);
  await expect(page.getByTestId("billing-balance-value")).toHaveText(
    "64,672.23",
  );

  // Hold an auth response that began before settlement. The receipt must
  // start a fresh read instead of joining this request's stale result.
  let staleAuth: Route | undefined;
  let freshChecks = 0;
  let credited = false;
  await page.route("**/api/auth/user/", async (route) => {
    if (route.request().headers()["x-fixture-stale-auth"] === "true") {
      staleAuth = route;
      return;
    }
    if (!credited) return route.continue();
    if (++freshChecks === 1)
      return route.fulfill({
        status: 503,
        json: { detail: "Backend restarting" },
      });
    await route.continue();
  });
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts";
    const { authStore } = await import(module);
    const native = window.fetch;
    window.fetch = (input, init) =>
      native(input, {
        ...init,
        headers: { ...init?.headers, "x-fixture-stale-auth": "true" },
      });
    (window as any).staleAuthCheck = authStore.checkAuth({
      fresh: true,
      silent: true,
    });
    window.fetch = native;
  });
  await expect.poll(() => Boolean(staleAuth)).toBe(true);
  await request.post(
    `${browserMockApiOrigin()}/__billing/balance?amount=67172.234`,
  );
  persistedUnread++;
  credited = true;
  await emit(page, "credited-note", "BOUGHT_TUZI");
  await expect.poll(() => freshChecks).toBeGreaterThan(0);
  await emit(page, "credited-note", "BOUGHT_TUZI");
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Payment received — 2,500 2Z credited." }),
  ).toHaveCount(1);
  await expect(page.getByTestId("billing-balance-value")).toHaveText(
    "67,172.23",
  );
  await expect.poll(() => freshChecks).toBeGreaterThanOrEqual(2);
  await expect(editedMaximum).toHaveValue("50");
  await staleAuth!.fulfill({
    json: { id: 4301, username: "fixtureowner", tuzis: "64672.234" },
  });
  await page.evaluate(() => (window as any).staleAuthCheck);
  const state = await page.evaluate(async () => {
    // Vite module imports let this assertion inspect the auth-derived balances
    // used by donation, comment, and editor controls alongside the route tile.
    const authModule = "/src/lib/stores/auth.ts";
    const notificationsModule = "/src/lib/stores/eventNotifications.ts";
    const { authStore } = await import(authModule);
    const { eventNotifications } = await import(notificationsModule);
    let user: any, notifications: any;
    authStore.subscribe((value: any) => {
      user = value.creator;
    })();
    eventNotifications.subscribe((value: any) => {
      notifications = value;
    })();
    return {
      balance: user.tuzis,
      unread: notifications.unreadCount,
      ids: notifications.events.map((e: any) => e.id),
    };
  });
  expect(state.balance).toBe("67172.234");
  expect(state.unread).toBe(initialUnread + 2);
  expect(state.ids.filter((id: string) => id === "credited-note")).toHaveLength(
    1,
  );
  expect(state.ids).toContain("pending-note");

  // Back the delivered events with normal history responses too. Otherwise
  // the fixture's empty history erases them during the deferred feed refresh.
  await page.route(
    (url) => url.pathname === "/api/events/",
    async (route) =>
      route.fulfill({
        json: {
          count: 2,
          next: null,
          recovery_boundary: "mock-complete-receipt-scan",
          results: ["credited-note", "pending-note"].map((id) => ({
            id,
            type: id === "credited-note" ? "BOUGHT_TUZI" : "ZEC_PENDING",
            read: false,
            amount: 2500,
            receiving_user: { username: "fixtureowner" },
            created_at: new Date().toISOString(),
            message: "Payment notification",
          })),
        },
      }),
  );

  // A receipt marked read still carries new balance information, without a toast.
  await request.post(
    `${browserMockApiOrigin()}/__billing/balance?amount=69672.234`,
  );
  await emit(page, "read-receipt", "BOUGHT_TUZI", true);
  await expect(page.getByTestId("billing-balance-value")).toHaveText(
    "69,672.23",
  );
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Payment received — 2,500 2Z credited." }),
  ).toHaveCount(1);

  // Keep the pointer away from Sonner: hovering pauses its old four-second
  // expiry and would hide the regression this real-time check must catch.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(5_000);
  const receiptToast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Payment received — 2,500 2Z credited." });
  await expect(receiptToast).toBeVisible();
  const close = receiptToast.getByRole("button", {
    name: "Close notification",
  });
  await close.focus();
  await page.keyboard.press("Enter");
  await expect(receiptToast).toHaveCount(0);
  // Dismissing the transient presentation must leave the normal notification
  // and the freshly credited account balance intact.
  await expect(page.getByTestId("billing-balance-value")).toHaveText(
    "69,672.23",
  );
  expect(
    await page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      let ids: string[] = [];
      eventNotifications.subscribe((value: any) => {
        ids = value.events.map((event: any) => event.id);
      })();
      return ids;
    }),
  ).toContain("credited-note");
});

test("loading and promise notifications finish programmatically and routine outcomes fade", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await billingInitialActorBarrier(page, "fixtureowner");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(async (loader) => {
    const { toast } = await new Function(loader)();
    toast.loading("Preparing receipt", { id: "progress-fixture" });
  }, SONNER_LOADER);
  const progress = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Preparing receipt" });
  await expect(progress).toBeVisible();
  await expect(progress.getByRole("button")).toHaveCount(0);
  await page.evaluate(async (loader) => {
    const { toast } = await new Function(loader)();
    toast.success("Receipt prepared", { id: "progress-fixture" });
    toast.promise(
      new Promise<void>((resolve) => {
        (window as any).finishToastPromise = resolve;
      }),
      { loading: "Saving receipt", success: "Receipt saved" },
    );
  }, SONNER_LOADER);
  await expect(progress).toHaveCount(0);
  const prepared = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Receipt prepared" });
  await expect(prepared).toBeVisible();
  await prepared.getByRole("button", { name: "Close notification" }).click();
  const saved = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Receipt saved" });
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Saving receipt" }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).finishToastPromise());
  await expect(saved).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(saved).toHaveCount(0, { timeout: 8000 });
  await expect(prepared).toHaveCount(0);
  await page.evaluate(async (loader) => {
    const { toast } = await new Function(loader)();
    toast.dismiss("progress-fixture");
  }, SONNER_LOADER);
  await expect(prepared).toHaveCount(0);
});

test("billing QR waits beyond its five-second assertion budget for authoritative client auth", async ({
  page,
}) => {
  await page.clock.install();
  const heldAuthRoutes: Route[] = [];
  let releaseAuth = false;
  const apiPosts: string[] = [];
  await page.route("**/api/auth/user/", (route) => {
    if (releaseAuth) return route.continue();
    heldAuthRoutes.push(route);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") && request.method() === "POST")
      apiPosts.push(url.pathname);
  });

  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect.poll(() => heldAuthRoutes.length).toBeGreaterThan(0);
  await page.clock.pauseAt(new Date());
  const actorReadiness = billingInitialActorBarrier(page, "fixtureowner");
  const initialPrivateState = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter(
        (key) =>
          key.startsWith("f2z:intent:") || key.startsWith("f2z:donation"),
      )
      .sort(),
  );

  // This deliberately exceeds the unchanged five-second QR assertion budget:
  // navigation and SSR identity alone do not settle the browser auth store.
  // This is a Node-side delay: the browser clock is paused after the auth
  // request starts, so its real 8-second abort cannot beat the held response.
  await new Promise((resolve) => setTimeout(resolve, 5_100));
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async (loader) => {
        const { authStore } = await new Function(loader)();
        let state: any;
        authStore.subscribe((value: any) => (state = value))();
        return {
          status: state.status,
          username: state.creator?.username ?? null,
        };
      }, AUTH_STORE_LOADER),
    )
    .toEqual({ status: "unknown", username: null });
  expect(apiPosts).toEqual([]);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage)
        .filter(
          (key) =>
            key.startsWith("f2z:intent:") || key.startsWith("f2z:donation"),
        )
        .sort(),
    ),
  ).toEqual(initialPrivateState);

  releaseAuth = true;
  await Promise.all(heldAuthRoutes.splice(0).map((route) => route.continue()));
  await actorReadiness;
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  expect(apiPosts).toEqual([]);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage)
        .filter(
          (key) =>
            key.startsWith("f2z:intent:") || key.startsWith("f2z:donation"),
        )
        .sort(),
    ),
  ).toEqual(initialPrivateState);
});

for (const switchAccount of [false, true]) {
  test(`account notifications clear on ${switchAccount ? "account switch" : "logout"} including private progress`, async ({
    page,
  }) => {
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await billingInitialActorBarrier(page, "fixtureowner");
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => Boolean((window as any).purchaseSocket?.onmessage)),
      )
      .toBe(true);
    await emit(page, "logout-pending", "ZEC_PENDING");
    await emit(page, "logout-credit", "BOUGHT_TUZI");
    const accountToasts = page.locator("[data-sonner-toast]").filter({
      hasText: /Your Zcash payment was detected|Payment received/,
    });
    await expect(accountToasts).toHaveCount(2);
    await page.evaluate(async (loader) => {
      const { toast } = await new Function(loader)();
      toast.success("Private operation receipt: donated 25 2Z", {
        id: "private-operation-receipt",
      });
      toast.loading("Unrelated export in progress", {
        id: "unrelated-progress",
      });
    }, SONNER_LOADER);
    await page.route("**/api/auth/user/", (route) =>
      route.fulfill({
        status: switchAccount ? 200 : 401,
        json: switchAccount
          ? { id: 8124, username: "other-account", tuzis: "50.000" }
          : { detail: "Logged out" },
      }),
    );
    await page.evaluate(async () => {
      const module = "/src/lib/stores/auth.ts";
      const { authStore } = await import(module);
      await authStore.checkAuth({ force: true, fresh: true, silent: true });
    });
    await expect(accountToasts).toHaveCount(0);
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Private operation receipt: donated 25 2Z" }),
    ).toHaveCount(0);
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Unrelated export in progress" }),
    ).toHaveCount(0);
  });
}

test("explicitly persistent promise outcomes preserve their options without loading or after dismissed loading", async ({
  page,
}) => {
  test.setTimeout(60_000); // three manual-persistence intervals plus explicit finite duration
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(async (loader) => {
    const { toast } = await new Function(loader)();
    (window as any).promiseCallbacks = [];
    const callbacks = (name: string) => ({
      duration: Infinity,
      finally: () => (window as any).promiseCallbacks.push(name),
    });
    (window as any).noLoadingReturn = toast.promise(
      Promise.resolve("complete"),
      {
        id: "success-only",
        success: (value: string) => `Success-only ${value}`,
        ...callbacks("success"),
      },
    );
    toast.promise(Promise.reject(new Error("declined")), {
      id: "error-only",
      error: (error: Error) => `Error-only ${error.message}`,
      ...callbacks("error"),
    });
    const id = toast.promise(
      new Promise<void>((resolve) => {
        (window as any).finishDismissedLoading = resolve;
      }),
      {
        id: "dismissed-loading",
        loading: "Temporary progress",
        success: "Finished dismissed progress",
        ...callbacks("dismissed"),
      },
    );
    toast.dismiss(id);
    toast.promise(Promise.resolve(), {
      id: "finite-promise",
      success: "Explicitly timed outcome",
      duration: 1000,
    });
  }, SONNER_LOADER);

  await page.evaluate(() => (window as any).finishDismissedLoading());
  await page.mouse.move(0, 0);
  await page.waitForTimeout(5000);
  for (const message of [
    "Success-only complete",
    "Error-only declined",
    "Finished dismissed progress",
  ]) {
    const outcome = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: message });
    await expect(outcome).toBeVisible();
    await page.waitForTimeout(4500);
    await expect(outcome).toBeVisible();
    await outcome.getByRole("button", { name: "Close notification" }).click();
    await expect(outcome).toHaveCount(0);
  }
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Explicitly timed outcome" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).noLoadingReturn),
  ).toBeUndefined();
  expect(await page.evaluate(() => (window as any).promiseCallbacks)).toEqual([
    "success",
    "error",
    "dismissed",
  ]);
});

for (const bulk of [false, true]) {
  test(`a purchase updates the open ${bulk ? "bulk" : "single"} quote balance without changing quoted consent`, async ({
    page,
    request,
  }) => {
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const module = "/src/lib/stores/eventNotifications.ts";
          const { eventNotifications } = await import(module);
          let initialized = false;
          eventNotifications.subscribe(
            (state: any) => (initialized = state.initialized),
          )();
          return initialized;
        }),
      )
      .toBe(true);
    let held: Route | undefined;
    await page.route("**/api/auth/user/", async (route) => {
      if (!held) {
        held = route;
        return;
      }
      await route.continue();
    });
    await page.evaluate(async () => {
      const module = "/src/lib/stores/auth.ts";
      const { authStore } = await import(module);
      (window as any).oldQuoteAuthCheck = authStore.checkAuth({
        fresh: true,
        silent: true,
      });
    });
    await expect.poll(() => Boolean(held)).toBe(true);
    await request.post(
      `${browserMockApiOrigin()}/__billing/balance?amount=60000`,
    );
    await page.evaluate(async (bulk) => {
      const target = document.createElement("div");
      document.body.append(target);
      const svelteModule = "/tests/browser/svelte-runtime.ts";
      const fixtureModule =
        "/tests/browser/purchase-balance-dialog-fixture.svelte";
      const [{ mount }, { default: Fixture }] = await Promise.all([
        import(svelteModule),
        import(fixtureModule),
      ]);
      mount(Fixture, { target, props: { bulk } });
    }, bulk);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Balance 60000 2Z");
    await held!.fulfill({
      json: { id: 4301, username: "fixtureowner", tuzis: "100000" },
    });
    await page.evaluate(() => (window as any).oldQuoteAuthCheck);
    await expect(dialog).toContainText("Balance 60000 2Z");
    await page.evaluate(async () => {
      const module = "/src/lib/stores/auth.ts";
      const { authStore } = await import(module);
      authStore.setSubscription("metadata-only-update", true, 999);
    });
    await expect(dialog).toContainText("Balance 60000 2Z");
    const confirm = dialog.getByTestId(
      bulk ? "translate-into-confirm" : "translate-ai-confirm",
    );
    if (bulk) await expect(confirm).toBeDisabled();
    else await expect(confirm).toHaveCount(0);
    await request.post(
      `${browserMockApiOrigin()}/__billing/balance?amount=74672.234`,
    );
    await emit(page, `quote-credit-${bulk}`, "BOUGHT_TUZI");
    await expect(dialog).toContainText("Balance 74672.234 2Z");
    if (bulk) await expect(confirm).toBeDisabled();
    else await expect(confirm).toHaveCount(0);
    await dialog
      .getByRole("button", { name: "Refresh price and balance" })
      .click();
    await expect(confirm).toBeEnabled();
  });
}

test("credit refresh preserves text typed after the editor's last autosave", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  let reads = 0,
    writes = 0;
  let article = {
    id: 2046,
    free2zaddr: "event-draft",
    vanity: "event-draft",
    title: "Preserve my work",
    content: "Saved original",
    description: "",
    canonical_url: "",
    tags: [],
    p2paddr: "",
    featured_image: null,
    is_published: false,
    is_subscriber_only: false,
    publish_at: null,
    creator: { id: 4301, username: "fixtureowner" },
    source_language: "en",
    actual_language: "en",
    requested_language: "en",
    available_languages: ["en"],
    variant_is_published: false,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
  await page.route("**/api/zpage/event-draft/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/zpage/event-draft/")
      return route.fulfill({ json: { count: 0, results: [] } });
    if (route.request().method() === "GET") reads++;
    else {
      writes++;
      article = {
        ...article,
        ...route.request().postDataJSON(),
        updated_at: "2026-10-01T00:00:01Z",
      };
    }
    await route.fulfill({
      json: article,
      headers: { ETag: `"revision-${writes}"` },
    });
  });
  await page.goto("/edit?id=event-draft");
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible({ timeout: 60_000 });
  await body.fill("Autosaved revision");
  await expect.poll(() => writes, { timeout: 15_000 }).toBeGreaterThan(0);
  const initialReads = reads;
  await body.fill("Newest unsaved paragraph must survive receipt delivery");
  await request.post(
    `${browserMockApiOrigin()}/__billing/balance?amount=67172.234`,
  );
  await emit(page, "draft-credit", "BOUGHT_TUZI");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        const { authStore } = await import(module);
        let balance: any;
        authStore.subscribe((state: any) => (balance = state.creator?.tuzis))();
        return balance;
      }),
    )
    .toBe("67172.234");
  await expect(body).toHaveValue(
    "Newest unsaved paragraph must survive receipt delivery",
  );
  expect(reads).toBe(initialReads);
});

test("a newer billing snapshot remains visible when cached auth revalidation fails", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "auth",
      JSON.stringify({
        status: "authenticated",
        isAuthenticated: true,
        creator: { id: 4301, username: "fixtureowner", tuzis: "10" },
        loading: false,
      }),
    );
  });
  let checks = 0;
  await page.route("**/api/auth/user/", async (route) => {
    checks++;
    await route.fulfill({
      status: 503,
      json: { detail: "Backend restarting" },
    });
  });
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.locator('main[data-zcash-auth-mounted="true"]'),
  ).toBeAttached();
  await expect(
    page.getByRole("heading", { name: "Credits & Earnings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toHaveCount(0);
  await expect.poll(() => checks).toBeGreaterThan(0);
  await expect(page.getByTestId("billing-balance-value")).toHaveText(
    "64,672.23",
  );
  await expect(page.locator('input[name="maxPrice"]').first()).toHaveAttribute(
    "max",
    "64672.234",
  );
});

test("a retained insufficient-funds callout shows credited balance and retry guidance without changing a draft", async ({
  page,
  request,
}) => {
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=5`);
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await billingInitialActorBarrier(page, "fixtureowner");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/lib/stores/eventNotifications.ts";
        const { eventNotifications } = await import(module);
        let initialized = false;
        eventNotifications.subscribe(
          (state: any) => (initialized = state.initialized),
        )();
        return initialized;
      }),
    )
    .toBe(true);
  let held: Route | undefined;
  await page.route("**/api/auth/user/", async (route) => {
    if (!held) {
      held = route;
      return;
    }
    await route.continue();
  });
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts";
    const { authStore } = await import(module);
    (window as any).oldRefusalAuthCheck = authStore.checkAuth({
      fresh: true,
      silent: true,
    });
  });
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.evaluate(async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const svelteModule = "/tests/browser/svelte-runtime.ts";
    const fixtureModule =
      "/tests/browser/purchase-insufficient-funds-fixture.svelte";
    const [{ mount }, { default: Fixture }] = await Promise.all([
      import(svelteModule),
      import(fixtureModule),
    ]);
    mount(Fixture, { target });
  });
  const callout = page.getByTestId("insufficient-funds");
  await expect(callout).toContainText("You have 5 2Z, so you need 15 more.");
  await held!.fulfill({
    json: { id: 4301, username: "fixtureowner", tuzis: "100" },
  });
  await page.evaluate(() => (window as any).oldRefusalAuthCheck);
  await expect(callout).toContainText("You have 5 2Z, so you need 15 more.");
  const draft = page.getByRole("textbox", { name: "Unsent donation message" });
  await draft.fill("My newest unsent message");
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=25`);
  await emit(page, "callout-credit", "BOUGHT_TUZI");
  await expect(callout).toContainText("You have 25 2Z. You can try again.");
  await expect(callout).not.toContainText("need 0 more");
  await expect(draft).toHaveValue("My newest unsent message");
});

for (const bulk of [false, true]) {
  test(`a delayed ${bulk ? "bulk" : "single"} quote keeps the balance credited before it arrived`, async ({
    page,
    request,
  }) => {
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    await page.evaluate(async (bulk) => {
      const target = document.createElement("div");
      document.body.append(target);
      const svelteModule = "/tests/browser/svelte-runtime.ts";
      const fixtureModule =
        "/tests/browser/purchase-balance-dialog-fixture.svelte";
      const [{ mount }, { default: Fixture }] = await Promise.all([
        import(svelteModule),
        import(fixtureModule),
      ]);
      mount(Fixture, { target, props: { bulk, holdQuote: true } });
    }, bulk);
    await expect
      .poll(() =>
        page.evaluate(() => Boolean((window as any).releaseDelayedQuote)),
      )
      .toBe(true);
    await request.post(
      `${browserMockApiOrigin()}/__billing/balance?amount=74672.234`,
    );
    await emit(page, `delayed-quote-credit-${bulk}`, "BOUGHT_TUZI");
    await expect(page.getByTestId("billing-balance-value")).toHaveText(
      "74,672.23",
    );
    await page.evaluate(() => (window as any).releaseDelayedQuote());
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Balance 74672.234 2Z");
    await expect(
      dialog.getByRole("button", { name: "Refresh price and balance" }),
    ).toBeEnabled();
  });
}

test("a quote refresh cannot replace an unresolved bulk purchase decision", async ({
  page,
  request,
}) => {
  await request.post(
    `${browserMockApiOrigin()}/__billing/balance?amount=60000`,
  );
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/lib/stores/eventNotifications.ts";
        const { eventNotifications } = await import(module);
        let initialized = false;
        eventNotifications.subscribe(
          (state: any) => (initialized = state.initialized),
        )();
        return initialized;
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const svelteModule = "/tests/browser/svelte-runtime.ts";
    const fixtureModule =
      "/tests/browser/purchase-balance-dialog-fixture.svelte";
    const [{ mount }, { default: Fixture }] = await Promise.all([
      import(svelteModule),
      import(fixtureModule),
    ]);
    mount(Fixture, { target, props: { bulk: true, holdPurchase: true } });
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Balance 60000 2Z");
  await request.post(
    `${browserMockApiOrigin()}/__billing/balance?amount=74672.234`,
  );
  await emit(page, "bulk-buy-credit", "BOUGHT_TUZI");
  await expect(dialog).toContainText("Balance 74672.234 2Z");
  const refresh = dialog.getByRole("button", {
    name: "Refresh price and balance",
  });
  await refresh.click();
  await expect(dialog.getByTestId("translate-into-confirm")).toBeEnabled();
  await request.post(
    `${browserMockApiOrigin()}/__billing/balance?amount=79672.234`,
  );
  await emit(page, "bulk-buy-second-credit", "BOUGHT_TUZI");
  await expect(dialog).toContainText("Balance 79672.234 2Z");
  await dialog.getByTestId("translate-into-confirm").click();
  await expect
    .poll(() => page.evaluate(() => Boolean((window as any).releasePurchase)))
    .toBe(true);
  await expect(refresh).toBeDisabled();
  await page.evaluate(() => (window as any).releasePurchase());
});

test("a no-charge source refusal reprices after purchase settles and needs a new decision", async ({
  page,
  request,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await request.post(
    `${browserMockApiOrigin()}/__billing/balance?amount=79672.234`,
  );
  await emit(page, "refusal-credit", "BOUGHT_TUZI");
  await expect(page.getByTestId("billing-balance-value")).toHaveText(
    "79,672.23",
  );
  const acknowledgement = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Payment received" });
  await expect(acknowledgement).toBeVisible();
  await acknowledgement
    .getByRole("button", { name: "Close notification" })
    .click();
  await expect(acknowledgement).toHaveCount(0);
  await page.evaluate(async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const svelteModule = "/tests/browser/svelte-runtime.ts";
    const fixtureModule =
      "/tests/browser/purchase-balance-dialog-fixture.svelte";
    const [{ mount }, { default: Fixture }] = await Promise.all([
      import(svelteModule),
      import(fixtureModule),
    ]);
    mount(Fixture, { target, props: { bulk: true, refusePurchase: true } });
  });
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByTestId("translate-into-confirm");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toContainText("71000");
  await expect(confirm).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => (window as any).fixturePurchases.length))
    .toBe(1);
  await confirm.click();
  const purchases = await page.evaluate(() => (window as any).fixturePurchases);
  expect(purchases).toHaveLength(2);
  expect(purchases[1].total).toBe(71000);
  expect(purchases[1].key).not.toBe(purchases[0].key);
});

test("reconnection recovers a missed credit and receipt once without toasting initial history", async ({
  page,
  request,
}) => {
  const receipt = (id: string, created_at: string) => ({
    id,
    type: "BOUGHT_TUZI",
    read: false,
    amount: 2500,
    receiving_user: { username: "fixtureowner" },
    created_at,
    message: "You bought 2,500 tuzi",
  });
  let records = [receipt("historic-unread", "2026-10-06T15:00:00Z")],
    historyReads = 0;
  await page.route("**/api/events/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events/") {
      if (url.searchParams.get("recovery") === "payments") historyReads++;
      return route.fulfill({
        json: {
          count: records.length,
          results: records,
          next: null,
          recovery_boundary: "mock-complete-receipt-scan",
        },
      });
    }
    if (url.pathname === "/api/events/unread_count/")
      return route.fulfill({ json: ownedUnreadCount(records.length) });
    if (url.pathname === "/api/events/has/")
      return route.fulfill({ json: true });
    return route.continue();
  });
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await expect.poll(() => historyReads).toBeGreaterThan(0);
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Payment received" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const seen = new WeakSet<Element>();
    (window as any).receiptAnnouncements = 0;
    new MutationObserver(() => {
      document.querySelectorAll("[data-sonner-toast]").forEach((toast) => {
        if (
          !seen.has(toast) &&
          toast.textContent?.includes("Payment received")
        ) {
          seen.add(toast);
          (window as any).receiptAnnouncements++;
        }
      });
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.evaluate(() =>
    (window as any).purchaseSocket.onclose({ code: 1006 }),
  );
  await request.post(
    `${browserMockApiOrigin()}/__billing/balance?amount=74672.234`,
  );
  records = [receipt("offline-credit", "2026-10-06T16:00:00Z"), ...records];
  await expect(page.getByTestId("billing-balance-value")).toHaveText(
    "74,672.23",
  );
  const notice = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Payment received — 2,500 2Z credited." });
  await expect(notice).toHaveCount(1);
  const readState = () =>
    page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      let state: any;
      eventNotifications.subscribe((value: any) => (state = value))();
      return {
        ids: state.events.map((event: any) => event.id),
        unread: state.unreadCount,
      };
    });
  await expect
    .poll(async () => (await readState()).ids)
    .toContain("offline-credit");
  expect((await readState()).unread).toBe(2);
  await emit(page, "offline-credit", "BOUGHT_TUZI");
  await page.evaluate(() =>
    (window as any).purchaseSocket.onclose({ code: 1006 }),
  );
  await expect.poll(() => historyReads).toBeGreaterThan(2);
  expect(await page.evaluate(() => (window as any).receiptAnnouncements)).toBe(
    1,
  );
  expect((await readState()).unread).toBe(2);
});

test("older recovery HTTP cannot erase live receipts, loaded pages, or newer read state", async ({
  page,
  request,
}) => {
  await initialRecoveryBarrier(page);
  await page.addInitScript(() => {
    const native = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.origin,
      );
      if (
        (window as any).tagHeldHistory &&
        url.pathname === "/api/events/" &&
        url.searchParams.get("page") === "1"
      ) {
        (window as any).tagHeldHistory = false;
        const headers = new Headers(init?.headers);
        headers.set("x-test-held-history", "explicit-overlap");
        return native(input, { ...init, headers });
      }
      return native(input, init);
    };
  });
  const existing = {
    id: "read-during-recovery",
    type: "BOUGHT_TUZI",
    read: false,
    amount: 2,
    receiving_user: { username: "fixtureowner" },
    created_at: "2026-10-06T15:00:00Z",
  };
  const older = {
    ...existing,
    id: "older-page",
    created_at: "2026-10-05T15:00:00Z",
  };
  let hold = false,
    held: Route | undefined,
    unread = 2;
  await page.route("**/api/events/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events/") {
      if (url.searchParams.get("recovery") === "payments")
        return route.fulfill({
          json: {
            results: [],
            next: null,
            count: 0,
            recovery_boundary: "mock-empty-receipt-scan",
          },
        });

      if (
        hold &&
        !held &&
        route.request().headers()["x-test-held-history"] === "explicit-overlap"
      ) {
        held = route;
        return;
      }
      if (url.searchParams.get("page") === "2")
        return route.fulfill({
          json: {
            results: [older],
            next: "/api/events/?page=3&type=social",
            count: 500,
          },
        });
      return route.fulfill({
        json: {
          results: [existing],
          next: "/api/events/?page=2&type=social",
          count: 500,
        },
      });
    }
    if (url.pathname === "/api/events/unread_count/")
      return route.fulfill({ json: ownedUnreadCount(unread) });
    if (url.pathname === "/api/events/has/")
      return route.fulfill({ json: true });
    if (url.pathname.includes("/read/")) return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as any).initialRecoverySettled)),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.loadInitial();
    await eventNotifications.loadMore();
  });
  hold = true;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    (window as any).tagHeldHistory = true;
    (window as any).heldHistory = eventNotifications.reconcile("fixtureowner");
  });
  await expect.poll(() => Boolean(held)).toBe(true);
  expect(held!.request().headers()["x-test-held-history"]).toBe(
    "explicit-overlap",
  );
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.markRead("read-during-recovery");
  });
  await request.post(
    `${browserMockApiOrigin()}/__billing/balance?amount=74672.234`,
  );
  await emit(page, "live-during-history", "BOUGHT_TUZI");
  unread = 2;
  hold = false;
  await held!.fulfill({
    json: {
      results: [existing],
      next: "/api/events/?page=2&type=social",
      count: 500,
    },
  });
  await page.evaluate(() => (window as any).heldHistory);
  const state = await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    let state: any;
    eventNotifications.subscribe((value: any) => (state = value))();
    return state;
  });
  expect(state.events.map((event: any) => event.id)).toEqual(
    expect.arrayContaining([
      "older-page",
      "read-during-recovery",
      "live-during-history",
    ]),
  );
  expect(
    state.events.find((event: any) => event.id === "read-during-recovery").read,
  ).toBe(true);
  expect(state.nextPageUrl).toContain("page=2");
  expect(state.unreadCount).toBe(2);
});

test("a delayed profile snapshot cannot overwrite a payment observed later by the database", async ({
  page,
  request,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/lib/stores/eventNotifications.ts";
        const { eventNotifications } = await import(module);
        let initialized = false;
        eventNotifications.subscribe(
          (state: any) => (initialized = state.initialized),
        )();
        return initialized;
      }),
    )
    .toBe(true);
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=5`);
  let held: Route | undefined, response: any;
  await page.route(
    "**/fixtureowner/dashboard/profile/__data.json*",
    async (route) => {
      if (held) return route.continue();
      response = await route.fetch();
      held = route;
    },
  );
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.id = "delayed-profile-nav";
    link.href = "/fixtureowner/dashboard/profile";
    document.body.append(link);
    link.click();
  });
  await expect.poll(() => Boolean(held)).toBe(true);
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=25`);
  await emit(page, "credit-during-profile-navigation", "BOUGHT_TUZI");
  await expect(page.getByTestId("billing-balance-value")).toHaveText("25", {
    timeout: 3000,
  });
  await held!.fulfill({ response });
  await page.waitForURL("**/fixtureowner/dashboard/profile");
  await expect(page.getByTestId("stat-balance")).toContainText("25");
});

test("an old history total cannot resurrect notifications after mark all read", async ({
  page,
}) => {
  await initialRecoveryBarrier(page);
  const old = {
    id: "all-read-during-recovery",
    type: "BOUGHT_TUZI",
    read: false,
    amount: 2,
    receiving_user: { username: "fixtureowner" },
    created_at: "2026-10-06T15:00:00Z",
  };
  let hold = false,
    held: Route | undefined,
    unread = 500;
  let rejectMeta = false;
  await page.route("**/api/events/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events/") {
      if (url.searchParams.get("recovery") === "payments")
        return route.fulfill({
          json: {
            results: [],
            next: null,
            count: 0,
            recovery_boundary: "mock-empty-receipt-scan",
          },
        });

      if (hold && !held) {
        held = route;
        return;
      }
      return route.fulfill({
        json: { results: [old], next: null, count: 500 },
      });
    }
    if (url.pathname === "/api/events/unread_count/")
      return rejectMeta
        ? route.fulfill({
            status: 503,
            json: { detail: "Metadata read unavailable" },
          })
        : route.fulfill({ json: ownedUnreadCount(unread) });
    if (url.pathname === "/api/events/has/")
      return route.fulfill({ json: true });
    if (url.pathname.includes("/read/all/")) {
      unread = 0;
      return route.fulfill({ json: {} });
    }
    return route.continue();
  });
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.loadInitial();
  });
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as any).initialRecoverySettled)),
    )
    .toBe(true);
  hold = true;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    (window as any).heldHistory = eventNotifications.reconcile("fixtureowner");
  });
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.markAllRead();
  });
  rejectMeta = true;
  hold = false;
  await held!.fulfill({ json: { results: [old], next: null, count: 500 } });
  await page.evaluate(() => (window as any).heldHistory);
  const state = await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    let state: any;
    eventNotifications.subscribe((value: any) => (state = value))();
    return state;
  });
  expect(state.unreadCount).toBe(0);
  expect(state.events.find((event: any) => event.id === old.id)?.read).toBe(
    true,
  );
});

test("recovery rejects another recipient's records and counts before local logout catches up", async ({
  page,
}) => {
  const own = {
    id: "alice-history",
    type: "BOUGHT_TUZI",
    read: false,
    amount: 2,
    receiving_user: { username: "fixtureowner" },
    created_at: "2026-10-06T15:00:00Z",
  };
  let holdMode: "none" | "record" | "count" | "legacy-count" = "none";
  const heldEvents: Route[] = [];
  const heldCounts: Route[] = [];
  await page.route("**/api/events/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events/") {
      if (url.searchParams.get("recovery") === "payments")
        return route.fulfill({
          json: {
            results: [],
            next: null,
            count: 0,
            recovery_boundary: "mock-empty-receipt-scan",
          },
        });

      if (holdMode === "record") {
        heldEvents.push(route);
        return;
      }
      return route.fulfill({ json: { results: [own], count: 1, next: null } });
    }
    if (
      url.pathname === "/api/events/unread_count/" &&
      (holdMode === "count" || holdMode === "legacy-count")
    ) {
      heldCounts.push(route);
      return;
    }
    if (url.pathname === "/api/events/unread_count/")
      return route.fulfill({
        json: {
          unread_count: holdMode === "count" ? 400 : 1,
          recipient_username:
            holdMode === "count" ? "other-account" : "fixtureowner",
        },
      });
    if (url.pathname === "/api/events/has/")
      return route.fulfill({ json: true });
    return route.continue();
  });
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/lib/stores/eventNotifications.ts";
        const { eventNotifications } = await import(module);
        let ready = false;
        eventNotifications.subscribe(
          (state: any) => (ready = state.initialized),
        )();
        return ready;
      }),
    )
    .toBe(true);
  for (const mode of ["record", "count", "legacy-count"] as const) {
    if (mode === "record") heldEvents.length = 0;
    else heldCounts.length = 0;
    holdMode = mode;
    await page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      (window as any).wrongRecipientRecoverySettled = false;
      (window as any).wrongRecipientRecovery = eventNotifications
        .reconcile("fixtureowner")
        .then(
          () => false,
          () => true,
        )
        .finally(() => {
          (window as any).wrongRecipientRecoverySettled = true;
        });
    });
    let released = 0;
    const heldRoutes = mode === "record" ? heldEvents : heldCounts;
    while (
      !(await page.evaluate(
        () => (window as any).wrongRecipientRecoverySettled === true,
      ))
    ) {
      await expect
        .poll(
          async () =>
            (await page.evaluate(
              () => (window as any).wrongRecipientRecoverySettled === true,
            )) || heldRoutes.length > released,
        )
        .toBe(true);
      if (
        await page.evaluate(
          () => (window as any).wrongRecipientRecoverySettled === true,
        )
      )
        break;
      const foreignResponse =
        mode === "record"
          ? {
              results: [
                {
                  ...own,
                  id: `bob-private-${released}`,
                  receiving_user: { username: "other-account" },
                },
              ],
              count: 1,
              next: null,
            }
          : mode === "count"
            ? { unread_count: 400, recipient_username: "other-account" }
            : 400;
      await heldRoutes[released++].fulfill({ json: foreignResponse });
    }
    expect(
      await page.evaluate(() => (window as any).wrongRecipientRecovery),
    ).toBe(true);
    const state = await page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      let state: any;
      eventNotifications.subscribe((value: any) => (state = value))();
      return state;
    });
    expect(state.events.map((event: any) => event.id)).toEqual([
      "alice-history",
    ]);
    expect(state.unreadCount).toBe(1);
    holdMode = "none";
  }
  await page.evaluate(async (loader) => {
    const { eventNotifications } = await new Function(loader)();
    eventNotifications.clearForLogout();
  }, EVENT_NOTIFICATIONS_LOADER);
  const loggedOut = await page.evaluate(async (loader) => {
    const { eventNotifications } = await new Function(loader)();
    let state: any;
    eventNotifications.subscribe((value: any) => (state = value))();
    return state;
  }, EVENT_NOTIFICATIONS_LOADER);
  expect(loggedOut.events).toEqual([]);
  expect(loggedOut.unreadCount).toBe(0);
});

test("unread metadata retries after a long mixed-version rollout", async ({
  page,
}) => {
  await initialRecoveryBarrier(page);
  let legacyResponse = false;
  let retryReads = 0;
  let validReads = 0;
  let legacyResponsesFinished = 0;
  let countRouteArmed = false;
  await page.route("**/api/events/unread_count/**", async (route) => {
    if (!countRouteArmed) return route.continue();
    if (legacyResponse) {
      retryReads += 1;
      await route.fulfill({ json: 0 });
      legacyResponsesFinished += 1;
      return;
    }
    validReads += 1;
    return route.fulfill({
      json: { unread_count: 0, recipient_username: "fixtureowner" },
    });
  });
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as any).initialRecoverySettled)),
    )
    .toBe(true);
  await page.clock.install();
  await page.evaluate(() => {
    const native = window.setTimeout.bind(window);
    (window as any).retryTimeouts = [];
    window.setTimeout = ((
      callback: TimerHandler,
      delay?: number,
      ...args: any[]
    ) => {
      (window as any).retryTimeouts.push(delay);
      return native(callback, delay, ...args);
    }) as typeof window.setTimeout;
  });
  countRouteArmed = true;
  const initialCount = await page.evaluate(async (loader) => {
    const { eventNotifications } = await new Function(loader)();
    let count = -1;
    eventNotifications.subscribe((state: any) => (count = state.unreadCount))();
    return count;
  }, EVENT_NOTIFICATIONS_LOADER);
  const validBefore = validReads;
  await page.evaluate(async (loader) => {
    const { eventNotifications } = await new Function(loader)();
    await eventNotifications.refreshMeta("fixtureowner");
  }, EVENT_NOTIFICATIONS_LOADER);
  await expect.poll(() => validReads).toBeGreaterThan(validBefore);
  await new Promise((resolve) => setTimeout(resolve, 50));
  legacyResponse = true;
  await page.evaluate(async (loader) => {
    const { eventNotifications } = await new Function(loader)();
    await eventNotifications.refreshMeta("fixtureowner");
  }, EVENT_NOTIFICATIONS_LOADER);
  await expect.poll(() => retryReads).toBe(1);
  await expect.poll(() => legacyResponsesFinished).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const [index, delay] of [1_000, 5_000, 15_000, 30_000].entries()) {
    await page.clock.runFor(delay);
    await expect.poll(() => retryReads).toBe(index + 2);
    await expect.poll(() => legacyResponsesFinished).toBe(index + 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const pendingRetryDelays = await page.evaluate(
    () => (window as any).retryTimeouts,
  );
  expect(pendingRetryDelays).toContain(60_000);
  const whileLegacy = await page.evaluate(async (loader) => {
    const { eventNotifications } = await new Function(loader)();
    let count = -1;
    eventNotifications.subscribe((state: any) => (count = state.unreadCount))();
    return count;
  }, EVENT_NOTIFICATIONS_LOADER);
  expect(whileLegacy).toBe(initialCount);
  const priorToRecoveryReads = validReads;
  legacyResponse = false;
  await page.clock.runFor(60_001);
  await expect.poll(() => validReads).toBe(priorToRecoveryReads + 1);
  const recovered = await page.evaluate(async (loader) => {
    const { eventNotifications } = await new Function(loader)();
    let count = -1;
    eventNotifications.subscribe((state: any) => (count = state.unreadCount))();
    return count;
  }, EVENT_NOTIFICATIONS_LOADER);
  expect(recovered).toBe(0);
});

test("a stale foreign unread response cannot cancel the new account retry", async ({
  page,
}) => {
  // Drive two explicit store owners without an authenticated layout adding
  // a third owner's metadata refreshes to the exact retry-count assertion.
  await page.context().clearCookies();
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({ status: 401, json: { detail: "Anonymous fixture" } }),
  );
  await page.goto("/search");
  await expect
    .poll(() => expiryActorState(page))
    .toEqual({
      status: "anonymous",
      username: null,
    });

  let staleAliceRequest: Route | undefined;
  let unreadReads = 0;
  let bobUnreadReads = 0;
  await page.route("**/api/events/unread_count/**", async (route) => {
    unreadReads += 1;
    if (unreadReads === 1) {
      staleAliceRequest = route;
      return;
    }
    bobUnreadReads += 1;
    await route.fulfill({ json: 0 });
  });
  await page.clock.install();
  await page.evaluate(() => {
    const native = window.setTimeout.bind(window);
    (window as any).retryTimeouts = [];
    window.setTimeout = ((
      callback: TimerHandler,
      delay?: number,
      ...args: any[]
    ) => {
      (window as any).retryTimeouts.push(delay);
      return native(callback, delay, ...args);
    }) as typeof window.setTimeout;
  });

  await page.evaluate(async (loader) => {
    const { eventNotifications } = await new Function(loader)();
    (window as any).staleAliceMeta = eventNotifications.refreshMeta("alice");
  }, EVENT_NOTIFICATIONS_LOADER);
  await expect.poll(() => Boolean(staleAliceRequest)).toBe(true);

  await page.evaluate(async (loader) => {
    const { eventNotifications } = await new Function(loader)();
    eventNotifications.clearForLogout();
    (window as any).bobMeta = eventNotifications.refreshMeta("bob");
  }, EVENT_NOTIFICATIONS_LOADER);
  await page.evaluate(() => (window as any).bobMeta);
  await expect.poll(() => bobUnreadReads).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).retryTimeouts.includes(1_000)),
    )
    .toBe(true);

  await staleAliceRequest!.fulfill({
    json: { unread_count: 400, recipient_username: "bob" },
  });
  await page.evaluate(() => (window as any).staleAliceMeta);
  await page.clock.runFor(1_001);
  await expect.poll(() => bobUnreadReads).toBe(2);
  await page.evaluate(async (loader) => {
    const { eventNotifications } = await new Function(loader)();
    eventNotifications.clearForLogout();
  }, EVENT_NOTIFICATIONS_LOADER);
});

test("failed mixed recovery waits for recipient validation and suppresses deferred metadata", async ({
  page,
}) => {
  const own = {
    id: "isolated-history",
    type: "BOUGHT_TUZI",
    read: false,
    amount: 2,
    receiving_user: { username: "fixtureowner" },
    created_at: "2026-10-14T00:00:00Z",
  };
  let holdValid = false,
    holdForeign = false,
    failHasOnce = false,
    foreignMetadata = false,
    newAccount = false;
  let heldValid: Route | undefined, heldForeign: Route | undefined;
  let notificationHistoryReads = 0;
  await page.route("**/api/events/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events/") {
      if (url.searchParams.get("recovery") === "payments")
        return route.fulfill({
          json: {
            results: [],
            next: null,
            count: 0,
            recovery_boundary: "mock-empty-receipt-scan",
          },
        });
      notificationHistoryReads += 1;
      if (holdValid && !heldValid) {
        heldValid = route;
        return;
      }
      if (holdForeign && !heldForeign) {
        heldForeign = route;
        return;
      }
      return route.fulfill({
        json: {
          results: [
            {
              ...own,
              receiving_user: {
                username: newAccount ? "next-account" : "fixtureowner",
              },
            },
          ],
          count: 1,
          next: null,
        },
      });
    }
    if (url.pathname === "/api/events/has/") {
      if (failHasOnce) {
        failHasOnce = false;
        return route.fulfill({ status: 503, json: { detail: "offline" } });
      }
      return route.fulfill({ json: true });
    }
    if (url.pathname === "/api/events/unread_count/") {
      return route.fulfill({
        json: {
          unread_count: newAccount ? 7 : foreignMetadata ? 400 : 1,
          recipient_username: newAccount
            ? "next-account"
            : foreignMetadata
              ? "other-account"
              : "fixtureowner",
        },
      });
    }
    if (url.pathname.startsWith("/api/events/read/"))
      return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.addInitScript(() => {
    const nativeFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      const url = new URL(String(args[0]), location.href);
      if (
        (window as any).holdNotificationMetadataBody &&
        url.pathname === "/api/events/unread_count/"
      ) {
        (window as any).holdNotificationMetadataBody = false;
        return new Response(
          new ReadableStream({
            start(controller) {
              (window as any).heldNotificationMetadataBody = controller;
            },
          }),
          { status: response.status, headers: response.headers },
        );
      }
      return response;
    };
  });

  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  const state = () =>
    page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      let value: any;
      eventNotifications.subscribe((current: any) => (value = current))();
      return { initialized: value.initialized, unread: value.unreadCount };
    });
  await expect.poll(async () => (await state()).initialized).toBe(true);
  await expect.poll(async () => (await state()).unread).toBe(1);

  holdValid = true;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    (window as any).validRecovery =
      eventNotifications.reconcile("fixtureowner");
  });
  await expect.poll(() => Boolean(heldValid)).toBe(true);

  // The second reconciliation fails a metadata endpoint immediately while
  // its recipient-bearing history response is still held.
  holdForeign = true;
  failHasOnce = true;
  foreignMetadata = true;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    (window as any).foreignRecovery = eventNotifications
      .reconcile("fixtureowner")
      .then(
        () => false,
        () => true,
      );
    // A read mutation requests a deferred metadata refresh while both
    // recipient checks are active. The visible unread count remains one.
    (window as any).metadataMutation =
      eventNotifications.markRead("not-visible");
  });
  await expect.poll(() => Boolean(heldForeign)).toBe(true);
  await heldValid!.fulfill({
    json: { results: [own], count: 1, next: null },
  });
  await page.evaluate(() => (window as any).validRecovery);

  const settledBeforeForeignHistory = await page.evaluate(async () =>
    Promise.race([
      (window as any).foreignRecovery.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
    ]),
  );
  foreignMetadata = false;
  const historyReadsBeforeRetry = notificationHistoryReads;
  await heldForeign!.fulfill({
    json: {
      results: [
        {
          ...own,
          id: "foreign-history",
          receiving_user: { username: "other-account" },
        },
      ],
      count: 400,
      next: null,
    },
  });
  expect(await page.evaluate(() => (window as any).foreignRecovery)).toBe(true);
  await page.evaluate(() => (window as any).metadataMutation);
  expect((await state()).unread).toBe(1);
  await expect
    .poll(() => notificationHistoryReads)
    .toBeGreaterThan(historyReadsBeforeRetry);
  expect((await state()).unread).toBe(1);
  expect(settledBeforeForeignHistory).toBe(false);

  // A later fully validated request is allowed to refresh current-account
  // metadata, proving the failed generation does not permanently poison it.
  holdValid = false;
  holdForeign = false;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.reconcile("fixtureowner");
  });
  expect((await state()).unread).toBe(1);

  // Retire any late work at an account switch, then prove its eventual result
  // cannot replace metadata fetched for the new account.
  holdValid = true;
  heldValid = undefined;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    (window as any).staleRecovery = eventNotifications
      .reconcile("fixtureowner")
      .catch(() => {});
  });
  await expect.poll(() => Boolean(heldValid)).toBe(true);
  newAccount = true;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    eventNotifications.clearForLogout();
    await eventNotifications.refreshMeta();
    let emptyCount = -1;
    eventNotifications.subscribe((value: any) => {
      emptyCount = value.unreadCount;
    })();
    if (emptyCount !== 0)
      throw new Error("metadata without an actor must stay empty");
    await eventNotifications.refreshMeta("next-account");
  });
  await expect.poll(async () => (await state()).unread).toBe(7);
  await heldValid!.fulfill({
    json: {
      results: [
        {
          ...own,
          id: "late-old-account",
          receiving_user: { username: "fixtureowner" },
        },
      ],
      count: 400,
      next: null,
    },
  });
  await page.evaluate(() => (window as any).staleRecovery);
  expect(await state()).toEqual({ initialized: false, unread: 7 });

  // A response body that ignores fetch cancellation cannot retain ownership
  // of the metadata gate after its caller aborts.
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    (window as any).holdNotificationMetadataBody = true;
    const controller = new AbortController();
    (window as any).stalledRecovery = eventNotifications
      .reconcile("next-account", undefined, controller.signal)
      .catch(() => {});
    (window as any).abortStalledRecovery = () =>
      controller.abort(new DOMException("superseded", "AbortError"));
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as any).heldNotificationMetadataBody),
      ),
    )
    .toBe(true);
  await page.evaluate(() => (window as any).abortStalledRecovery());
  await page.evaluate(() => (window as any).stalledRecovery);
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.reconcile("next-account");
  });
  expect((await state()).unread).toBe(7);
  await page.evaluate(() => {
    const controller = (window as any).heldNotificationMetadataBody;
    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          unread_count: 400,
          recipient_username: "fixtureowner",
        }),
      ),
    );
    controller.close();
  });
  await page.waitForTimeout(50);
  expect((await state()).unread).toBe(7);
});

test("concurrent notification metadata follows request order", async ({
  page,
}) => {
  const own = {
    id: "ordered-history",
    type: "BOUGHT_TUZI",
    read: false,
    amount: 2,
    receiving_user: { username: "fixtureowner" },
    created_at: "2026-10-14T00:00:00Z",
  };
  let unreadCount = 1;
  let historiesToHold = 0;
  const heldHistories: Route[] = [];
  await page.route("**/api/events/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events/") {
      if (url.searchParams.get("recovery") === "payments")
        return route.fulfill({
          json: {
            results: [],
            next: null,
            count: 0,
            recovery_boundary: "mock-empty-receipt-scan",
          },
        });
      if (historiesToHold > 0) {
        historiesToHold -= 1;
        heldHistories.push(route);
        return;
      }
      return route.fulfill({
        json: { results: [own], count: 1, next: null },
      });
    }
    if (url.pathname === "/api/events/has/")
      return route.fulfill({ json: true });
    if (url.pathname === "/api/events/unread_count/")
      return route.fulfill({ json: ownedUnreadCount(unreadCount) });
    if (url.pathname.startsWith("/api/events/read/"))
      return route.fulfill({ json: {} });
    return route.continue();
  });

  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  const state = async () =>
    page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      let value: any;
      eventNotifications.subscribe((current: any) => (value = current))();
      return value.unreadCount;
    });
  await expect.poll(state).toBe(1);

  // The latest request completes first; its metadata must still win when the
  // older recipient-validated request completes afterwards.
  historiesToHold = 1;
  unreadCount = 1;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    (window as any).olderRecovery =
      eventNotifications.reconcile("fixtureowner");
  });
  await expect.poll(() => heldHistories.length).toBe(1);
  unreadCount = 2;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.reconcile("fixtureowner");
  });
  expect(await state()).toBe(1);
  await heldHistories[0].fulfill({
    json: { results: [own], count: 1, next: null },
  });
  await page.evaluate(() => (window as any).olderRecovery);
  expect(await state()).toBe(2);

  // Reverse the completion order. The same newest-requested value wins.
  historiesToHold = 2;
  unreadCount = 3;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    (window as any).reverseOlderRecovery =
      eventNotifications.reconcile("fixtureowner");
  });
  await expect.poll(() => heldHistories.length).toBe(2);
  unreadCount = 4;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    (window as any).reverseNewerRecovery =
      eventNotifications.reconcile("fixtureowner");
  });
  await expect.poll(() => heldHistories.length).toBe(3);
  await heldHistories[1].fulfill({
    json: { results: [own], count: 1, next: null },
  });
  await page.evaluate(() => (window as any).reverseOlderRecovery);
  expect(await state()).toBe(2);
  await heldHistories[2].fulfill({
    json: { results: [own], count: 1, next: null },
  });
  await page.evaluate(() => (window as any).reverseNewerRecovery);
  expect(await state()).toBe(4);
});

for (const generated of [false, true]) {
  test(`a delayed ${generated ? "generated" : "raw"} server refusal cannot hide an already credited balance`, async ({
    page,
    request,
  }) => {
    await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=5`);
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const module = "/src/lib/stores/eventNotifications.ts";
          const { eventNotifications } = await import(module);
          let initialized = false;
          eventNotifications.subscribe(
            (state: any) => (initialized = state.initialized),
          )();
          return initialized;
        }),
      )
      .toBe(true);
    let held: Route | undefined;
    await page.route("**/api/refusal-fixture/", (route) => {
      held = route;
    });
    await page.evaluate(
      async ({ generated }) => {
        const target = document.createElement("div");
        document.body.append(target);
        const svelteModule = "/tests/browser/svelte-runtime.ts";
        const fixtureModule =
          "/tests/browser/purchase-insufficient-funds-fixture.svelte";
        const [{ mount }, { default: Fixture }] = await Promise.all([
          import(svelteModule),
          import(fixtureModule),
        ]);
        mount(Fixture, {
          target,
          props: { requestUrl: "/api/refusal-fixture/", generated },
        });
      },
      { generated },
    );
    await expect.poll(() => Boolean(held)).toBe(true);
    const draft = page.getByRole("textbox", {
      name: "Unsent donation message",
    });
    await draft.fill("Preserve my newest donation message");
    await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=25`);
    await emit(page, `delayed-refusal-credit-${generated}`, "BOUGHT_TUZI");
    await expect(page.getByTestId("billing-balance-value")).toHaveText("25");
    await held!.fulfill({
      status: 402,
      json: {
        code: "insufficient_funds",
        cost: "20",
        balance: "5",
        shortfall: "15",
        action: "donation",
      },
    });
    const callout = page.getByTestId("insufficient-funds");
    await expect(callout).toContainText(
      "This costs 20 2Z. You have 25 2Z. You can try again.",
    );
    await expect(callout).not.toContainText("need 15 more");
    await expect(draft).toHaveValue("Preserve my newest donation message");
  });
}

test("reconnection restores pagination after the first notification page failed", async ({
  page,
}) => {
  let failing = true;
  const receipt = (id: string) => ({
    id,
    type: "BOUGHT_TUZI",
    read: false,
    amount: 2,
    receiving_user: { username: "fixtureowner" },
    created_at: "2026-10-06T15:00:00Z",
  });
  await page.route("**/api/events/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events/") {
      if (url.searchParams.get("recovery") === "payments")
        return route.fulfill({
          json: {
            results: [],
            next: null,
            count: 0,
            recovery_boundary: "mock-empty-receipt-scan",
          },
        });

      if (failing)
        return route.fulfill({
          status: 503,
          json: { detail: "temporarily unavailable" },
        });
      const second = url.searchParams.get("page") === "2";
      return route.fulfill({
        json: {
          count: 2,
          results: [
            receipt(second ? "recovered-older-page" : "recovered-first-page"),
          ],
          next: second ? null : "/api/events/?page=2&type=social",
        },
      });
    }
    if (url.pathname === "/api/events/unread_count/")
      return route.fulfill({ json: ownedUnreadCount(2) });
    if (url.pathname === "/api/events/has/")
      return route.fulfill({ json: true });
    return route.continue();
  });
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.loadInitial({ force: true });
  });
  const state = () =>
    page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      let value: any;
      eventNotifications.subscribe((current: any) => (value = current))();
      return {
        initialized: value.initialized,
        next: value.nextPageUrl,
        error: value.error,
        ids: value.events.map((event: any) => event.id),
      };
    });
  await expect
    .poll(async () => {
      await page.evaluate(async () => {
        const module = "/src/lib/stores/eventNotifications.ts";
        const { eventNotifications } = await import(module);
        await eventNotifications.loadInitial({ force: true });
      });
      return state();
    })
    .toMatchObject({ initialized: true, next: null });
  failing = false;
  await page.evaluate(() =>
    (window as any).purchaseSocket.onclose({ code: 1006 }),
  );
  await expect
    .poll(async () => (await state()).next)
    .toBe("/api/events/?page=2&type=social");
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.loadMore();
  });
  await expect
    .poll(async () => (await state()).ids)
    .toContain("recovered-older-page");
  expect((await state()).error).toBeNull();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Payment received" }),
  ).toHaveCount(0);
});

test("a marked refusal revalidates server truth when its earlier dispatch executes after a later account read", async ({
  page,
  request,
}) => {
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=5`);
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/lib/stores/eventNotifications.ts";
        const { eventNotifications } = await import(module);
        let initialized = false;
        eventNotifications.subscribe(
          (state: any) => (initialized = state.initialized),
        )();
        return initialized;
      }),
    )
    .toBe(true);
  let held: Route | undefined;
  await page.route("**/api/refusal-fixture/", (route) => {
    held = route;
  });
  await page.evaluate(async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const svelteModule = "/tests/browser/svelte-runtime.ts";
    const fixtureModule =
      "/tests/browser/purchase-insufficient-funds-fixture.svelte";
    const [{ mount }, { default: Fixture }] = await Promise.all([
      import(svelteModule),
      import(fixtureModule),
    ]);
    mount(Fixture, {
      target,
      props: { requestUrl: "/api/refusal-fixture/", generated: true },
    });
  });
  await expect.poll(() => Boolean(held)).toBe(true);
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=25`);
  await emit(page, "before-later-db-refusal", "BOUGHT_TUZI");
  await expect(page.getByTestId("billing-balance-value")).toHaveText("25");
  // The earlier-dispatched refusal only now executes its DB read, after an
  // external spend. Dispatch order must not claim that cached25 is truth.
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=5`);
  await held!.fulfill({
    status: 402,
    json: {
      code: "insufficient_funds",
      cost: "20",
      balance: "5",
      shortfall: "15",
      action: "donation",
    },
  });
  await expect(page.getByTestId("insufficient-funds")).toContainText(
    "This costs 20 2Z. You have 5 2Z, so you need 15 more.",
  );
  await expect(page.getByTestId("billing-balance-value")).toHaveText("5");
  await expect(
    page.getByRole("textbox", { name: "Unsent donation message" }),
  ).toHaveValue("My unsent message");
});

for (const bulk of [false, true]) {
  test(`the ${bulk ? "bulk" : "single"} translation dialog preserves server refusal provenance and refreshes a later server balance`, async ({
    page,
    request,
  }) => {
    await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=25`);
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const module = "/src/lib/stores/eventNotifications.ts";
          const { eventNotifications } = await import(module);
          let initialized = false;
          eventNotifications.subscribe(
            (state: any) => (initialized = state.initialized),
          )();
          return initialized;
        }),
      )
      .toBe(true);
    let held: Route | undefined;
    let purchaseRequests = 0;
    await page.route("**/api/translation-refusal-fixture/", (route) => {
      purchaseRequests++;
      held = route;
    });
    await page.evaluate(
      async ({ bulk }) => {
        const target = document.createElement("div");
        document.body.append(target);
        const svelteModule = "/tests/browser/svelte-runtime.ts";
        const fixtureModule =
          "/tests/browser/purchase-balance-dialog-fixture.svelte";
        const [{ mount }, { default: Fixture }] = await Promise.all([
          import(svelteModule),
          import(fixtureModule),
        ]);
        mount(Fixture, {
          target,
          props: { bulk, refusalUrl: "/api/translation-refusal-fixture/" },
        });
      },
      { bulk },
    );
    const dialog = page.getByRole("dialog");
    const confirm = bulk
      ? dialog.getByTestId("translate-into-confirm")
      : dialog.getByTestId("translate-ai-confirm");
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect.poll(() => Boolean(held)).toBe(true);
    await page.evaluate(async () => {
      const module = "/src/lib/stores/auth.ts";
      const { authStore } = await import(module);
      await authStore.checkAuth({ fresh: true, silent: true });
    });
    await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=5`);
    await held!.fulfill({
      status: 402,
      json: {
        code: "insufficient_funds",
        cost: "20",
        balance: "5",
        shortfall: "15",
        action: "translation",
      },
    });
    await expect(dialog.getByTestId("insufficient-funds")).toContainText(
      "This costs 20 2Z. You have 5 2Z, so you need 15 more.",
    );
    await expect(page.getByTestId("billing-balance-value")).toHaveText("5");
    expect(purchaseRequests).toBe(1);
  });
}

for (const exhausted of [true, false]) {
  test(`recovery loads new middle receipts when ${exhausted ? "an exhausted" : "a partially loaded"} feed gains pages`, async ({
    page,
  }) => {
    let recovered = false;
    const receipt = (id: string) => ({
      id,
      type: "BOUGHT_TUZI",
      read: false,
      amount: 2,
      receiving_user: { username: "fixtureowner" },
      created_at: "2026-10-06T15:00:00Z",
    });
    await page.route("**/api/events/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/events/") {
        if (url.searchParams.get("recovery") === "payments")
          return route.fulfill({
            json: {
              results: [],
              next: null,
              count: 0,
              recovery_boundary: "mock-empty-receipt-scan",
            },
          });

        const second = url.searchParams.get("page") === "2";
        const results = recovered
          ? Array.from({ length: second ? 8 : 12 }, (_, index) =>
              receipt(`new-${index + (second ? 12 : 0)}`),
            )
          : [receipt(second ? "loaded-old-page2" : "loaded-old-page1")];
        const next = recovered
          ? second
            ? null
            : "/api/events/?page=2&type=social"
          : exhausted
            ? null
            : second
              ? "/api/events/?page=3&type=social"
              : "/api/events/?page=2&type=social";
        return route.fulfill({
          json: {
            count: recovered ? (exhausted ? 21 : 60) : exhausted ? 1 : 40,
            results,
            next,
          },
        });
      }
      if (url.pathname === "/api/events/unread_count/")
        return route.fulfill({ json: ownedUnreadCount(recovered ? 21 : 1) });
      if (url.pathname === "/api/events/has/")
        return route.fulfill({ json: true });
      return route.continue();
    });
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    const state = () =>
      page.evaluate(async () => {
        const module = "/src/lib/stores/eventNotifications.ts";
        const { eventNotifications } = await import(module);
        let value: any;
        eventNotifications.subscribe((current: any) => (value = current))();
        return {
          initialized: value.initialized,
          next: value.nextPageUrl,
          ids: value.events.map((event: any) => event.id),
        };
      });
    await expect.poll(async () => (await state()).initialized).toBe(true);
    if (!exhausted) {
      await page.evaluate(async () => {
        const module = "/src/lib/stores/eventNotifications.ts";
        const { eventNotifications } = await import(module);
        await eventNotifications.loadMore();
      });
      expect((await state()).next).toBe("/api/events/?page=3&type=social");
    }
    recovered = true;
    await page.evaluate(() =>
      (window as any).purchaseSocket.onclose({ code: 1006 }),
    );
    await expect
      .poll(async () => (await state()).next)
      .toBe("/api/events/?page=2&type=social");
    await page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      await eventNotifications.loadMore();
    });
    await expect.poll(async () => (await state()).ids).toContain("new-19");
    expect((await state()).ids).toContain("loaded-old-page1");
    if (!exhausted) expect((await state()).ids).toContain("loaded-old-page2");
  });
}

test("a held older page cannot replace the recovered cursor when the same-size feed changes order", async ({
  page,
}) => {
  const record = (id: string) => ({
    id,
    type: "BOUGHT_TUZI",
    read: false,
    amount: 2,
    receiving_user: { username: "fixtureowner" },
    created_at: "2026-10-06T15:00:00Z",
  });
  let recovered = false;
  let held: Route | undefined;
  await page.route("**/api/events/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events/") {
      if (url.searchParams.get("recovery") === "payments")
        return route.fulfill({
          json: {
            results: [],
            next: null,
            count: 0,
            recovery_boundary: "mock-empty-receipt-scan",
          },
        });

      const number = url.searchParams.get("page") || "1";
      if (number === "3") {
        held = route;
        return;
      }
      return route.fulfill({
        json: {
          count: 500,
          results: [
            record(
              number === "2"
                ? recovered
                  ? "reopened-middle"
                  : "loaded-old-page2"
                : recovered
                  ? "changed-order-head"
                  : "loaded-old-page1",
            ),
          ],
          next: `/api/events/?page=${number === "2" ? "3" : "2"}&type=social`,
        },
      });
    }
    if (url.pathname === "/api/events/unread_count/")
      return route.fulfill({ json: ownedUnreadCount(2) });
    if (url.pathname === "/api/events/has/")
      return route.fulfill({ json: true });
    return route.continue();
  });
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  const state = () =>
    page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      let value: any;
      eventNotifications.subscribe((current: any) => (value = current))();
      return {
        initialized: value.initialized,
        next: value.nextPageUrl,
        loadingMore: value.loadingMore,
        ids: value.events.map((event: any) => event.id),
      };
    });
  await expect.poll(async () => (await state()).initialized).toBe(true);
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.loadMore();
    (window as any).oldPageLoad = eventNotifications.loadMore();
  });
  await expect.poll(() => Boolean(held)).toBe(true);
  recovered = true;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.reconcile("fixtureowner");
  });
  expect((await state()).next).toContain("page=2");
  await held!.fulfill({
    json: {
      count: 500,
      results: [record("old-inflight-page3")],
      next: "/api/events/?page=4&type=social",
    },
  });
  expect(await page.evaluate(() => (window as any).oldPageLoad)).toBe(false);
  expect(await state()).toMatchObject({
    next: "/api/events/?page=2&type=social",
    loadingMore: false,
  });
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.loadMore();
  });
  expect((await state()).ids).toEqual(
    expect.arrayContaining([
      "reopened-middle",
      "loaded-old-page1",
      "loaded-old-page2",
      "changed-order-head",
    ]),
  );
});

for (const aggregate of [1, 2]) {
  test(`notification recovery trusts aggregate${aggregate} across a separately observed read and page`, async ({
    page,
  }) => {
    await initialRecoveryBarrier(page);
    const record = (id: string) => ({
      id,
      type: "BOUGHT_TUZI",
      read: false,
      amount: 2,
      receiving_user: { username: "fixtureowner" },
      created_at: "2026-10-06T15:00:00Z",
    });
    let recovering = false,
      writeSettled = false,
      aggregateReads = 0;
    let heldWrite: Route | undefined, heldHistory: Route | undefined;
    await page.route("**/api/events/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/events/read/aggregate-A/") {
        heldWrite = route;
        return;
      }
      if (url.pathname === "/api/events/") {
        if (url.searchParams.get("recovery") === "payments")
          return route.fulfill({
            json: {
              results: [],
              next: null,
              count: 0,
              recovery_boundary: "mock-empty-receipt-scan",
            },
          });

        if (recovering) {
          heldHistory = route;
          return;
        }
        return route.fulfill({
          json: {
            count: 2,
            results: [record("aggregate-A"), record("aggregate-B")],
            next: null,
          },
        });
      }
      if (url.pathname === "/api/events/unread_count/") {
        if (!recovering) return route.fulfill({ json: ownedUnreadCount(2) });
        aggregateReads += 1;
        if (!writeSettled)
          return route.fulfill({ json: ownedUnreadCount(aggregate) });
        // Precommit reads share the selected aggregate, including background
        // refreshes. After commit, failure must not hide B for aggregate1;
        // a successful follow-up repairs stale aggregate2.
        return aggregate === 1
          ? route.fulfill({ status: 503, json: {} })
          : route.fulfill({ json: ownedUnreadCount(1) });
      }
      if (url.pathname === "/api/events/has/")
        return route.fulfill({ json: true });
      return route.continue();
    });
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect
      .poll(() =>
        page.evaluate(() => Boolean((window as any).initialRecoverySettled)),
      )
      .toBe(true);
    const state = () =>
      page.evaluate(async () => {
        const module = "/src/lib/stores/eventNotifications.ts";
        const { eventNotifications } = await import(module);
        let value: any;
        eventNotifications.subscribe((current: any) => (value = current))();
        return {
          initialized: value.initialized,
          unread: value.unreadCount,
          events: value.events,
        };
      });
    await expect.poll(async () => (await state()).initialized).toBe(true);
    const optimisticUnread = await page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      (window as any).heldRead = eventNotifications.markRead("aggregate-A");
      // Sample the synchronous optimistic update before an authoritative
      // metadata response can replace it while the write is still pending.
      let unread: number | undefined;
      eventNotifications.subscribe(
        (current: any) => (unread = current.unreadCount),
      )();
      return unread;
    });
    expect(optimisticUnread).toBe(1);
    await expect.poll(() => Boolean(heldWrite)).toBe(true);
    recovering = true;
    await page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      (window as any).heldAggregateHistory =
        eventNotifications.reconcile("fixtureowner");
    });
    await expect
      .poll(() => Boolean(heldHistory) && aggregateReads > 0)
      .toBe(true);
    writeSettled = true;
    await heldWrite!.fulfill({ json: {} });
    await page.evaluate(() => (window as any).heldRead);
    await heldHistory!.fulfill({
      json: {
        count: 2,
        results: [record("aggregate-A"), record("aggregate-B")],
        next: null,
      },
    });
    await page.evaluate(() => (window as any).heldAggregateHistory);
    await expect.poll(async () => (await state()).unread).toBe(1);
    expect(
      (await state()).events.find((event: any) => event.id === "aggregate-A")
        .read,
    ).toBe(true);
    expect(
      (await state()).events.find((event: any) => event.id === "aggregate-B")
        .read,
    ).toBe(false);
  });
}

for (const all of [false, true]) {
  test(`a late precommit metadata read cannot undo confirmed ${all ? "all" : "single"}-read counts`, async ({
    page,
  }) => {
    const record = (id: string) => ({
      id,
      type: "BOUGHT_TUZI",
      read: false,
      amount: 2,
      receiving_user: { username: "fixtureowner" },
      created_at: "2026-10-06T15:00:00Z",
    });
    let holdMeta = false,
      serverUnread = 2;
    let heldWrite: Route | undefined, heldMeta: Route | undefined;
    await page.route("**/api/events/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === `/api/events/read/${all ? "all" : "committed-A"}/`) {
        heldWrite = route;
        return;
      }
      if (
        url.pathname === "/api/events/" &&
        url.searchParams.get("recovery") === "payments"
      )
        return route.fulfill({
          json: {
            results: [],
            next: null,
            count: 0,
            recovery_boundary: "mock-empty-receipt-scan",
          },
        });
      if (url.pathname === "/api/events/")
        return route.fulfill({
          json: {
            count: 2,
            results: [record("committed-A"), record("committed-B")],
            next: null,
          },
        });
      if (url.pathname === "/api/events/unread_count/") {
        if (holdMeta && !heldMeta) {
          heldMeta = route;
          return;
        }
        return route.fulfill({ json: ownedUnreadCount(serverUnread) });
      }
      if (url.pathname === "/api/events/has/")
        return route.fulfill({ json: true });
      return route.continue();
    });
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    const state = () =>
      page.evaluate(async () => {
        const module = "/src/lib/stores/eventNotifications.ts";
        const { eventNotifications } = await import(module);
        let value: any;
        eventNotifications.subscribe((current: any) => (value = current))();
        return { initialized: value.initialized, unread: value.unreadCount };
      });
    await expect.poll(async () => (await state()).initialized).toBe(true);
    await page.evaluate(
      async ({ all }) => {
        const module = "/src/lib/stores/eventNotifications.ts";
        const { eventNotifications } = await import(module);
        (window as any).confirmedRead = all
          ? eventNotifications.markAllRead()
          : eventNotifications.markRead("committed-A");
      },
      { all },
    );
    await expect.poll(() => Boolean(heldWrite)).toBe(true);
    holdMeta = true;
    await page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      (window as any).precommitMetadata =
        eventNotifications.refreshMeta("fixtureowner");
    });
    await expect.poll(() => Boolean(heldMeta)).toBe(true);
    holdMeta = false;
    serverUnread = all ? 0 : 1;
    await heldWrite!.fulfill({ json: {} });
    await page.evaluate(() => (window as any).confirmedRead);
    await expect.poll(async () => (await state()).unread).toBe(serverUnread);
    await heldMeta!.fulfill({ json: ownedUnreadCount(2) });
    await page.evaluate(() => (window as any).precommitMetadata);
    expect((await state()).unread).toBe(serverUnread);
  });
}

test("confirmed mark-all settles its flag through a same-account filter change", async ({
  page,
}) => {
  let heldWrite: Route | undefined;
  let unread = 2;
  const record = (id: string) => ({
    id,
    type: "BOUGHT_TUZI",
    read: unread === 0,
    amount: 2,
    receiving_user: { username: "fixtureowner" },
    created_at: "2026-10-06T15:00:00Z",
  });
  await page.route("**/api/events/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events/read/all/") {
      heldWrite = route;
      return;
    }
    if (
      url.pathname === "/api/events/" &&
      url.searchParams.get("recovery") === "payments"
    )
      return route.fulfill({
        json: {
          results: [],
          next: null,
          count: 0,
          recovery_boundary: "mock-empty-receipt-scan",
        },
      });
    if (url.pathname === "/api/events/")
      return route.fulfill({
        json: {
          count: 2,
          results: [record("filter-A"), record("filter-B")],
          next: null,
        },
      });
    if (url.pathname === "/api/events/unread_count/")
      return route.fulfill({ json: ownedUnreadCount(unread) });
    if (url.pathname === "/api/events/has/")
      return route.fulfill({ json: true });
    return route.continue();
  });
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  const state = () =>
    page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      let value: any;
      eventNotifications.subscribe((current: any) => (value = current))();
      return {
        initialized: value.initialized,
        marking: value.markingAllRead,
        unread: value.unreadCount,
        filter: value.filter,
      };
    });
  await expect.poll(async () => (await state()).initialized).toBe(true);
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    (window as any).filteredMarkAll = eventNotifications.markAllRead();
  });
  await expect.poll(() => Boolean(heldWrite)).toBe(true);
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.setFilter("all");
  });
  expect((await state()).marking).toBe(true);
  unread = 0;
  await heldWrite!.fulfill({ json: {} });
  await page.evaluate(() => (window as any).filteredMarkAll);
  expect(await state()).toMatchObject({
    marking: false,
    unread: 0,
    filter: "all",
  });
});

test("a receipt committed between reconnect balance and history reads settles the later balance once", async ({
  page,
  request,
}) => {
  const baseline = {
    id: "between-read-baseline",
    type: "BOUGHT_TUZI",
    read: false,
    amount: 2,
    receiving_user: { username: "fixtureowner" },
    created_at: "2026-10-06T15:00:00Z",
  };
  const credit = {
    ...baseline,
    id: "between-read-credit",
    amount: 20,
    created_at: "2026-10-06T16:00:00Z",
  };
  let hold = false,
    held: Route | undefined;
  await page.route("**/api/events/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events/") {
      if (hold && url.searchParams.get("recovery") === "payments") {
        held = route;
        return;
      }
      return route.fulfill({
        json: {
          results: [baseline],
          next: null,
          count: 1,
          recovery_boundary: "mock-between-reads-scan",
        },
      });
    }
    if (url.pathname === "/api/events/has/")
      return route.fulfill({ json: true });
    if (url.pathname === "/api/events/unread_count/")
      return route.fulfill({ json: ownedUnreadCount(1) });
    return route.continue();
  });
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=5`);
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/lib/stores/eventNotifications.ts";
        const { eventNotifications } = await import(module);
        let initialized = false;
        eventNotifications.subscribe(
          (state: any) => (initialized = state.initialized),
        )();
        return initialized;
      }),
    )
    .toBe(true);
  await expect(page.getByTestId("billing-balance-value")).toHaveText("5");
  hold = true;
  await page.evaluate(() =>
    (window as any).purchaseSocket.onclose({ code: 1006 }),
  );
  await expect.poll(() => Boolean(held)).toBe(true);
  await expect(page.getByTestId("billing-balance-value")).toHaveText("5");
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=25`);
  hold = false;
  await held!.fulfill({
    json: {
      results: [credit, baseline],
      next: null,
      count: 2,
      recovery_boundary: "mock-between-reads-scan",
    },
  });
  await expect(page.getByTestId("billing-balance-value")).toHaveText("25");
  const notice = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Payment received — 20 2Z credited." });
  await expect(notice).toHaveCount(1);
  await emit(page, credit.id, "BOUGHT_TUZI");
  await expect(notice).toHaveCount(1);
  await expect(page.getByTestId("billing-balance-value")).toHaveText("25");
});

test("full receipt recovery finds a buried older-created credit beyond the first page without announcing history", async ({
  page,
  request,
}) => {
  const receipt = (id: string, created_at = "2026-10-06T15:00:00Z") => ({
    id,
    type: "BOUGHT_TUZI",
    read: false,
    amount: 20,
    receiving_user: { username: "fixtureowner" },
    created_at,
  });
  const baseline = Array.from({ length: 49 }, (_, i) =>
    receipt("receipt-baseline-" + i),
  );
  const lateCredit = receipt("buried-late-credit", "2026-10-05T15:00:00Z");
  let recovered = false,
    privateReads = 0;
  await page.route("**/api/events/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events/") {
      if (url.searchParams.get("recovery") === "payments") {
        privateReads++;
        const rows = recovered ? [...baseline, lateCredit] : baseline;
        const second = Boolean(url.searchParams.get("recovery_cursor"));
        return route.fulfill({
          json: {
            count: rows.length,
            results: rows.slice(second ? 48 : 0, second ? undefined : 48),
            next: second
              ? null
              : "/api/events/?recovery=payments&recovery_cursor=second-page",
            recovery_boundary: recovered
              ? "late-commit-recovery"
              : "quiet-initial-recovery",
          },
        });
      }
      const social = Array.from({ length: 12 }, (_, i) => ({
        ...receipt("social-after-credit-" + i),
        type: "PAGE_UPDATE",
        created_at: "2026-10-06T17:00:00Z",
      }));
      return route.fulfill({
        json: {
          count: recovered ? 62 : 49,
          results: recovered ? social : baseline.slice(0, 12),
          next: "/api/events/?page=2&type=social",
        },
      });
    }
    if (url.pathname === "/api/events/has/")
      return route.fulfill({ json: true });
    if (url.pathname === "/api/events/unread_count/")
      return route.fulfill({ json: ownedUnreadCount(recovered ? 62 : 49) });
    return route.continue();
  });
  const state = () =>
    page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      let value: any;
      eventNotifications.subscribe((state: any) => (value = state))();
      return {
        ids: value.events.map((event: any) => event.id),
        unread: value.unreadCount,
      };
    });
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=5`);
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect.poll(async () => privateReads).toBe(2);
  await expect.poll(async () => (await state()).ids.length).toBe(12);
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Payment received" }),
  ).toHaveCount(0);
  expect(privateReads).toBe(2);
  recovered = true;
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=25`);
  await page.evaluate(() =>
    (window as any).purchaseSocket.onclose({ code: 1006 }),
  );
  await expect.poll(async () => (await state()).ids).toContain(lateCredit.id);
  await expect.poll(async () => (await state()).unread).toBe(62);
  await expect(page.getByTestId("billing-balance-value")).toHaveText("25");
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Payment received — 20 2Z credited." }),
  ).toHaveCount(1);
  expect((await state()).unread).toBe(62);
  expect(privateReads).toBe(4);
  await emit(page, lateCredit.id, "BOUGHT_TUZI");
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Payment received — 20 2Z credited." }),
  ).toHaveCount(1);
});

for (const failureStatus of [400, 503]) {
  test(`an interrupted receipt scan ${failureStatus === 400 ? "restarts an expired cursor" : "resumes a transient cursor"} without announcing incomplete history`, async ({
    page,
  }) => {
    await initialRecoveryBarrier(page);
    const receipt = (id: string) => ({
      id,
      type: "BOUGHT_TUZI",
      read: false,
      amount: 20,
      receiving_user: { username: "fixtureowner" },
      created_at: "2026-10-06T15:00:00Z",
    });
    let heads = 0,
      tails = 0,
      fail = true;
    await page.route("**/api/events/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/events/") {
        if (url.searchParams.get("recovery") === "payments") {
          const second = Boolean(url.searchParams.get("recovery_cursor"));
          if (second) {
            tails++;
            if (fail) {
              fail = false;
              return route.fulfill({
                status: failureStatus,
                json: { detail: "Receipt scan interrupted" },
              });
            }
          } else heads++;
          return route.fulfill({
            json: {
              count: 2,
              results: [receipt(second ? "historic-tail" : "historic-head")],
              next: second
                ? null
                : "/api/events/?recovery=payments&recovery_cursor=tail",
              recovery_boundary: "receipt-scan-" + heads,
            },
          });
        }
        return route.fulfill({
          json: { results: [receipt("historic-head")], count: 2, next: null },
        });
      }
      if (url.pathname === "/api/events/has/")
        return route.fulfill({ json: true });
      if (url.pathname === "/api/events/unread_count/")
        return route.fulfill({ json: ownedUnreadCount(2) });
      return route.continue();
    });
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect
      .poll(() =>
        page.evaluate(() => Boolean((window as any).initialRecoverySettled)),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const module = "/src/lib/stores/eventNotifications.ts";
          const { eventNotifications } = await import(module);
          let ids: string[] = [];
          eventNotifications.subscribe(
            (state: any) => (ids = state.events.map((event: any) => event.id)),
          )();
          return ids;
        }),
      )
      .toEqual(["historic-head"]);
    expect(heads).toBe(failureStatus === 400 ? 2 : 1);
    expect(tails).toBe(2);
    // The unrendered tail is still acknowledged by the complete quiet scan.
    await emit(page, "historic-tail", "BOUGHT_TUZI");
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Payment received" }),
    ).toHaveCount(0);
  });
}

for (const stage of ["headers", "receipt-body", "metadata-body"] as const) {
  test(`a live credit interrupts stalled ${stage} recovery and rejects late results`, async ({
    page,
    request,
  }) => {
    let heldHeaders: Route | undefined;
    let holdHeaders = false;
    let unread = 0;
    await page.route("**/api/events/**", async (route) => {
      const url = new URL(route.request().url());
      if (holdHeaders && url.searchParams.get("recovery") === "payments") {
        holdHeaders = false;
        heldHeaders = route;
        return;
      }
      if (url.pathname === "/api/events/unread_count/")
        return route.fulfill({ json: ownedUnreadCount(unread) });
      return route.continue();
    });
    await page.addInitScript(() => {
      const nativeFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        const url = new URL(String(args[0]), location.href);
        const stage = (window as any).holdRecoveryBody;
        if (
          !(
            stage === "receipt-body" &&
            url.searchParams.get("recovery") === "payments"
          ) &&
          !(
            stage === "metadata-body" &&
            url.pathname === "/api/events/unread_count/"
          )
        )
          return response;
        (window as any).holdRecoveryBody = null;
        // Deliberately ignore the aborted fetch signal after headers, proving
        // the store rejects a late response body before any state mutation.
        const body = new ReadableStream({
          start(controller) {
            (window as any).heldRecoveryBody = controller;
          },
        });
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      };
    });
    await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=5`);
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const module = "/src/lib/stores/eventNotifications.ts";
          const { eventNotifications } = await import(module);
          let initialized = false;
          eventNotifications.subscribe((state: any) => {
            initialized = state.initialized;
          })();
          return initialized;
        }),
      )
      .toBe(true);
    await expect(page.getByTestId("billing-balance-value")).toHaveText("5");
    const draft = page.locator('input[name="maxPrice"]').first();
    await draft.fill("50");
    if (stage === "headers") holdHeaders = true;
    else
      await page.evaluate((value) => {
        (window as any).holdRecoveryBody = value;
      }, stage);
    await page.evaluate(() =>
      (window as any).purchaseSocket.onclose({ code: 1006 }),
    );
    if (stage === "headers")
      await expect.poll(() => Boolean(heldHeaders)).toBe(true);
    else
      await expect
        .poll(() =>
          page.evaluate(() => Boolean((window as any).heldRecoveryBody)),
        )
        .toBe(true);
    await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=25`);
    unread = 1;
    await emit(page, `credit-during-${stage}`, "BOUGHT_TUZI");
    await expect(page.getByTestId("billing-balance-value")).toHaveText("25", {
      timeout: 3000,
    });
    await expect(draft).toHaveValue("50");
    const late = {
      id: "late-aborted-history",
      type: "BOUGHT_TUZI",
      read: false,
      amount: 99,
      receiving_user: { username: "fixtureowner" },
      created_at: "2026-10-06T15:00:00Z",
    };
    const latePage = {
      results: [late],
      next: null,
      count: 1,
      recovery_boundary: "aborted-scan",
    };
    if (stage === "headers")
      await heldHeaders!.fulfill({ json: latePage }).catch(() => {});
    else
      await page.evaluate(
        (value) => {
          const controller = (window as any).heldRecoveryBody;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
          controller.close();
        },
        stage === "receipt-body" ? latePage : 999,
      );
    await emit(page, `credit-during-${stage}`, "BOUGHT_TUZI");
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Payment received — 2,500 2Z credited." }),
    ).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const module = "/src/lib/stores/eventNotifications.ts";
          const { eventNotifications } = await import(module);
          let result: any;
          eventNotifications.subscribe((state: any) => {
            result = {
              unread: state.unreadCount,
              late: state.events.some(
                (event: any) => event.id === "late-aborted-history",
              ),
            };
          })();
          return result;
        }),
      )
      .toEqual({ unread: 1, late: false });
    await expect(page.getByTestId("billing-balance-value")).toHaveText("25");
    await expect(draft).toHaveValue("50");
  });
}

for (const creditedBalance of ["15", "25"]) {
  test(`renewal guidance uses live balance ${creditedBalance} during and after a late old billing reload`, async ({
    page,
    request,
  }) => {
    await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=5`);
    await request.post(`${browserMockApiOrigin()}/__billing/renewal-summary`, {
      data: {
        status: "shortfall",
        balance: "5.000",
        total_upcoming: "20.000",
        shortfall: "15.000",
        horizon_days: 29,
      },
    });
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("billing-balance-value")).toHaveText("5");
    await expect(
      page.getByRole("alert").filter({ hasText: "Upcoming renewals" }),
    ).toContainText("Your balance is short by 15 2Z.");
    const draft = page.locator('input[name="maxPrice"]').first();
    await draft.fill("50");
    let block = true;
    const held: Route[] = [];
    let oldBody: Buffer | undefined;
    await page.route(
      "**/fixtureowner/dashboard/billing/__data.json**",
      async (route) => {
        if (!block) return route.continue();
        held.push(route);
        if (!oldBody) oldBody = await (await route.fetch()).body();
      },
    );
    await page.evaluate(async () => {
      const navigation = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((name) =>
          name.includes("@sveltejs/kit/src/runtime/client/client.js"),
        );
      if (!navigation)
        throw new Error("Loaded SvelteKit navigation runtime missing");
      const { invalidate } = await import(navigation);
      (window as any).heldRenewalReload = invalidate("account:balance");
    });
    await expect.poll(() => Boolean(oldBody)).toBe(true);
    await request.post(
      `${browserMockApiOrigin()}/__billing/balance?amount=${creditedBalance}`,
    );
    await emit(page, `renewal-credit-${creditedBalance}`, "BOUGHT_TUZI");
    await expect(page.getByTestId("billing-balance-value")).toHaveText(
      creditedBalance,
    );
    const currentCopy =
      creditedBalance === "25"
        ? "At today's prices, your balance covers the renewals scheduled in the next 29 days (20 2Z)."
        : "At today's prices, renewals scheduled in the next 29 days total 20 2Z. Your balance is short by 5 2Z.";
    await expect(page.getByText(currentCopy, { exact: true })).toBeVisible();
    await expect(draft).toHaveValue("50");
    // The first credit's billing reload is still held. Another real receipt
    // must refresh auth independently of that unresolved history loader.
    const finalBalance = creditedBalance === "25" ? "30" : "18";
    await request.post(
      `${browserMockApiOrigin()}/__billing/balance?amount=${finalBalance}`,
    );
    await emit(page, `renewal-second-credit-${creditedBalance}`, "BOUGHT_TUZI");
    await expect(page.getByTestId("billing-balance-value")).toHaveText(
      finalBalance,
    );
    const finalCopy =
      creditedBalance === "25"
        ? "At today's prices, your balance covers the renewals scheduled in the next 29 days (20 2Z)."
        : "At today's prices, renewals scheduled in the next 29 days total 20 2Z. Your balance is short by 2 2Z.";
    await expect(page.getByText(finalCopy, { exact: true })).toBeVisible();
    block = false;
    for (const route of held)
      await route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: oldBody!,
        })
        .catch(() => {});
    await page.evaluate(() => (window as any).heldRenewalReload);
    await expect(page.getByTestId("billing-balance-value")).toHaveText(
      finalBalance,
    );
    await expect(page.getByText(finalCopy, { exact: true })).toBeVisible();
    await expect(
      page.getByText("Your balance is short by 15 2Z.", { exact: false }),
    ).not.toBeVisible();
    await expect(draft).toHaveValue("50");
  });
}

for (const status of ["unknown", "malformed"]) {
  test(`a credit cannot turn an ${status} renewal summary into a coverage claim`, async ({
    page,
    request,
  }) => {
    await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=5`);
    await request.post(`${browserMockApiOrigin()}/__billing/renewal-summary`, {
      data: {
        status: status === "unknown" ? "unknown" : "shortfall",
        balance: "5.000",
        total_upcoming: "20.000",
        shortfall: status === "malformed" ? "invalid" : "15.000",
        horizon_days: 29,
      },
    });
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    await expect(
      page.getByText("We couldn't calculate your upcoming renewal total.", {
        exact: false,
      }),
    ).toBeVisible();
    await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=25`);
    await emit(page, `unknown-renewal-credit-${status}`, "BOUGHT_TUZI");
    await expect(page.getByTestId("billing-balance-value")).toHaveText("25");
    await expect(
      page.getByText("We couldn't calculate your upcoming renewal total.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("At today's prices, your balance covers", {
        exact: false,
      }),
    ).toHaveCount(0);
  });
}

for (const bulk of [false, true]) {
  test(`an earlier-dispatched ${bulk ? "bulk" : "single"} quote validates a later database spend after arrival`, async ({
    page,
    request,
  }) => {
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    // Route responses must not accidentally supply the newer balance and mask
    // a quote callback that failed to request its own postarrival auth read.
    await page.route(
      "**/fixtureowner/dashboard/billing/__data.json**",
      () => {},
    );
    await page.evaluate(async (bulk) => {
      const target = document.createElement("div");
      document.body.append(target);
      const svelteModule = "/tests/browser/svelte-runtime.ts",
        fixtureModule = "/tests/browser/purchase-balance-dialog-fixture.svelte";
      const [{ mount }, { default: Fixture }] = await Promise.all([
        import(svelteModule),
        import(fixtureModule),
      ]);
      mount(Fixture, { target, props: { bulk, holdQuote: true } });
    }, bulk);
    await expect
      .poll(() =>
        page.evaluate(() => Boolean((window as any).releaseDelayedQuote)),
      )
      .toBe(true);
    expect(
      await page.evaluate(
        () => (window as any).fixtureQuoteOwner.balance_snapshot,
      ),
    ).toMatch(/^\d+:\d+$/);
    await request.post(
      `${browserMockApiOrigin()}/__billing/balance?amount=74672.234`,
    );
    await emit(page, `quote-before-spend-${bulk}`, "BOUGHT_TUZI");
    await expect(page.getByTestId("billing-balance-value")).toHaveText(
      "74,672.23",
    );
    // The earlier request executes after the later auth read and another spend.
    await request.post(
      `${browserMockApiOrigin()}/__billing/balance?amount=5000`,
    );
    await page.evaluate(() => (window as any).releaseDelayedQuote());
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Balance 5000 2Z");
    await expect(dialog).toContainText("70000 2Z");
    await expect(
      dialog.getByRole("button", { name: "Refresh price and balance" }),
    ).toBeEnabled();
    const confirm = dialog.getByTestId(
      bulk ? "translate-into-confirm" : "translate-ai-confirm",
    );
    // Preserve the server quote decision; a balance-only reconciliation must
    // not alter the quoted affordability or submit on the user's behalf.
    if (bulk) await expect(confirm).toBeEnabled();
    else await expect(confirm).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as any).fixturePurchases ?? []),
    ).toEqual([]);
  });
}

test("paid-chat and page-vote notifications refresh the visible balance without a purchase receipt", async ({
  page,
  request,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  for (const [type, balance, read] of [
    ["ENCRYPTED_CHAT_REQUEST", "25", false],
    ["ENCRYPTED_CHAT_REQUEST", "20", true],
    ["PAGE_VOTE", "19", true],
  ] as const) {
    await request.post(
      `${browserMockApiOrigin()}/__billing/balance?amount=${balance}`,
    );
    await emit(page, `money-event-${type}-${balance}`, type, read);
    await expect(page.getByTestId("billing-balance-value")).toHaveText(balance);
  }
});

for (const growthBeforeCompletion of [false, true]) {
  test(`renewed vote UUIDs preserve pending reads and resolve growth ${growthBeforeCompletion ? "before" : "after"} read confirmation`, async ({
    page,
  }) => {
    const vote = (amount: number, read: boolean) => ({
      id: "renewable-vote",
      type: "PAGE_VOTE",
      amount,
      read,
      receiving_user: { username: "fixtureowner" },
      created_at: "2026-10-06T15:00:00Z",
    });
    let serverVote = vote(1, true),
      heldWrite: Route | undefined;
    await page.route("**/api/events/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/events/read/renewable-vote/") {
        heldWrite = route;
        return;
      }
      if (url.pathname === "/api/events/unread_count/")
        return route.fulfill({
          json: ownedUnreadCount(Number(!serverVote.read)),
        });
      if (url.pathname === "/api/events/has/")
        return route.fulfill({ json: true });
      if (url.pathname === "/api/events/")
        return route.fulfill({
          json:
            url.searchParams.get("recovery") === "payments"
              ? {
                  results: [],
                  next: null,
                  count: 0,
                  recovery_boundary: "vote-empty",
                }
              : { results: [serverVote], next: null, count: 1 },
        });
      return route.continue();
    });
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await page.waitForLoadState("networkidle");
    const state = () =>
      page.evaluate(async () => {
        const module = "/src/lib/stores/eventNotifications.ts";
        const { eventNotifications } = await import(module);
        let value: any;
        eventNotifications.subscribe((current: any) => (value = current))();
        return {
          event: value.events.find((e: any) => e.id === "renewable-vote"),
          unread: value.unreadCount,
        };
      });
    await expect.poll(async () => (await state()).event?.amount).toBe(1);
    const socketVote = async (amount: number) =>
      page.evaluate((amount) => {
        (window as any).purchaseSocket.onmessage({
          data: JSON.stringify({
            content: {
              id: "renewable-vote",
              type: "PAGE_VOTE",
              amount,
              read: false,
              receiving_user: { username: "fixtureowner" },
              created_at: "2026-10-06T15:00:00Z",
            },
          }),
        });
      }, amount);
    serverVote = vote(2, false);
    await socketVote(2);
    await expect.poll(async () => (await state()).event?.read).toBe(false);
    expect((await state()).unread).toBe(1);
    await page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      (window as any).heldVoteRead =
        eventNotifications.markRead("renewable-vote");
    });
    await expect.poll(() => Boolean(heldWrite)).toBe(true);
    if (growthBeforeCompletion) {
      serverVote = vote(3, false);
      await socketVote(3);
      expect((await state()).event.read).toBe(true);
    }
    serverVote = vote(growthBeforeCompletion ? 3 : 2, true);
    await heldWrite!.fulfill({ json: {} });
    await page.evaluate(() => (window as any).heldVoteRead);
    await expect.poll(async () => (await state()).event.read).toBe(true);
    if (!growthBeforeCompletion) {
      serverVote = vote(3, false);
      await socketVote(3);
      await expect.poll(async () => (await state()).event.read).toBe(false);
    }
    await socketVote(2);
    await socketVote(3);
    expect((await state()).event.amount).toBe(3);
    expect((await state()).event.read).toBe(growthBeforeCompletion);
    await page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      await eventNotifications.reconcile("fixtureowner");
    });
    expect((await state()).event.read).toBe(growthBeforeCompletion);
  });
}

for (const read of [false, true]) {
  test(`a first delayed ${read ? "read" : "unread"} credit refreshes auth after its receipt was loaded over HTTP`, async ({
    page,
    request,
  }) => {
    await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=5`);
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    const id = "http-before-socket-credit";
    const record = {
      id,
      type: "BOUGHT_TUZI",
      amount: 20,
      read,
      receiving_user: { username: "fixtureowner" },
      created_at: "2026-10-06T16:00:00Z",
    };
    await page.route("**/api/events/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/events/unread_count/")
        return route.fulfill({ json: ownedUnreadCount(Number(!read)) });
      if (url.pathname === "/api/events/has/")
        return route.fulfill({ json: true });
      if (url.pathname === "/api/events/" && !url.searchParams.has("recovery"))
        return route.fulfill({
          json: { count: 1, next: null, results: [record] },
        });
      return route.continue();
    });
    // A genuine normal feed read is quiet and does not settle the account.
    await page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      await eventNotifications.reconcile("fixtureowner");
    });
    await expect(page.getByTestId("billing-balance-value")).toHaveText("5");
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Payment received" }),
    ).toHaveCount(0);
    await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=25`);
    await emit(page, id, "BOUGHT_TUZI", read);
    await expect(page.getByTestId("billing-balance-value")).toHaveText("25");
    await emit(page, id, "BOUGHT_TUZI", read);
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Payment received — 2,500 2Z credited." }),
    ).toHaveCount(read ? 0 : 1);
    const rows = await page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      let value: any;
      eventNotifications.subscribe((state: any) => (value = state))();
      return value.events.filter(
        (event: any) => event.id === "http-before-socket-credit",
      );
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].read).toBe(read);
  });
}

for (const phase of ["headers", "body"] as const) {
  test(`a live credit preempts held internal auth ${phase} before the old request deadline`, async ({
    page,
    request,
  }) => {
    await initialRecoveryBarrier(page);
    await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=5`);
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect
      .poll(() =>
        page.evaluate(() => Boolean((window as any).initialRecoverySettled)),
      )
      .toBe(true);
    let held: Route | undefined;
    if (phase === "headers") {
      await page.route("**/api/auth/user/", (route) => {
        if (!held) {
          held = route;
          return;
        }
        return route.continue();
      });
    } else {
      await page.evaluate(() => {
        const native = window.fetch;
        let first = true;
        window.fetch = async (...args) => {
          const response = await native(...args);
          if (
            first &&
            new URL(String(args[0]), location.origin).pathname ===
              "/api/auth/user/"
          ) {
            first = false;
            const snapshot = await response.json();
            response.json = () =>
              new Promise((resolve) => {
                (window as any).releaseInternalAuthBody = () =>
                  resolve(snapshot);
              });
            (window as any).internalAuthBodyHeld = true;
          }
          return response;
        };
      });
    }
    await page.evaluate(async () => {
      const module = "/src/lib/stores/auth.ts";
      const { authStore } = await import(module);
      const native = authStore.checkAuth;
      authStore.checkAuth = (options = {}) => {
        const work = native(options);
        (window as any).heldInternalPhase ??= work;
        return work;
      };
      (window as any).retiredInternalAuthSocket = (
        window as any
      ).purchaseSocket;
      (window as any).purchaseSocket.onclose({ code: 1006 });
    });
    await expect
      .poll(() =>
        phase === "headers"
          ? Boolean(held)
          : page.evaluate(() => Boolean((window as any).internalAuthBodyHeld)),
      )
      .toBe(true);
    // Retired sockets deliberately reject messages. Deliver over the replacement
    // connection while the old internal auth request is still held.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).purchaseSocket !==
              (window as any).retiredInternalAuthSocket &&
            Boolean((window as any).purchaseSocket?.onmessage),
        ),
      )
      .toBe(true);
    await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=25`);
    await emit(page, "credit-during-internal-" + phase, "BOUGHT_TUZI");
    await expect(page.getByTestId("billing-balance-value")).toHaveText("25", {
      timeout: 3000,
    });
    if (phase === "headers")
      await held!.fulfill({
        json: { id: 4301, username: "fixtureowner", tuzis: "5" },
      });
    else await page.evaluate(() => (window as any).releaseInternalAuthBody());
    await page.evaluate(() => (window as any).heldInternalPhase);
    await expect(page.getByTestId("billing-balance-value")).toHaveText("25");
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Payment received — 2,500 2Z credited." }),
    ).toHaveCount(1);
  });
}

test("renewal summary retains its post-charge balance until a successful post-arrival auth read", async ({
  page,
  request,
}) => {
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=100`);
  await request.post(`${browserMockApiOrigin()}/__billing/renewal-summary`, {
    data: {
      status: "shortfall",
      balance: "20.000",
      total_upcoming: "30.000",
      shortfall: "10.000",
      horizon_days: 29,
    },
  });
  let failedReads = 0;
  let fail = true;
  await page.route("**/api/auth/user/", async (route) => {
    if (fail) {
      failedReads++;
      return route.fulfill({ status: 503, json: { detail: "Unavailable" } });
    }
    return route.continue();
  });
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("heading", { name: "Credits & Earnings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toHaveCount(0);
  await expect.poll(() => failedReads).toBeGreaterThan(0);
  await expect(
    page.getByRole("alert").filter({ hasText: "Upcoming renewals" }),
  ).toContainText("Your balance is short by 10 2Z.");
  await expect(
    page.getByText("At today's prices, your balance covers", { exact: false }),
  ).toHaveCount(0);
  const draft = page.locator('input[name="maxPrice"]').first();
  await draft.fill("50");
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=35`);
  fail = false;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts";
    const { authStore } = await import(module);
    await authStore.checkAuth({ fresh: true, silent: true });
  });
  await expect(page.getByTestId("billing-balance-value")).toHaveText("35");
  await expect(
    page.getByText(
      "At today's prices, your balance covers the renewals scheduled in the next 29 days (30 2Z).",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(draft).toHaveValue("50");
});

test("legacy cached database snapshot cannot block a fresh read after database restore", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000); // isolated store probe plus cold billing-route compilation
  await request.post(`${browserMockApiOrigin()}/__billing/balance?amount=20`);
  await page.addInitScript(() => {
    const balanceSnapshot = "999999999:0";
    (window as any).restoredAuthBaseline = balanceSnapshot;
    localStorage.setItem(
      "auth",
      JSON.stringify({
        status: "authenticated",
        isAuthenticated: true,
        creator: {
          id: 4301,
          username: "fixtureowner",
          tuzis: "100",
          balance_snapshot: balanceSnapshot,
        },
      }),
    );
  });
  // Load the store in a document without the app layout: the layout and
  // billing route both launch fresh checks that can correctly retire a probe.
  await page.route("**/healthz", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><script type="module" src="/@vite/client"></script>',
    }),
  );
  await page.goto("/healthz");
  const observed = await page.evaluate(async (loader) => {
    const { authStore } = await new Function(loader)();
    const baseline = (window as any).restoredAuthBaseline;
    const accepted = await authStore.checkAuth({
      fresh: true,
      silent: true,
    });
    let state: any;
    authStore.subscribe((value: any) => {
      state = value;
    })();
    return {
      accepted,
      baseline,
      status: state.status,
      actor: { id: state.creator?.id, username: state.creator?.username },
      balance: state.creator?.tuzis,
      liveSnapshot: state.creator?.balance_snapshot,
      persistedAfterSnapshot: JSON.parse(localStorage.getItem("auth")!).creator
        ?.balance_snapshot,
    };
  }, AUTH_STORE_LOADER);
  expect(observed).toMatchObject({
    accepted: true,
    baseline: "999999999:0",
    status: "authenticated",
    actor: { id: 4301, username: "fixtureowner" },
    balance: "20",
    persistedAfterSnapshot: undefined,
  });
  expect(observed.liveSnapshot).toMatch(/^\d+:\d+$/);
  expect(BigInt(observed.liveSnapshot.split(":")[0])).toBeLessThan(
    BigInt(observed.baseline.split(":")[0]),
  );
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(page.getByTestId("billing-balance-value")).toHaveText("20");
});

test("oldest recovery fills offline gaps with paced visible traversal and no routine rescans", async ({
  page,
}) => {
  await initialRecoveryBarrier(page);
  await page.addInitScript(() => {
    const Native = window.IntersectionObserver;
    window.IntersectionObserver = new Proxy(Native, {
      construct(target, args) {
        if (args[1]?.rootMargin === "200px 0px 200px 0px")
          (window as any).notificationObservers =
            ((window as any).notificationObservers || 0) + 1;
        return Reflect.construct(target, args);
      },
    });
  });
  let records = Array.from({ length: 36 }, (_, index) => ({
    id: `oldest-recovery-${index + 1}`,
    type: "BOUGHT_TUZI",
    amount: index + 1,
    read: true,
    receiving_user: { username: "fixtureowner" },
    created_at: new Date(Date.UTC(2026, 9, 6, 0, 0, 36 - index)).toISOString(),
  }));
  let holdOldPage = false;
  let held: Route | undefined;
  let pageTwoReads = 0;
  const olderPageTimes: number[] = [];
  await page.route("**/api/events/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/events/has/")
      return route.fulfill({ json: true });
    if (url.pathname === "/api/events/unread_count/")
      return route.fulfill({ json: ownedUnreadCount(0) });
    if (url.pathname !== "/api/events/") return route.continue();
    if (url.searchParams.has("recovery"))
      return route.fulfill({
        json: {
          results: [],
          next: null,
          count: 0,
          recovery_boundary: "mock-oldest-baseline",
        },
      });
    const number = Number(url.searchParams.get("page") || "1");
    if (number > 1) olderPageTimes.push(performance.now());
    if (number === 2) {
      pageTwoReads++;
      if (holdOldPage && !held) {
        held = route;
        return;
      }
    }
    return route.fulfill({
      json: {
        count: records.length,
        results: records.slice((number - 1) * 12, number * 12),
        next:
          number * 12 < records.length
            ? `/api/events/?page=${number + 1}&type=social`
            : null,
      },
    });
  });
  await page.goto("/fixtureowner/dashboard/notifications");
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as any).initialRecoverySettled)),
    )
    .toBe(true);
  const sort = page.getByRole("button", { name: "Sort notifications" });
  await expect(sort).toBeVisible();
  holdOldPage = true;
  await sort.click();
  await page.getByRole("option", { name: "Oldest first", exact: true }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.reconcile("fixtureowner");
  });
  const state = () =>
    page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      const { eventNotifications } = await import(module);
      let current: any;
      eventNotifications.subscribe((value: any) => {
        current = value;
      })();
      return {
        count: current.events.length,
        next: current.nextPageUrl,
        sort: current.sortOrder,
        loading: current.loadingMore,
      };
    });
  await expect
    .poll(state)
    .toEqual({ count: 36, next: null, sort: "oldest", loading: false });
  expect(pageTwoReads).toBeGreaterThanOrEqual(2);
  await expect(
    page.locator("article").filter({ hasText: "You bought" }).first(),
  ).toContainText("You bought 36 2Z.");
  await held!.fulfill({
    json: {
      count: 36,
      results: [{ ...records[12], id: "retired-page-row" }],
      next: "/api/events/?page=4&type=social",
    },
  });
  await expect
    .poll(state)
    .toEqual({ count: 36, next: null, sort: "oldest", loading: false });
  await expect(
    page.locator("article").filter({ hasText: "You bought" }).first(),
  ).toContainText("You bought 36 2Z.");
  const completedPageReads = pageTwoReads;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    // Join the completed user traversal before routine read-state recovery.
    await eventNotifications.setSortOrder("oldest");
    await eventNotifications.reconcile("fixtureowner");
    await eventNotifications.reconcile("fixtureowner");
    await eventNotifications.reconcile("fixtureowner");
  });
  expect(pageTwoReads).toBe(completedPageReads);
  expect((await state()).count).toBe(36);
  await expect(
    page.locator("article").filter({ hasText: "You bought" }).first(),
  ).toContainText("You bought 36 2Z.");
  const addOfflineArrivals = (prefix: string) => {
    records = [
      ...Array.from({ length: 24 }, (_, index) => ({
        ...records[0],
        id: `${prefix}-${index}`,
        type: "MADE_COMMENT",
        amount: 0,
        created_at: new Date(
          Date.UTC(2026, 9, 7, 0, 0, 24 - index),
        ).toISOString(),
      })),
      ...records,
    ];
  };
  addOfflineArrivals("offline-visible");
  const pacedStart = olderPageTimes.length;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    // Actual completed payment-history recovery signals reconnect, even when
    // the disconnected arrivals themselves are ordinary social notifications.
    await eventNotifications.reconcilePayments("fixtureowner");
    await eventNotifications.reconcilePayments("fixtureowner");
    await eventNotifications.reconcilePayments("fixtureowner");
  });
  await expect.poll(state).toEqual({
    count: 60,
    next: null,
    sort: "oldest",
    loading: false,
  });
  const pacedTimes = olderPageTimes.slice(pacedStart);
  expect(pacedTimes.length).toBeGreaterThanOrEqual(4);
  for (let index = 1; index < pacedTimes.length; index++) {
    expect(pacedTimes[index] - pacedTimes[index - 1]).toBeGreaterThan(200);
  }
  await page.evaluate(async () => {
    const runtime = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) =>
        name.includes("@sveltejs/kit/src/runtime/client/client.js"),
      );
    if (!runtime) throw new Error("Loaded navigation runtime missing");
    const { goto } = await import(runtime);
    await goto("/fixtureowner/dashboard/billing");
  });
  await expect(page).toHaveURL(/dashboard\/billing$/);
  addOfflineArrivals("offline-departed");
  const departedReads = olderPageTimes.length;
  await page.evaluate(async () => {
    const module = "/src/lib/stores/eventNotifications.ts";
    const { eventNotifications } = await import(module);
    await eventNotifications.reconcilePayments("fixtureowner");
  });
  expect((await state()).count).toBe(72);
  expect(olderPageTimes.length).toBe(departedReads);
  const observersBeforeReentry = await page.evaluate(
    () => (window as any).notificationObservers || 0,
  );
  holdOldPage = true;
  held = undefined;
  await page.evaluate(async () => {
    const runtime = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) =>
        name.includes("@sveltejs/kit/src/runtime/client/client.js"),
      );
    if (!runtime) throw new Error("Loaded navigation runtime missing");
    const { goto } = await import(runtime);
    await goto("/fixtureowner/dashboard/notifications");
  });
  await expect.poll(() => Boolean(held)).toBe(true);
  // Reentry installs scrolling after the head; it must not await the full
  // oldest traversal, so a held older body cannot strand the page observer.
  await expect
    .poll(() => page.evaluate(() => (window as any).notificationObservers || 0))
    .toBeGreaterThan(observersBeforeReentry);
  await held!.fulfill({
    json: {
      count: 84,
      results: records.slice(12, 24),
      next: "/api/events/?page=3&type=social",
    },
  });
  await expect.poll(state).toEqual({
    count: 84,
    next: null,
    sort: "oldest",
    loading: false,
  });
});

test("1000 notices cannot starve a payment or grow its actual DOM and retained queue", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    const { toast } = await import(module);
    const store = (await import(module)).toastPresentation;
    if (
      !(await new Promise<boolean>((resolve) => {
        const off = store.subscribe((value: { ready: boolean }) => {
          if (value.ready) {
            resolve(true);
            queueMicrotask(() => off());
          }
        });
      }))
    )
      throw new Error("Notice presentation not ready");
    (window as any).maximumToastNodes = 0;
    const observer = new MutationObserver(() => {
      (window as any).maximumToastNodes = Math.max(
        (window as any).maximumToastNodes,
        document.querySelectorAll("[data-sonner-toast]").length,
      );
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Hold this backlog to measure manual queue draining independently of expiry.
    for (let index = 0; index < 1000; index++)
      toast.info(`Generic notice ${index}`, { duration: Infinity });
    toast.error("Critical refusal during congestion");
  });
  await emit(page, "congested-credit", "BOUGHT_TUZI");
  const purchase = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Payment received" });
  await expect(purchase).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(3);
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Critical refusal during congestion" }),
  ).toBeVisible();
  const status = () =>
    page.evaluate(async () => {
      const module = "/src/lib/toast.ts";
      return (await import(module)).toastQueueStatus();
    });
  expect(await status()).toEqual({
    rendered: 3,
    queued: 50,
    urgentQueued: 0,
    overflow: 949,
    paymentQueued: false,
  });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(4500);
  await expect(purchase).toBeVisible();
  // Another committed receipt updates the summary, preserving both durable rows.
  await emit(page, "second-congested-credit", "BOUGHT_TUZI");
  await expect(purchase).toHaveCount(1);
  await expect(purchase).toContainText("Individual receipts remain");
  await emit(page, "second-congested-credit", "BOUGHT_TUZI");
  await expect(purchase).toHaveCount(1);
  await page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Generic notice 0" })
    .getByRole("button", { name: "Close notification" })
    .click();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Generic notice 1" })
      .first(),
  ).toBeVisible();
  expect((await status()).queued).toBe(49);
  expect(
    await page.evaluate(() => (window as any).maximumToastNodes),
  ).toBeLessThanOrEqual(3);
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    const { toast } = await import(module);
    // Explicitly dismiss retained generic entries; the overflow warning survives.
    for (const notice of toast.getActiveToasts())
      if (!String(notice.id).startsWith("payment-summary"))
        toast.dismiss(notice.id);
  });
  await expect(purchase).toBeVisible();
});

test("sustained upload and event outcomes bound mounted notices and retain urgent acknowledgements", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async (loader) => {
        let ready = false;
        const { toastPresentation } = await new Function(loader)();
        toastPresentation.subscribe(
          (value: { ready: boolean }) => (ready = value.ready),
        )();
        return ready;
      }, TOAST_LOADER),
    )
    .toBe(true);

  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const heap = async () => {
    const metrics = await session.send("Performance.getMetrics");
    return metrics.metrics.find(
      (metric: { name: string }) => metric.name === "JSHeapUsedSize",
    )?.value as number | undefined;
  };
  const heapBefore = await heap();
  await page.evaluate(() => {
    (window as any).notificationDomHighWater = 0;
    new MutationObserver(() => {
      (window as any).notificationDomHighWater = Math.max(
        (window as any).notificationDomHighWater,
        document.querySelectorAll("[data-sonner-toast]").length,
      );
    }).observe(document.body, { childList: true, subtree: true });
  });

  let uploadRequests = 0;
  await page.route("**/api/uploads/limits/", (route) =>
    route.fulfill({
      json: {
        tuzis: 0,
        max_bytes: 1024 * 1024,
        tiers: [{ min_tuzis: 0, max_bytes: 1024 * 1024 }],
      },
    }),
  );
  await page.route("**/uploads/handle", (route) => {
    uploadRequests++;
    return route.fulfill({ status: 500, json: { detail: "Fixture refusal" } });
  });

  const timing = await page.evaluate(
    async ({ toastLoader, eventsLoader }) => {
      const started = performance.now();
      const [{ toast }, { eventNotifications }] = await Promise.all([
        new Function(toastLoader)(),
        new Function(eventsLoader)(),
      ]);
      for (let index = 0; index < 400; index++) {
        const id = `retention-event-${index}`;
        eventNotifications.addIncomingEvent({
          id,
          type: "PAGE_MENTION",
          amount: 1,
          read: false,
          receiving_user: { username: "fixtureowner" },
          contributor: { username: "sender" },
          created_at: new Date().toISOString(),
        } as any);
        toast.info("New activity on your account.", { id });
      }
      (window as any).uploadBurstStarted = performance.now();
      const emittedMs = performance.now() - started;
      const timerStarted = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        emittedMs,
        timerDelayMs: performance.now() - timerStarted,
      };
    },
    { toastLoader: TOAST_LOADER, eventsLoader: EVENT_NOTIFICATIONS_LOADER },
  );
  await page.evaluate(
    async ({ svelteLoader, uploaderLoader }) => {
      const [{ mount }, { default: MediaUploader }] = await Promise.all([
        new Function(svelteLoader)(),
        new Function(uploaderLoader)(),
      ]);
      const target = document.createElement("div");
      target.id = "notification-retention-uploader";
      document.body.append(target);
      mount(MediaUploader, { target });
    },
    { svelteLoader: SVELTE_LOADER, uploaderLoader: MEDIA_UPLOADER_LOADER },
  );
  await page
    .locator('#notification-retention-uploader input[type="file"]')
    .setInputFiles(
      Array.from({ length: 80 }, (_, index) => ({
        name: `retention-upload-${index}.png`,
        mimeType: "image/png",
        buffer: Buffer.from("small synthetic upload"),
      })),
    );
  await expect.poll(() => uploadRequests, { timeout: 30_000 }).toBe(80);
  const uploadElapsedMs = await page.evaluate(
    () => performance.now() - (window as any).uploadBurstStarted,
  );
  const retention = await page.evaluate(async (loader) => {
    const { toast, toastQueueStatus } = await new Function(loader)();
    return {
      vendorActive: toast.getActiveToasts().length,
      queue: toastQueueStatus(),
    };
  }, TOAST_LOADER);
  const heapAfter = await heap();
  const observed = await page.evaluate(() => ({
    mountedNow: document.querySelectorAll("[data-sonner-toast]").length,
    mountedHighWater: (window as any).notificationDomHighWater,
  }));
  const eventCount = await page.evaluate(async (loader) => {
    let count = 0;
    (await new Function(loader)()).eventNotifications.subscribe(
      (state: { events: unknown[] }) => (count = state.events.length),
    )();
    return count;
  }, EVENT_NOTIFICATIONS_LOADER);
  const metrics = {
    environment: {
      userAgent: await page.evaluate(() => navigator.userAgent),
      viewport: await page.evaluate(() => `${innerWidth}x${innerHeight}`),
      node: process.version,
    },
    emitted: { incomingEvents: 400, uploadFailures: uploadRequests },
    elapsedMs: timing.emittedMs,
    uploadElapsedMs,
    uploadRequests,
    zeroDelayTimerMs: timing.timerDelayMs,
    retainedEventRows: eventCount,
    sonnerActiveRecords: retention.vendorActive,
    queue: retention.queue,
    mountedToastNodes: observed,
    jsHeapUsedBytes: { before: heapBefore, after: heapAfter },
  };
  console.log(`NOTIFICATION_RETENTION_METRICS ${JSON.stringify(metrics)}`);
  expect(retention.vendorActive).toBeLessThanOrEqual(3);
  expect(retention.queue.queued).toBeGreaterThanOrEqual(75);
  expect(retention.queue.urgentQueued).toBeGreaterThanOrEqual(75);
  expect(retention.queue.overflow).toBeGreaterThan(0);
  expect(eventCount).toBe(400);
  expect(observed.mountedHighWater).toBeLessThanOrEqual(3);
  expect(observed.mountedNow).toBeLessThanOrEqual(3);

  // A distinct urgent outcome beyond the old 50-item cap remains queued,
  // rather than being represented only by the routine-overflow count.
  await page.evaluate(async (loader) => {
    const { toast } = await new Function(loader)();
    toast.error("Final upload outcome remains queued", {
      id: "final-upload-outcome",
    });
  }, TOAST_LOADER);
  expect(
    await page.evaluate(async (loader) => {
      return (await new Function(loader)()).toastQueueStatus().queued;
    }, TOAST_LOADER),
  ).toBeGreaterThanOrEqual(76);
  await session.detach();
});

test("routine overflow exposes an accessible link to durable notification history", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(async (loader) => {
    const { toast } = await new Function(loader)();
    for (let index = 0; index < 58; index++)
      toast.info(`Routine overflow ${index}`, {
        id: `routine-overflow-${index}`,
      });
    // Remove retained routine entries by ID to free their presentation slots;
    // the independent aggregate remains and must expose the review action.
    for (let index = 0; index < 58; index++)
      toast.dismiss(`routine-overflow-${index}`);
  }, TOAST_LOADER);
  const overflow = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "additional notices could not be displayed" });
  await expect(overflow).toBeVisible();
  const review = overflow.getByRole("button", {
    name: "Review notifications",
    exact: true,
  });
  await expect(review).toBeVisible();
  await review.click();
  await expect(page).toHaveURL(/\/fixtureowner\/dashboard\/notifications/);
});

test("account generations clear congestion and reject late A to B to A private outcomes", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    const { toast, captureAccountToast } = await import(module);
    const scoped = captureAccountToast();
    (window as any).latePrivateOutcome = () =>
      scoped.success("Old private payment outcome");
    toast.promise(
      new Promise((resolve) => ((window as any).oldPromiseResolve = resolve)),
      {
        id: "reused-progress",
        loading: "Old private progress",
        success: "Old private promise outcome",
      },
    );
  });
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Old private progress" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts",
      { toast } = await import(module);
    const old = toast
      .getActiveToasts()
      .find((notice: any) => notice.id === "reused-progress");
    if (
      typeof old?.onDismiss !== "function" ||
      typeof old?.onAutoClose !== "function"
    )
      throw new Error("Actual old callbacks were not captured");
    (window as any).lateOldDismissal = old.onDismiss;
    (window as any).lateOldAutoClose = old.onAutoClose;
    for (let index = 0; index < 1000; index++)
      toast.error(`Old account notice ${index}`);
  });
  await emit(page, "identity-credit", "BOUGHT_TUZI");
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Payment received" }),
  ).toBeVisible();
  // A same-ID balance read must not clear the credit acknowledgement.
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts";
    await (
      await import(module)
    ).authStore.checkAuth({ force: true, fresh: true, silent: true });
  });
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Payment received" }),
  ).toBeVisible();
  let account = { id: 8124, username: "other-account", tuzis: "50" };
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({ json: account }),
  );
  const read = () =>
    page.evaluate(async () => {
      const module = "/src/lib/stores/auth.ts";
      await (
        await import(module)
      ).authStore.checkAuth({ force: true, fresh: true, silent: true });
    });
  await read();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  account = { id: 4301, username: "fixtureowner", tuzis: "64672.234" };
  await read();
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    (await import(module)).toast.success("Current receipt with reused ID", {
      id: "reused-progress",
    });
  });
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Current receipt with reused ID" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).latePrivateOutcome();
    (window as any).oldPromiseResolve();
    (window as any).lateOldDismissal({ id: "reused-progress" });
    (window as any).lateOldAutoClose({ id: "reused-progress" });
  });
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(async () => {
      const module = "/src/lib/toast.ts";
      return (await import(module)).toastQueueStatus();
    }),
  ).toEqual({
    rendered: 1,
    queued: 0,
    urgentQueued: 0,
    overflow: 0,
    paymentQueued: false,
  });
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Current receipt with reused ID" }),
  ).toBeVisible();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: /Old private/ }),
  ).toHaveCount(0);
  await page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Current receipt with reused ID" })
    .getByRole("button", { name: "Close notification" })
    .click();
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    (await import(module)).toast.success("Welcome to the current account");
  });
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Welcome to the current account" }),
  ).toBeVisible();
  const status = await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    return (await import(module)).toastQueueStatus();
  });
  expect(status.queued).toBe(0);
  expect(status.overflow).toBe(0);
});

test("a real donation finishing after A to B to A cannot announce the old private outcome", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await billingInitialActorBarrier(page, "fixtureowner");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  let held: Route | undefined;
  await page.route("**/api/tuzis/donate-idempotent/recipient", (route) => {
    held = route;
  });
  await page.evaluate(async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const svelteModule = "/tests/browser/svelte-runtime.ts";
    const donateModule = "/src/lib/components/profile/ProfileDonate.svelte";
    const [{ mount }, { default: Donate }] = await Promise.all([
      import(svelteModule),
      import(donateModule),
    ]);
    mount(Donate, {
      target,
      props: {
        creator: { id: 8801, username: "recipient", full_name: "Recipient" },
      },
    });
  });
  await page.getByRole("button", { name: "Support", exact: true }).click();
  await page.getByRole("button", { name: "Share 5 2Z", exact: true }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  let account = { id: 8124, username: "other-account", tuzis: "50" };
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({ json: account }),
  );
  const read = () =>
    page.evaluate(async () => {
      const module = "/src/lib/stores/auth.ts";
      await (
        await import(module)
      ).authStore.checkAuth({ force: true, fresh: true, silent: true });
    });
  await read();
  account = { id: 4301, username: "fixtureowner", tuzis: "64672.234" };
  await read();
  await held!.fulfill({ json: { replayed: false } });
  await page.waitForTimeout(500);
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Shared 5" }),
  ).toHaveCount(0);
});

test("action and cancel buttons reclaim presentation slots while prevented actions stay open", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    const { toast } = await import(module);
    toast.info("First actionable outcome", {
      action: { label: "Review first", onClick: () => {} },
    });
    toast.info("Second actionable outcome", {
      cancel: { label: "Cancel second", onClick: () => {} },
    });
    toast.info("Third routine outcome");
    toast.error("Queued critical refusal");
  });
  await page.getByRole("button", { name: "Review first", exact: true }).click();
  await page
    .getByRole("button", { name: "Cancel second", exact: true })
    .click();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Queued critical refusal" }),
  ).toBeVisible();
  const third = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Third routine outcome" });
  await expect(third).toBeVisible();
  await third.getByRole("button", { name: "Close notification" }).click();
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    const { toast } = await import(module);
    toast.info("Action stays pending", {
      action: {
        label: "Keep pending",
        onClick: (event: MouseEvent) => event.preventDefault(),
      },
    });
    toast.info("Wait behind the pending action");
  });
  await page.getByRole("button", { name: "Keep pending", exact: true }).click();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Action stays pending" }),
  ).toBeVisible();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Wait behind the pending action" }),
  ).toHaveCount(0);
});

test("a real expired-session vote still explains the failure after private notices clear", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.route("**/api/comments/expired-vote/vote/", (route) =>
    route.fulfill({ status: 401, json: { detail: "Session expired" } }),
  );
  await page.evaluate(async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const svelteModule = "/tests/browser/svelte-runtime.ts";
    const voteModule = "/src/lib/components/comments/CommentVote.svelte";
    const [{ mount }, { default: Vote }] = await Promise.all([
      import(svelteModule),
      import(voteModule),
    ]);
    mount(Vote, {
      target,
      props: { comment: { uuid: "expired-vote", tuzis: 1 } },
    });
  });
  await page.getByRole("button", { name: "Upvote", exact: true }).click();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: genericExpiryGuidance }),
  ).toBeVisible();
  await page.waitForTimeout(4500);
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: genericExpiryGuidance }),
  ).toBeVisible();
});

test("generated-client expired-session donation gives anonymous guidance without private refusal text", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.route("**/api/tuzis/donate-idempotent/recipient", (route) =>
    route.fulfill({
      status: 401,
      json: { detail: "Private recipient balance rejected: 12345" },
    }),
  );
  await page.evaluate(async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const svelteModule = "/tests/browser/svelte-runtime.ts",
      donateModule = "/src/lib/components/profile/ProfileDonate.svelte";
    const [{ mount }, { default: Donate }] = await Promise.all([
      import(svelteModule),
      import(donateModule),
    ]);
    mount(Donate, {
      target,
      props: {
        creator: { id: 8801, username: "recipient", full_name: "Recipient" },
      },
    });
  });
  await page.getByRole("button", { name: "Support", exact: true }).click();
  await page.getByRole("button", { name: "Share 5 2Z", exact: true }).click();
  const guidance = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Sign in again before continuing" });
  await expect(guidance).toBeVisible();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: /Private recipient|12345/ }),
  ).toHaveCount(0);
  await page.waitForTimeout(4500);
  await expect(guidance).toBeVisible();
});

test("a warning cannot withhold a paid failure when a presentation slot is free", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    const { toast } = await import(module);
    toast.warning("Microphone permission warning");
    toast.error("Donation outcome uncertain — check history before retrying");
  });
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Microphone permission warning" }),
  ).toBeVisible();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Donation outcome uncertain" }),
  ).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(2);
});

test("a vote begun while identity resolves announces a refusal under its resolved actor", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  let auth: Route | undefined;
  await page.route("**/api/auth/user/", (route) => {
    auth = route;
  });
  await page.route("**/api/comments/hydrating-vote/vote/", (route) =>
    route.fulfill({
      status: 500,
      json: { message: "Hydrated vote was refused" },
    }),
  );
  await page.evaluate(async () => {
    const authModule = "/src/lib/stores/auth.ts",
      svelteModule = "/tests/browser/svelte-runtime.ts",
      voteModule = "/src/lib/components/comments/CommentVote.svelte";
    const { authStore } = await import(authModule);
    authStore.hydrateFromSession(null);
    (window as any).voteHydration = authStore.checkAuth({
      force: true,
      fresh: true,
      silent: true,
    });
    const target = document.createElement("div");
    document.body.append(target);
    const [{ mount }, { default: Vote }] = await Promise.all([
      import(svelteModule),
      import(voteModule),
    ]);
    mount(Vote, {
      target,
      props: { comment: { uuid: "hydrating-vote", tuzis: 1 } },
    });
  });
  await expect.poll(() => Boolean(auth)).toBe(true);
  await page.getByRole("button", { name: "Upvote", exact: true }).click();
  await auth!.fulfill({
    json: { id: 4301, username: "fixtureowner", tuzis: "64672.234" },
  });
  const notice = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Hydrated vote was refused" });
  await expect(notice).toBeVisible();
  await page.waitForTimeout(4500);
  await expect(notice).toBeVisible();
});

test("an actionable result postpones routine presentation without acknowledging it or evicting important notices", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts",
      { toast } = await import(module);
    (window as any).routineAcknowledged = 0;
    toast.success("Routine work started", {
      onDismiss: () => (window as any).routineAcknowledged++,
    });
    toast.warning("Important storage warning");
  });
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(2);
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts",
      { toast } = await import(module);
    toast.success("Important translation ready", {
      action: { label: "Review priority", onClick: () => {} },
    });
  });
  await expect(
    page.getByRole("button", { name: "Review priority", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Important storage warning" }),
  ).toBeVisible();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Routine work started" }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).routineAcknowledged)).toBe(
    0,
  );
  await emit(page, "priority-reclamation-credit", "BOUGHT_TUZI");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Review priority", exact: true })
    .click();
  const routine = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Routine work started" });
  await expect(routine).toBeVisible();
  expect(await page.evaluate(() => (window as any).routineAcknowledged)).toBe(
    0,
  );
  await routine.getByRole("button", { name: "Close notification" }).click();
  expect(await page.evaluate(() => (window as any).routineAcknowledged)).toBe(
    1,
  );
});

test("a saturated urgent queue cannot hide the actual outgoing payment refusal or leak it across accounts", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/lib/toast.ts",
          { toastPresentation } = await import(module);
        let ready = false;
        toastPresentation.subscribe(
          (value: { ready: boolean }) => (ready = value.ready),
        )();
        return ready;
      }),
    )
    .toBe(true);
  await page.route("**/api/tuzis/donate-idempotent/recipient", (route) =>
    route.fulfill({
      status: 500,
      json: {
        detail:
          "Payment outcome uncertain. Check the transfer before retrying.",
      },
    }),
  );
  await page.evaluate(async () => {
    const toastModule = "/src/lib/toast.ts",
      svelteModule = "/tests/browser/svelte-runtime.ts",
      donateModule = "/src/lib/components/profile/ProfileDonate.svelte";
    const { toast } = await import(toastModule);
    for (let index = 0; index < 52; index++)
      toast.error(`Upload failure ${index}`);
    const target = document.createElement("div");
    document.querySelector("main")!.prepend(target);
    const [{ mount }, { default: Donate }] = await Promise.all([
      import(svelteModule),
      import(donateModule),
    ]);
    mount(Donate, {
      target,
      props: {
        creator: { id: 8801, username: "recipient", full_name: "Recipient" },
      },
    });
  });
  expect(
    await page.evaluate(async () => {
      const module = "/src/lib/toast.ts";
      return (await import(module)).toastQueueStatus();
    }),
  ).toEqual({
    rendered: 2,
    queued: 50,
    urgentQueued: 50,
    overflow: 0,
    paymentQueued: false,
  });
  await page.getByRole("button", { name: "Support", exact: true }).click();
  await page.getByRole("button", { name: "Share 5 2Z", exact: true }).click();
  const warning = page.getByTestId("payment-outcome-error");
  await expect(warning).toHaveText(
    "Payment outcome uncertain. Check the transfer before retrying.",
  );
  await expect(warning).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(2);
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({
      json: { id: 8124, username: "other-account", tuzis: "50" },
    }),
  );
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts";
    await (
      await import(module)
    ).authStore.checkAuth({ force: true, fresh: true, silent: true });
  });
  await expect(warning).toHaveCount(0);
});

test("identical urgent repeats coalesce while distinct outcomes and account isolation remain intact", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(async (loader) => {
    const { setToastAccount, toast } = await new Function(loader)();
    setToastAccount("urgent-repeat-account", "repeat-owner");
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (let index = 0; index < 20; index++)
      toast.error("Upload failed while offline");
    toast.warning("A different upload needs attention");
    toast.error("Confirm upload outcome", {
      action: { label: "Check batch A", onClick: () => {} },
    });
    toast.error("Confirm upload outcome", {
      action: { label: "Check batch B", onClick: () => {} },
    });
  }, TOAST_LOADER);

  const repeated = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Upload failed while offline (×20)" });
  await expect(repeated).toBeVisible();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "A different upload needs attention" }),
  ).toBeVisible();
  expect(
    await page.evaluate(async (loader) => {
      const { toastQueueStatus } = await new Function(loader)();
      return toastQueueStatus();
    }, TOAST_LOADER),
  ).toMatchObject({ rendered: 2, queued: 2, urgentQueued: 2 });

  await page.evaluate(async (loader) => {
    const { setToastAccount, toast } = await new Function(loader)();
    setToastAccount("different-account", "other-owner");
    await new Promise((resolve) => setTimeout(resolve, 300));
    toast.error("Upload failed while offline");
  }, TOAST_LOADER);
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Upload failed while offline" }),
  ).toBeVisible();
  await expect(repeated).toHaveCount(0);
  expect(
    await page.evaluate(async (loader) => {
      const { toastQueueStatus } = await new Function(loader)();
      return toastQueueStatus();
    }, TOAST_LOADER),
  ).toMatchObject({ rendered: 1, queued: 0, urgentQueued: 0, overflow: 0 });
});

test("explicit urgent IDs stay separate from no-ID repeats in either call order", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();

  const noIdFirst = await page.evaluate(async (loader) => {
    const { setToastAccount, toast } = await new Function(loader)();
    setToastAccount("explicit-id-after-no-id", "repeat-owner");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const implicit = toast.error("Same urgent message");
    const explicit = toast.error("Same urgent message", {
      id: "explicit-after-no-id",
    });
    const explicitRepeat = toast.error("Same urgent message", {
      id: "explicit-after-no-id",
    });
    const implicitRepeat = toast.error("Same urgent message");
    return {
      implicit,
      explicit,
      explicitRepeat,
      implicitRepeat,
    };
  }, TOAST_LOADER);
  expect(noIdFirst.implicit).not.toBe(noIdFirst.explicit);
  expect(noIdFirst.explicitRepeat).toBe(noIdFirst.explicit);
  expect(noIdFirst.implicitRepeat).toBe(noIdFirst.implicit);
  await expect
    .poll(() =>
      page.evaluate(async (loader) => {
        const { toastQueueStatus } = await new Function(loader)();
        return toastQueueStatus();
      }, TOAST_LOADER),
    )
    .toMatchObject({ rendered: 2, queued: 0 });
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Same urgent message (×2)" }),
  ).toHaveCount(1);
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Same urgent message" }),
  ).toHaveCount(2);

  const explicitFirst = await page.evaluate(async (loader) => {
    const { setToastAccount, toast } = await new Function(loader)();
    setToastAccount("explicit-id-before-no-id", "repeat-owner");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const zero = toast.error("Zero-ID outcome", { id: 0 });
    const zeroImplicit = toast.error("Zero-ID outcome");
    const zeroRepeat = toast.error("Zero-ID outcome", { id: 0 });
    const empty = toast.error("Empty-ID outcome", { id: "" });
    const emptyImplicit = toast.error("Empty-ID outcome");
    const emptyRepeat = toast.error("Empty-ID outcome", { id: "" });
    return {
      zero,
      zeroImplicit,
      zeroRepeat,
      empty,
      emptyImplicit,
      emptyRepeat,
    };
  }, TOAST_LOADER);
  expect(explicitFirst.zero).toBe(0);
  expect(explicitFirst.zeroRepeat).toBe(0);
  expect(explicitFirst.zeroImplicit).not.toBe(explicitFirst.zero);
  expect(explicitFirst.empty).toBe("");
  expect(explicitFirst.emptyRepeat).toBe("");
  expect(explicitFirst.emptyImplicit).not.toBe(explicitFirst.empty);
  await expect
    .poll(() =>
      page.evaluate(async (loader) => {
        const { toastQueueStatus } = await new Function(loader)();
        return toastQueueStatus();
      }, TOAST_LOADER),
    )
    .toMatchObject({ rendered: 2, queued: 2, urgentQueued: 2 });
});

test("reclaiming a rendered routine overflow notice preserves its aggregate count", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.evaluate(async (loader) => {
    const { toast } = await new Function(loader)();
    for (let index = 0; index < 1000; index++)
      toast.info(`Initial notice ${index}`, { id: `initial-${index}` });
    for (let index = 0; index < 1000; index++)
      toast.dismiss(`initial-${index}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (let index = 0; index < 51; index++)
      toast.info(`Later notice ${index}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }, TOAST_LOADER);
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "additional notices could not be displayed" }),
  ).toBeVisible();
  expect(
    await page.evaluate(async (loader) => {
      const { toastQueueStatus } = await new Function(loader)();
      return toastQueueStatus();
    }, TOAST_LOADER),
  ).toMatchObject({ rendered: 1, queued: 50, overflow: 1 });
  await page.evaluate(async (loader) => {
    const { toast } = await new Function(loader)();
    toast.error("First actionable outcome");
    toast.error("New actionable outcome");
  }, TOAST_LOADER);
  const status = await page.evaluate(async (loader) => {
    const { toastQueueStatus } = await new Function(loader)();
    return toastQueueStatus();
  }, TOAST_LOADER);
  expect(status).toMatchObject({ queued: 51, urgentQueued: 1 });
  expect(status.overflow).toBeGreaterThanOrEqual(949);
});

test("explicit upload retry after reauthentication uses the current account notice scope", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  let attempts = 0;
  await page.route("**/uploads/handle", (route) =>
    route.fulfill(
      ++attempts === 1
        ? { status: 500, json: { detail: "Upload refused" } }
        : {
            json: {
              url: "https://example.test/retry.png",
              mime_type: "image/png",
            },
          },
    ),
  );
  await page.evaluate(async () => {
    const target = document.createElement("div");
    target.id = "retry-uploader";
    document.body.append(target);
    const svelteModule = "/tests/browser/svelte-runtime.ts",
      uploaderModule = "/src/lib/components/media/MediaUploader.svelte";
    const [{ mount }, { default: Uploader }] = await Promise.all([
      import(svelteModule),
      import(uploaderModule),
    ]);
    mount(Uploader, { target });
  });
  await page.locator('#retry-uploader input[type="file"]').setInputFiles({
    name: "retry.png",
    mimeType: "image/png",
    buffer: Buffer.from("test-image"),
  });
  const retry = page.getByRole("button", {
    name: "Retry retry.png",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts",
      { authStore } = await import(module);
    authStore.hydrateFromSession(null);
  });
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts";
    await (
      await import(module)
    ).authStore.checkAuth({ force: true, fresh: true, silent: true });
  });
  await retry.click();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "retry.png uploaded" }),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

for (const status of [200, 402]) {
  for (const reauthenticate of [false, true]) {
    test(`a held Converse ${status} response preserves replay protection ${reauthenticate ? "after reauthentication" : "across accounts"}`, async ({
      page,
    }) => {
      await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
      await billingInitialActorBarrier(page, "fixtureowner");
      await expect(
        page.getByRole("img", { name: "Zcash payment QR code" }),
      ).toBeVisible();
      let held: Route | undefined;
      await page.route("**/api/comments/", (route) => {
        if (route.request().method() === "POST") held = route;
        else return route.fallback();
      });
      await page.evaluate(async () => {
        const target = document.createElement("div");
        target.id = "identity-composer";
        document.body.append(target);
        const svelteModule = "/tests/browser/svelte-runtime.ts",
          composerModule =
            "/src/lib/components/converse/ConverseComposer.svelte",
          intentModule = "/src/lib/subscribe-idempotency.js";
        const [{ mount }, { default: Composer }, { intentIdempotencyKey }] =
          await Promise.all([
            import(svelteModule),
            import(composerModule),
            import(intentModule),
          ]);
        (window as any).heldPostedEvents = 0;
        mount(Composer, {
          target,
          events: { posted: () => (window as any).heldPostedEvents++ },
        });
        const base = {
          action: "comment",
          resource: "/api/comments/",
          amount: "1",
          intent: JSON.stringify({
            content: "Cross-account held post",
            tuzis: 1,
          }),
        };
        const identity = (actor: string) => ({ actor, ...base });
        (window as any).actorStorageName = (actor: string) =>
          `f2z:intent:${encodeURIComponent(JSON.stringify(identity(actor)))}`;
        intentIdempotencyKey(identity("other-account"));
        (window as any).otherActorRetry = localStorage.getItem(
          (window as any).actorStorageName("other-account"),
        );
      });
      await page
        .locator("#identity-composer textarea")
        .fill("Cross-account held post");
      await page
        .locator("#identity-composer")
        .getByRole("button", { name: "Post", exact: true })
        .click();
      await expect.poll(() => Boolean(held)).toBe(true);
      expect(
        await page.evaluate(() =>
          localStorage.getItem(
            (window as any).actorStorageName("fixtureowner"),
          ),
        ),
      ).not.toBeNull();
      let serverActor = {
        id: 8124,
        username: "other-account",
        tuzis: "50",
      };
      await page.route("**/api/auth/user/", (route) =>
        route.fulfill({ json: serverActor }),
      );
      await billingFreshActorBarrier(page, "other-account");
      if (reauthenticate) {
        // Establish A on the server before exchanging credentials. Keeping
        // this endpoint as B could legitimately restore B during the retry.
        serverActor = { id: 4301, username: "fixtureowner", tuzis: "500" };
        await page.route("**/api/auth/login/", (route) =>
          route.fulfill({ json: {} }),
        );
        expect(
          await page.evaluate(async () => {
            const module = "/src/lib/stores/auth.ts";
            const result = await (
              await import(module)
            ).authStore.loginOnly("fixtureowner", "fixture-password");
            return result.success;
          }),
        ).toBe(true);
        await billingFreshActorBarrier(page, "fixtureowner");
      } else
        await page
          .locator("#identity-composer textarea")
          .fill("Other account draft stays here");
      await held!.fulfill(
        status === 200
          ? {
              json: {
                uuid: "held-original-actor-post",
                content: "Cross-account held post",
                tuzis: 1,
              },
            }
          : {
              status: 402,
              json: {
                code: "insufficient_funds",
                cost: "1",
                balance: "0",
                shortfall: "1",
                action: "comment",
              },
            },
      );
      if (status === 402) {
        await expect
          .poll(() =>
            page.evaluate(() =>
              localStorage.getItem(
                (window as any).actorStorageName("fixtureowner"),
              ),
            ),
          )
          .toBeNull();
      } else {
        await expect(
          page
            .locator("#identity-composer")
            .getByRole("button", { name: "Post", exact: true }),
        ).toBeEnabled();
        expect(
          await page.evaluate(() =>
            localStorage.getItem(
              (window as any).actorStorageName("fixtureowner"),
            ),
          ),
        ).not.toBeNull();
      }
      expect(
        await page.evaluate(
          () =>
            localStorage.getItem(
              (window as any).actorStorageName("other-account"),
            ) === (window as any).otherActorRetry,
        ),
      ).toBe(true);
      await expect(
        page.locator("[data-sonner-toast]").filter({ hasText: /^Posted$/ }),
      ).toHaveCount(0);
      await expect(page.getByTestId("payment-outcome-error")).toHaveCount(0);
      await expect(page.locator("#identity-composer textarea")).toHaveValue(
        reauthenticate
          ? "Cross-account held post"
          : "Other account draft stays here",
      );
      expect(await page.evaluate(() => (window as any).heldPostedEvents)).toBe(
        0,
      );
      await expect(page.locator("#identity-composer [role=alert]")).toHaveCount(
        0,
      );
      if (reauthenticate && status === 200) {
        const originalKey = held!.request().headers()["idempotency-key"];
        let retryKey: string | undefined;
        await page.route("**/api/comments/", (route) => {
          retryKey = route.request().headers()["idempotency-key"];
          return route.fulfill({
            json: {
              uuid: "held-original-actor-post",
              content: "Cross-account held post",
              tuzis: 1,
              replayed: true,
            },
          });
        });
        await page
          .locator("#identity-composer")
          .getByRole("button", { name: "Post", exact: true })
          .click();
        await expect.poll(() => retryKey).toBe(originalKey);
        await expect(page.locator("#identity-composer textarea")).toHaveValue(
          "",
        );
        expect(
          await page.evaluate(() => (window as any).heldPostedEvents),
        ).toBe(1);
      }
    });
  }
}

for (const cleanupFails of [false, true]) {
  test(`a successful vote replay clears its prior refusal${cleanupFails ? " while retaining a new cleanup warning" : ""}`, async ({
    page,
  }) => {
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    const keys: string[] = [];
    await page.route("**/api/comments/replay-vote/vote/", (route) => {
      keys.push(route.request().headers()["idempotency-key"]);
      return route.fulfill(
        keys.length === 1
          ? { status: 500, json: { detail: "Vote request refused" } }
          : { json: { tuzis: 2, replayed: true } },
      );
    });
    await page.evaluate(async () => {
      const target = document.createElement("div");
      target.id = "replay-vote";
      document.body.append(target);
      const svelteModule = "/tests/browser/svelte-runtime.ts",
        voteModule = "/src/lib/components/comments/CommentVote.svelte";
      const [{ mount }, { default: Vote }] = await Promise.all([
        import(svelteModule),
        import(voteModule),
      ]);
      mount(Vote, {
        target,
        props: { comment: { uuid: "replay-vote", tuzis: 1 } },
      });
    });
    const vote = page
      .locator("#replay-vote")
      .getByRole("button", { name: "Upvote", exact: true });
    await vote.click();
    await expect(page.getByTestId("payment-outcome-error")).toHaveText(
      "Vote request refused",
    );
    if (cleanupFails)
      await page.evaluate(() => {
        const remove = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function (name: string) {
          if (name.startsWith("f2z:intent:"))
            throw new DOMException("Storage unavailable", "QuotaExceededError");
          return remove.call(this, name);
        };
      });
    await vote.click();
    await expect.poll(() => keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1]);
    if (cleanupFails)
      await expect(page.getByTestId("payment-outcome-error")).toHaveText(
        "Browser storage could not save this outcome. Check the request's outcome before retrying.",
      );
    else await expect(page.getByTestId("payment-outcome-error")).toHaveCount(0);
  });
}

for (const component of ["profile", "stream"] as const) {
  for (const outcome of ["refusal", "storage"] as const) {
    test(`the ${component} subscription keeps ${outcome} visible under full urgent congestion and clears it across accounts`, async ({
      page,
    }) => {
      await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
      await expect(
        page.getByRole("img", { name: "Zcash payment QR code" }),
      ).toBeVisible();
      let requests = 0;
      await page.route(
        "**/api/tuzis/subscribe-confirmed/recipient",
        (route) => {
          requests++;
          return route.fulfill({
            status: 500,
            json: {
              error:
                "Subscription outcome uncertain. Check membership before retrying.",
            },
          });
        },
      );
      await page.evaluate(async (component) => {
        const module =
          component === "profile"
            ? "/src/lib/components/profile/ProfileSubscribe.svelte"
            : "/src/lib/components/stream/SubscribeToCreator.svelte";
        const svelte = "/tests/browser/svelte-runtime.ts";
        const [{ mount }, { default: Subscribe }] = await Promise.all([
          import(svelte),
          import(module),
        ]);
        const target = document.createElement("div");
        document.querySelector("main")!.prepend(target);
        mount(Subscribe, {
          target,
          props: {
            creator: {
              id: 8801,
              username: "recipient",
              full_name: "Recipient",
              member_price: "5",
              membership_benefits: [],
            },
            ...(component === "stream" ? { open: true } : {}),
          },
        });
      }, component);
      if (component === "profile")
        await page
          .getByRole("button", { name: "Subscribe", exact: true })
          .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const module = "/src/lib/toast.ts";
            let ready = false;
            (await import(module)).toastPresentation.subscribe(
              (value: { ready: boolean }) => (ready = value.ready),
            )();
            return ready;
          }),
        )
        .toBe(true);
      await page.evaluate(async (outcome) => {
        const module = "/src/lib/toast.ts";
        const { toast } = await import(module);
        for (let index = 0; index < 52; index++)
          toast.error(`Previous upload refusal ${index}`);
        if (outcome === "storage") {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (name: string, value: string) {
            if (name.startsWith("f2z:subscribe-idempotency"))
              throw new DOMException(
                "Storage unavailable",
                "QuotaExceededError",
              );
            return original.call(this, name, value);
          };
        }
      }, outcome);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const module = "/src/lib/toast.ts";
            return (await import(module)).toastQueueStatus();
          }),
        )
        .toEqual({
          rendered: 2,
          queued: 50,
          urgentQueued: 50,
          overflow: 0,
          paymentQueued: false,
        });
      await dialog
        .getByRole("button", {
          name:
            component === "profile" ? "Confirm Subscription" : /^Subscribe for/,
        })
        .click();
      const warning = dialog.getByTestId("payment-outcome-error");
      await expect(warning).toContainText(
        outcome === "storage"
          ? component === "profile"
            ? "Your browser could not save the subscription retry key"
            : "Browser storage is unavailable"
          : "Subscription outcome uncertain",
      );
      await expect(warning).toBeVisible();
      expect(requests).toBe(outcome === "storage" ? 0 : 1);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(2);
      await page.route("**/api/auth/user/", (route) =>
        route.fulfill({
          json: { id: 8124, username: "other-account", tuzis: "50" },
        }),
      );
      await page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        await (
          await import(module)
        ).authStore.checkAuth({ force: true, fresh: true, silent: true });
      });
      await expect(warning).toHaveCount(0);
    });
  }
}

for (const component of ["profile", "stream"] as const) {
  for (const status of [200, 402]) {
    test(`a held ${component} subscription ${status} cannot change the next account membership or dialog`, async ({
      page,
    }) => {
      await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
      await expect(
        page.getByRole("img", { name: "Zcash payment QR code" }),
      ).toBeVisible();
      let held: Route | undefined;
      await page.route(
        "**/api/tuzis/subscribe-confirmed/recipient",
        (route) => {
          held = route;
        },
      );
      await page.evaluate(async (component) => {
        const module =
          component === "profile"
            ? "/src/lib/components/profile/ProfileSubscribe.svelte"
            : "/src/lib/components/stream/SubscribeToCreator.svelte";
        const svelte = "/tests/browser/svelte-runtime.ts",
          intent = "/src/lib/subscribe-idempotency.js";
        const [
          { mount },
          { default: Subscribe },
          { subscribeIdempotencyHeaders },
        ] = await Promise.all([import(svelte), import(module), import(intent)]);
        const target = document.createElement("div");
        document.querySelector("main")!.prepend(target);
        (window as any).subscriptionCloseRequests = 0;
        mount(Subscribe, {
          target,
          props: {
            creator: {
              id: 8801,
              username: "recipient",
              full_name: "Recipient",
              member_price: "5",
              membership_benefits: [],
            },
            ...(component === "stream"
              ? {
                  open: true,
                  onOpenChange: () =>
                    (window as any).subscriptionCloseRequests++,
                }
              : {}),
          },
        });
        (window as any).subscriptionStorageName = (payer: number) =>
          `f2z:subscribe-idempotency:v2:${encodeURIComponent(JSON.stringify({ creator: "8801", payer: String(payer) }))}`;
        (window as any).otherSubscriptionRetry = crypto.randomUUID();
        localStorage.setItem(
          (window as any).subscriptionStorageName(8124),
          (window as any).otherSubscriptionRetry,
        );
      }, component);
      if (component === "profile")
        await page
          .getByRole("button", { name: "Subscribe", exact: true })
          .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByRole("button", {
          name:
            component === "profile" ? "Confirm Subscription" : /^Subscribe for/,
        })
        .click();
      await expect.poll(() => Boolean(held)).toBe(true);
      const originalKey = await page.evaluate(() =>
        localStorage.getItem((window as any).subscriptionStorageName(4301)),
      );
      expect(originalKey).not.toBeNull();
      await page.route("**/api/auth/user/", (route) =>
        route.fulfill({
          json: {
            id: 8124,
            username: "other-account",
            tuzis: "50",
            stars: [],
            star_ids: [],
          },
        }),
      );
      await page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        await (
          await import(module)
        ).authStore.checkAuth({ force: true, fresh: true, silent: true });
      });
      await held!.fulfill(
        status === 200
          ? { json: { replayed: false } }
          : {
              status: 402,
              json: {
                code: "insufficient_funds",
                cost: "5",
                balance: "0",
                shortfall: "5",
                action: "subscription",
              },
            },
      );
      await expect(
        dialog.getByRole("button", {
          name:
            component === "profile" ? "Confirm Subscription" : /^Subscribe for/,
        }),
      ).toBeEnabled();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("insufficient-funds")).toHaveCount(0);
      await expect(dialog.getByTestId("payment-outcome-error")).toHaveCount(0);
      expect(
        await page.evaluate(async () => {
          const module = "/src/lib/stores/auth.ts";
          let creator: any;
          (await import(module)).authStore.subscribe(
            (value: any) => (creator = value.creator),
          )();
          return creator.star_ids;
        }),
      ).toEqual([]);
      expect(
        await page.evaluate(() => (window as any).subscriptionCloseRequests),
      ).toBe(0);
      expect(
        await page.evaluate(
          () =>
            localStorage.getItem(
              (window as any).subscriptionStorageName(8124),
            ) === (window as any).otherSubscriptionRetry,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() =>
          localStorage.getItem((window as any).subscriptionStorageName(4301)),
        ),
      ).toBe(status === 200 ? null : originalKey);
    });
  }
}

for (const status of [401, 403]) {
  for (const returnToOriginal of [false, true]) {
    test(`a generated delayed ${status} cannot sign out ${returnToOriginal ? "a new A session after A to B to A" : "account B"}`, async ({
      page,
    }) => {
      await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
      await expect(
        page.getByRole("img", { name: "Zcash payment QR code" }),
      ).toBeVisible();
      let held: Route | undefined;
      await page.route("**/api/test-owned-write", (route) => {
        held = route;
      });
      await page.evaluate(async () => {
        const module = "/src/lib/api/mutator.ts";
        (window as any).ownedWriteResult = null;
        void (await import(module))
          .customInstance({
            url: "/api/test-owned-write",
            method: "POST",
            data: {},
          })
          .catch(
            (error: any) => ((window as any).ownedWriteResult = error.status),
          );
      });
      await expect.poll(() => Boolean(held)).toBe(true);
      const original = await page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        let creator: any;
        (await import(module)).authStore.subscribe(
          (value: any) => (creator = value.creator),
        )();
        return creator;
      });
      let sessionActor = {
        id: 8124,
        username: "other-account",
        tuzis: "50",
      };
      // Keep the server session consistent with the browser account. Receipt
      // recovery may legitimately request a fresh authoritative identity.
      await page.route("**/api/auth/user/", (route) =>
        route.fulfill({ json: sessionActor }),
      );
      await billingFreshActorBarrier(page, sessionActor.username);
      if (returnToOriginal) {
        sessionActor = original;
        await billingFreshActorBarrier(page, sessionActor.username);
      }
      await page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        (window as any).newSessionStillOwned = (
          await import(module)
        ).authStore.captureRequestOwnership();
      });
      expect(
        await page.evaluate(async () => {
          const module = "/src/lib/stores/auth.ts";
          let state: any;
          (await import(module)).authStore.subscribe(
            (value: any) => (state = value),
          )();
          return { status: state.status, username: state.creator?.username };
        }),
      ).toEqual({
        status: "authenticated",
        username: returnToOriginal ? "fixtureowner" : "other-account",
      });
      await held!.fulfill({ status, json: { detail: "Old request refused" } });
      await expect
        .poll(() => page.evaluate(() => (window as any).ownedWriteResult))
        .toBe(status);
      expect(
        await page.evaluate(() => (window as any).newSessionStillOwned()),
      ).toBe(true);
      expect(
        await page.evaluate(async () => {
          const module = "/src/lib/stores/auth.ts";
          let state: any;
          (await import(module)).authStore.subscribe(
            (value: any) => (state = value),
          )();
          return { status: state.status, username: state.creator?.username };
        }),
      ).toEqual({
        status: "authenticated",
        username: returnToOriginal ? "fixtureowner" : "other-account",
      });
    });
  }
}
for (const client of ["generated", "raw"] as const) {
  for (const transition of [
    "other-account",
    "return-original",
    "same-id-balance",
    "public-omit",
  ] as const) {
    test(`${client} write ownership during CSRF preparation: ${transition}`, async ({
      page,
    }) => {
      await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
      await expect(
        page.getByRole("img", { name: "Zcash payment QR code" }),
      ).toBeVisible();
      let requests = 0;
      await page.route("**/api/test-csrf-owned-write", (route) => {
        requests++;
        return route.fulfill({ json: { ok: true } });
      });
      await page.evaluate(
        async ({ client, transition }) => {
          const authModule = "/src/lib/stores/auth.ts",
            apiModule =
              client === "generated"
                ? "/src/lib/api/mutator.ts"
                : "/src/lib/api/config.ts";
          const [{ authStore }, api] = await Promise.all([
            import(authModule),
            import(apiModule),
          ]);
          let original: any;
          authStore.subscribe((value: any) => (original = value.creator))();
          const credentials = transition === "public-omit" ? "omit" : "include";
          const pending =
            client === "generated"
              ? api.customInstance({
                  url: "/api/test-csrf-owned-write",
                  method: "POST",
                  data: {},
                  credentials,
                })
              : api.apiFetch("/api/test-csrf-owned-write", {
                  method: "POST",
                  body: "{}",
                  credentials,
                });
          if (transition === "same-id-balance")
            authStore.hydrateFromSession({ ...original, tuzis: "12000" });
          else {
            authStore.hydrateFromSession({
              id: 8124,
              username: "other-account",
              tuzis: "50",
            });
            if (transition === "return-original")
              authStore.hydrateFromSession(original);
          }
          (window as any).csrfOwnedOutcome = await pending.then(
            () => "sent",
            () => "account changed",
          );
        },
        { client, transition },
      );
      const allowed =
        transition === "same-id-balance" || transition === "public-omit";
      expect(requests).toBe(allowed ? 1 : 0);
      expect(await page.evaluate(() => (window as any).csrfOwnedOutcome)).toBe(
        allowed ? "sent" : "account changed",
      );
    });
  }
}

for (const component of ["vote", "comment", "boost", "donation"] as const) {
  for (const status of [200, 402]) {
    test(`a held ${component} ${status} cannot change the next account draft, score, funds or receipt`, async ({
      page,
    }) => {
      await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
      await expect(
        page.getByRole("img", { name: "Zcash payment QR code" }),
      ).toBeVisible();
      let held: Route | undefined;
      const endpoints = {
        vote: "**/api/comments/held-scope-vote/vote/",
        comment: "**/api/comments/zpage/held-scope-comment/",
        boost: "**/api/zpage/fund/",
        donation: "**/api/tuzis/donate-idempotent/recipient",
      };
      await page.route(endpoints[component], (route) => {
        held = route;
      });
      await page.evaluate(async (component) => {
        const modules = {
          vote: "/src/lib/components/comments/CommentVote.svelte",
          comment: "/src/lib/components/comments/CommentForm.svelte",
          boost: "/src/lib/components/zpageActions/BoostButton.svelte",
          donation: "/src/lib/components/profile/ProfileDonate.svelte",
        };
        const svelte = "/tests/browser/svelte-runtime.ts";
        const [{ mount }, { default: Component }] = await Promise.all([
          import(svelte),
          import(modules[component]),
        ]);
        const target = document.createElement("div");
        target.id = "held-financial-scope";
        document.querySelector("main")!.prepend(target);
        (window as any).scopeCallback = 0;
        const props =
          component === "vote"
            ? { comment: { uuid: "held-scope-vote", tuzis: 1 } }
            : component === "comment"
              ? {
                  object_type: "zpage",
                  object_uuid: "held-scope-comment",
                  callback: () => (window as any).scopeCallback++,
                }
              : component === "boost"
                ? {
                    pageId: "held-scope-boost",
                    score: "12",
                    onScoreChange: (_score: any, _page: any, state: string) => {
                      if (state === "authoritative")
                        (window as any).scopeCallback++;
                    },
                  }
                : {
                    creator: {
                      id: 8801,
                      username: "recipient",
                      full_name: "Recipient",
                    },
                  };
        mount(Component, { target, props });
      }, component);
      const fixture = page.locator("#held-financial-scope");
      if (component === "comment") {
        await fixture.locator("textarea").fill("Original account comment");
        await fixture
          .getByRole("button", { name: /Post|Comment/, exact: true })
          .click();
      } else if (component === "vote")
        await fixture
          .getByRole("button", { name: "Upvote", exact: true })
          .click();
      else if (component === "boost")
        await fixture
          .getByRole("button", { name: "Boost this page with 2Z", exact: true })
          .click();
      else {
        await fixture
          .getByRole("button", { name: "Support", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Share 5 2Z", exact: true })
          .click();
      }
      await expect.poll(() => Boolean(held)).toBe(true);
      const otherAccount = {
        id: 8124,
        username: "other-account",
        tuzis: "50",
      };
      if (component === "comment")
        await page.route("**/api/auth/user/", (route) =>
          route.fulfill({ json: otherAccount }),
        );
      await page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        (await import(module)).authStore.hydrateFromSession({
          id: 8124,
          username: "other-account",
          tuzis: "50",
        });
      });
      if (component === "comment") {
        await billingFreshActorBarrier(page, otherAccount.username);
        // Wait for the form's account-keyed draft transition before typing.
        // hydrateFromSession notifies Svelte synchronously, but the component
        // applies its reactive draft reset on the next update flush.
        await expect(fixture.locator("textarea")).toHaveValue("");
        await fixture.locator("textarea").fill("Other account comment draft");
      }
      await held!.fulfill(
        status === 200
          ? {
              json:
                component === "boost"
                  ? { score: "999" }
                  : component === "vote"
                    ? { tuzis: 999 }
                    : component === "comment"
                      ? {
                          uuid: "old-comment",
                          content: "Original account comment",
                        }
                      : { replayed: false },
            }
          : {
              status: 402,
              json: {
                code: "insufficient_funds",
                cost: "5",
                balance: "0",
                shortfall: "5",
                action: component,
              },
            },
      );
      if (component === "vote") {
        await expect(
          fixture.getByRole("button", { name: "Upvote", exact: true }),
        ).toBeEnabled();
        await expect(fixture.locator('[aria-live="polite"]')).toHaveText(/1/);
      }
      if (component === "boost") {
        await expect(fixture.getByTestId("boost-score")).toHaveText("12");
      }
      if (component === "comment") {
        await expect(fixture.locator("textarea")).toHaveValue(
          "Other account comment draft",
        );
        await expect(
          fixture.getByRole("button", { name: /Post|Comment/, exact: true }),
        ).toBeEnabled();
      }
      if (component === "donation") {
        await expect(
          page.getByRole("button", { name: "Share 5 2Z", exact: true }),
        ).toBeEnabled();
        await expect(
          page.getByRole("heading", { name: "Usage credits sent" }),
        ).toHaveCount(0);
      }
      await expect(page.getByTestId("insufficient-funds")).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).scopeCallback)).toBe(0);
    });
  }
}

for (const component of ["profile", "stream"] as const) {
  test(`confirmed ${component} subscription remains recorded with inline storage cleanup guidance under congestion`, async ({
    page,
  }) => {
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    let paid = false;
    await page.route("**/api/tuzis/subscribe-confirmed/recipient", (route) => {
      paid = true;
      return route.fulfill({ json: { replayed: true } });
    });
    await page.route("**/api/tuzis/subscribe/recipient", (route) =>
      route.fulfill({ json: { max_price: "5" } }),
    );
    await page.route("**/api/auth/user/", (route) =>
      route.fulfill({
        json: {
          id: 4301,
          username: "fixtureowner",
          tuzis: "500",
          stars: paid ? ["recipient"] : [],
          star_ids: paid ? [8801] : [],
        },
      }),
    );
    await page.evaluate(async (component) => {
      const module =
          component === "profile"
            ? "/src/lib/components/profile/ProfileSubscribe.svelte"
            : "/src/lib/components/stream/SubscribeToCreator.svelte",
        svelte = "/tests/browser/svelte-runtime.ts",
        query = "/@id/@tanstack/svelte-query";
      const [{ mount }, { default: Component }, { QueryClient }] =
        await Promise.all([import(svelte), import(module), import(query)]);
      const target = document.createElement("div");
      document.querySelector("main")!.prepend(target);
      mount(Component, {
        target,
        context: new Map([["$$_queryClient", new QueryClient()]]),
        props: {
          creator: {
            id: 8801,
            username: "recipient",
            member_price: "5",
            membership_benefits: [],
          },
          ...(component === "stream" ? { open: true } : {}),
        },
      });
    }, component);
    if (component === "profile")
      await page
        .getByRole("button", { name: "Subscribe", exact: true })
        .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const module = "/src/lib/toast.ts";
          let ready = false;
          (await import(module)).toastPresentation.subscribe(
            (value: any) => (ready = value.ready && value.generation > 0),
          )();
          return ready;
        }),
      )
      .toBe(true);
    await page.evaluate(async () => {
      const module = "/src/lib/toast.ts";
      const { toast } = await import(module);
      for (let index = 0; index < 52; index++)
        toast.error(`Earlier failure ${index}`);
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (name: string) {
        if (name.startsWith("f2z:subscribe-idempotency"))
          throw new DOMException("Storage unavailable", "QuotaExceededError");
        return original.call(this, name);
      };
    });
    await dialog
      .getByRole("button", {
        name:
          component === "profile" ? "Confirm Subscription" : /^Subscribe for/,
      })
      .click();
    await expect(dialog.getByTestId("payment-outcome-error")).toContainText(
      "Browser storage could not save this outcome",
    );
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("Failed to subscribe.", { exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const module = "/src/lib/stores/auth.ts";
          let state: any;
          (await import(module)).authStore.subscribe(
            (value: any) => (state = value),
          )();
          return state.creator?.star_ids;
        }),
      )
      .toEqual([8801]);
  });
}

test("a generated cover keeps storage cleanup guidance inline even when its preview succeeds under congestion", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  await page.route("**/api/openai/image", (route) =>
    route.fulfill({ json: { url: "/cover-financial-fixture.png" } }),
  );
  await routeCreatorCoverChoices(page);
  await page.route("**/cover-financial-fixture.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    }),
  );
  await page.evaluate(async () => {
    const svelte = "/tests/browser/svelte-runtime.ts",
      module = "/src/lib/components/mdEditor/CoverAIPanel.svelte",
      notice = "/src/lib/toast.ts";
    const [{ mount }, { default: Cover }, { toast }] = await Promise.all([
      import(svelte),
      import(module),
      import(notice),
    ]);
    const target = document.createElement("div");
    target.id = "cover-financial-fixture";
    document.querySelector("main")!.prepend(target);
    mount(Cover, {
      target,
      props: {
        apiBase: "",
        buildMediaUrl: (path: string) => path,
        onGenerated: () => {},
        onChoose: () => {},
      },
    });
    for (let index = 0; index < 52; index++)
      toast.error(`Earlier failure ${index}`);
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name: string) {
      if (name.startsWith("f2z:intent:"))
        throw new DOMException("Storage unavailable", "QuotaExceededError");
      return original.call(this, name);
    };
  });
  const fixture = page.locator("#cover-financial-fixture");
  await fixture
    .getByRole("textbox", { name: "Describe your cover image" })
    .fill("A private sunrise landscape");
  await chooseAndAcceptCreatorCover(fixture);
  await fixture
    .getByRole("button", { name: "Generate Image", exact: true })
    .click();
  await expect(
    fixture.getByRole("img", { name: "Generated cover preview" }),
  ).toBeVisible();
  await expect(fixture.getByTestId("payment-outcome-error")).toContainText(
    "Browser storage could not save this outcome",
  );
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts";
    (await import(module)).authStore.hydrateFromSession({
      id: 8124,
      username: "other-account",
      tuzis: "50",
    });
  });
  await expect(
    fixture.getByRole("img", { name: "Generated cover preview" }),
  ).toHaveCount(0);
  await expect(fixture.getByTestId("payment-outcome-error")).toHaveCount(0);
});

for (const outcome of ["refusal", "late-success"] as const) {
  test(`subscription cancellation ${outcome} stays account scoped under notification congestion`, async ({
    page,
  }) => {
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    let held: Route | undefined;
    await page.route("**/api/tuzis/subscribe/recipient", (route) =>
      route.request().method() === "DELETE"
        ? (held = route)
        : route.fulfill({ json: { max_price: "5" } }),
    );
    await page.evaluate(async () => {
      const svelte = "/tests/browser/svelte-runtime.ts",
        module = "/src/lib/components/subscription/ManageSubscription.svelte",
        query = "/@id/@tanstack/svelte-query";
      const [{ mount }, { default: Manage }, { QueryClient }] =
        await Promise.all([import(svelte), import(module), import(query)]);
      const target = document.createElement("div");
      target.id = "cancel-financial-fixture";
      document.querySelector("main")!.prepend(target);
      mount(Manage, {
        target,
        context: new Map([["$$_queryClient", new QueryClient()]]),
        props: {
          creator: { id: 8801, username: "recipient", member_price: "5" },
        },
      });
    });
    const fixture = page.locator("#cancel-financial-fixture");
    await expect(
      fixture.getByRole("button", { name: "Cancel renewal", exact: true }),
    ).toBeEnabled();
    await page.evaluate(async () => {
      const module = "/src/lib/toast.ts";
      const { toast } = await import(module);
      for (let index = 0; index < 52; index++)
        toast.error(`Earlier failure ${index}`);
    });
    await fixture
      .getByRole("button", { name: "Cancel renewal", exact: true })
      .click();
    await expect.poll(() => Boolean(held)).toBe(true);
    if (outcome === "late-success")
      await page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        (await import(module)).authStore.hydrateFromSession({
          id: 8124,
          username: "other-account",
          tuzis: "50",
        });
      });
    await held!.fulfill(
      outcome === "refusal"
        ? {
            status: 500,
            json: {
              detail: "Renewal outcome uncertain. Check your subscription.",
            },
          }
        : { status: 204, body: "" },
    );
    if (outcome === "refusal") {
      await expect(fixture.getByTestId("payment-outcome-error")).toContainText(
        "Renewal outcome uncertain",
      );
      await page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        (await import(module)).authStore.hydrateFromSession({
          id: 8124,
          username: "other-account",
          tuzis: "50",
        });
      });
      await expect(fixture.getByTestId("payment-outcome-error")).toHaveCount(0);
    } else {
      await expect(
        fixture.getByText("Renewal cancelled", { exact: true }),
      ).toHaveCount(0);
      await expect(
        fixture.getByRole("button", { name: "Try again", exact: true }),
      ).toBeVisible();
    }
  });
}

for (const status of [200, 402]) {
  test(`a held cover generation ${status} does not expose an old account image, funds or callback`, async ({
    page,
  }) => {
    // Auth refreshes continue while the paid response is held. Keep the mock
    // server's session identity aligned with the simulated browser account switch.
    let authActor: Record<string, unknown> = {
      id: 4301,
      username: "fixtureowner",
      tuzis: "64672.234",
      balance_snapshot: "8123:0",
      member_price: "50",
    };
    await page.route("**/api/auth/user/", (route) =>
      route.fulfill({ json: authActor }),
    );
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await billingInitialActorBarrier(page, "fixtureowner");
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    let held: Route | undefined;
    let previews = 0;
    await routeCreatorCoverChoices(page);
    await page.route("**/api/openai/image", (route) => {
      held = route;
    });
    await page.route("**/old-account-cover.png", (route) => {
      previews++;
      return route.fulfill({ body: "private" });
    });
    await page.evaluate(async () => {
      const svelte = "/tests/browser/svelte-runtime.ts",
        module = "/src/lib/components/mdEditor/CoverAIPanel.svelte";
      const [{ mount }, { default: Cover }] = await Promise.all([
        import(svelte),
        import(module),
      ]);
      const target = document.createElement("div");
      target.id = "held-cover-financial";
      document.querySelector("main")!.prepend(target);
      (window as any).oldCoverCallbacks = 0;
      mount(Cover, {
        target,
        props: {
          apiBase: "",
          buildMediaUrl: (path: string) => path,
          onGenerated: () => (window as any).oldCoverCallbacks++,
          onChoose: () => {},
        },
      });
    });
    const fixture = page.locator("#held-cover-financial");
    await fixture
      .getByRole("textbox", { name: "Describe your cover image" })
      .fill("Original account private cover");
    await chooseAndAcceptCreatorCover(fixture);
    await fixture
      .getByRole("button", { name: "Generate Image", exact: true })
      .click();
    await expect.poll(() => Boolean(held)).toBe(true);
    authActor = { id: 8124, username: "other-account", tuzis: "50" };
    await page.evaluate(async () => {
      const module = "/src/lib/stores/auth.ts";
      (await import(module)).authStore.hydrateFromSession({
        id: 8124,
        username: "other-account",
        tuzis: "50",
      });
    });
    await held!.fulfill(
      status === 200
        ? { json: { url: "/old-account-cover.png" } }
        : {
            status: 402,
            json: {
              code: "insufficient_funds",
              cost: "6",
              balance: "0",
              shortfall: "6",
              action: "ai_image",
            },
          },
    );
    const generate = fixture.getByRole("button", {
      name: "Generate Image",
      exact: true,
    });
    const prompt = fixture.getByRole("textbox", {
      name: "Describe your cover image",
    });
    await expect(prompt).toHaveValue("");
    await expect(fixture.getByRole("checkbox")).not.toBeChecked();
    await expect(generate).toBeDisabled();
    // Only fresh input and consent from the new account may enable another
    // attempt. Merely discarding the former account's reply grants neither.
    await prompt.fill("New account cover prompt");
    await expect(generate).toBeDisabled();
    await chooseAndAcceptCreatorCover(fixture);
    await expect(generate).toBeEnabled();
    await expect(
      fixture.getByRole("img", { name: "Generated cover preview" }),
    ).toHaveCount(0);
    await expect(fixture.getByTestId("insufficient-funds")).toHaveCount(0);
    await expect(fixture.locator('[role="alert"]')).toHaveCount(0);
    expect(previews).toBe(0);
    expect(await page.evaluate(() => (window as any).oldCoverCallbacks)).toBe(
      0,
    );
  });
}

for (const status of [401, 403]) {
  for (const phase of ["lookup", "adopted"]) {
    test(`delayed generated ${status} cannot invalidate same-ID credential session during ${phase}`, async ({
      page,
    }) => {
      await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
      await expect(
        page.getByRole("img", { name: "Zcash payment QR code" }),
      ).toBeVisible();
      let oldRequest: Route | undefined;
      const identityRequests: Route[] = [];
      let identityReleased = false;
      const identityBody = { id: 4301, username: "fixtureowner", tuzis: "500" };
      const releaseIdentity = async () => {
        identityReleased = true;
        await Promise.all(
          identityRequests.map((route) =>
            route.fulfill({ json: identityBody }),
          ),
        );
      };
      await page.route("**/api/test-old-credential", (route) => {
        oldRequest = route;
      });
      await page.evaluate(async () => {
        const module = "/src/lib/api/mutator.ts";
        (window as any).oldCredentialStatus = null;
        void (await import(module))
          .customInstance({
            url: "/api/test-old-credential",
            method: "POST",
            data: {},
          })
          .catch(
            (error: any) =>
              ((window as any).oldCredentialStatus = error.status),
          );
      });
      await expect.poll(() => Boolean(oldRequest)).toBe(true);
      await page.route("**/api/auth/login/", (route) =>
        route.fulfill({ json: {} }),
      );
      await page.route("**/api/auth/user/", (route) => {
        if (identityReleased) return route.fulfill({ json: identityBody });
        identityRequests.push(route);
      });
      await page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        (window as any).reauthResult = null;
        void (await import(module)).authStore
          .loginOnly("fixtureowner", "password")
          .then(
            (result: any) => ((window as any).reauthResult = result.success),
          );
      });
      await expect.poll(() => identityRequests.length > 0).toBe(true);
      if (phase === "adopted") {
        await releaseIdentity();
        await expect
          .poll(() => page.evaluate(() => (window as any).reauthResult))
          .toBe(true);
      }
      await oldRequest!.fulfill({
        status,
        json: { detail: "Old session expired" },
      });
      await expect
        .poll(() => page.evaluate(() => (window as any).oldCredentialStatus))
        .toBe(status);
      if (phase === "lookup") {
        expect(
          await page.evaluate(async () => {
            const module = "/src/lib/stores/auth.ts";
            let state: any;
            (await import(module)).authStore.subscribe(
              (value: any) => (state = value),
            )();
            return state.status;
          }),
        ).toBe("unknown");
        await releaseIdentity();
        await expect
          .poll(() => page.evaluate(() => (window as any).reauthResult))
          .toBe(true);
      }
      expect(
        await page.evaluate(async () => {
          const module = "/src/lib/stores/auth.ts";
          let state: any;
          (await import(module)).authStore.subscribe(
            (value: any) => (state = value),
          )();
          return { status: state.status, username: state.creator?.username };
        }),
      ).toEqual({ status: "authenticated", username: "fixtureowner" });
    });
  }
}

test("a held successful comment retains its replay key and reconciles the draft after same-account reauthentication", async ({
  page,
}) => {
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.getByRole("img", { name: "Zcash payment QR code" }),
  ).toBeVisible();
  let held: Route | undefined;
  await page.route("**/api/comments/zpage/reauth-comment/", (route) => {
    held = route;
  });
  await page.evaluate(async () => {
    const svelte = "/tests/browser/svelte-runtime.ts",
      module = "/src/lib/components/comments/CommentForm.svelte";
    const [{ mount }, { default: Component }] = await Promise.all([
      import(svelte),
      import(module),
    ]);
    const target = document.createElement("div");
    target.id = "reauth-comment";
    document.querySelector("main")!.prepend(target);
    (window as any).reauthCommentCallback = 0;
    mount(Component, {
      target,
      props: {
        object_type: "zpage",
        object_uuid: "reauth-comment",
        callback: () => (window as any).reauthCommentCallback++,
      },
    });
  });
  const fixture = page.locator("#reauth-comment");
  await fixture.locator("textarea").fill("Original paid comment");
  await fixture
    .getByRole("button", { name: /Post|Comment/, exact: true })
    .click();
  await expect.poll(() => Boolean(held)).toBe(true);
  const originalKey = held!.request().headers()["idempotency-key"];
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts";
    const { authStore } = await import(module);
    let original: any;
    authStore.subscribe((value: any) => (original = value.creator))();
    authStore.hydrateFromSession(null);
    authStore.hydrateFromSession(original);
  });
  await held!.fulfill({
    json: {
      uuid: "original-paid-comment",
      content: "Original paid comment",
      tuzis: 1,
    },
  });
  await expect(
    fixture.getByRole("button", { name: /Post|Comment/, exact: true }),
  ).toBeEnabled();
  await expect(fixture.locator("textarea")).toHaveValue(
    "Original paid comment",
  );
  expect(await page.evaluate(() => (window as any).reauthCommentCallback)).toBe(
    0,
  );
  let retryKey: string | undefined;
  await page.route("**/api/comments/zpage/reauth-comment/", (route) => {
    retryKey = route.request().headers()["idempotency-key"];
    return route.fulfill({
      json: {
        uuid: "original-paid-comment",
        content: "Original paid comment",
        tuzis: 1,
        replayed: true,
      },
    });
  });
  await fixture
    .getByRole("button", { name: /Post|Comment/, exact: true })
    .click();
  await expect.poll(() => retryKey).toBe(originalKey);
  await expect(fixture.locator("textarea")).toHaveValue("");
  expect(await page.evaluate(() => (window as any).reauthCommentCallback)).toBe(
    1,
  );
});

const scopedPaidEndpoints = {
  vote: "**/api/comments/owned-replay-vote/vote/",
  comment: "**/api/comments/zpage/owned-replay-comment/",
  converse: "**/api/comments/",
  boost: "**/api/zpage/fund/",
  donation: "**/api/tuzis/donate-idempotent/recipient",
  cover: "**/api/openai/image",
} as const;
type ScopedPaidComponent = keyof typeof scopedPaidEndpoints;
async function mountScopedPaidControl(
  page: Page,
  component: ScopedPaidComponent,
) {
  if (component === "cover") await routeCreatorCoverChoices(page);
  await page.evaluate(async (component) => {
    const modules = {
        vote: "/src/lib/components/comments/CommentVote.svelte",
        comment: "/src/lib/components/comments/CommentForm.svelte",
        converse: "/src/lib/components/converse/ConverseComposer.svelte",
        boost: "/src/lib/components/zpageActions/BoostButton.svelte",
        donation: "/src/lib/components/profile/ProfileDonate.svelte",
        cover: "/src/lib/components/mdEditor/CoverAIPanel.svelte",
      },
      svelte = "/tests/browser/svelte-runtime.ts";
    const [{ mount }, { default: Component }] = await Promise.all([
      import(svelte),
      import(modules[component]),
    ]);
    const target = document.createElement("div");
    target.id = "scoped-paid-control";
    document.querySelector("main")!.prepend(target);
    (window as any).scopedPaidCallback = 0;
    const props =
      component === "vote"
        ? { comment: { uuid: "owned-replay-vote", tuzis: 1 } }
        : component === "comment"
          ? {
              object_type: "zpage",
              object_uuid: "owned-replay-comment",
              callback: () => (window as any).scopedPaidCallback++,
            }
          : component === "boost"
            ? {
                pageId: "owned-replay-boost",
                score: "12",
                onScoreChange: (_score: any, _page: any, state: string) => {
                  if (state === "authoritative")
                    (window as any).scopedPaidCallback++;
                },
              }
            : component === "donation"
              ? {
                  creator: {
                    id: 8801,
                    username: "recipient",
                    full_name: "Recipient",
                  },
                }
              : component === "cover"
                ? {
                    apiBase: "",
                    buildMediaUrl: (path: string) => path,
                    onGenerated: () => (window as any).scopedPaidCallback++,
                    onChoose: () => {},
                  }
                : {};
    (window as any).scopedPaidMount = mount(Component, { target, props });
  }, component);
  const fixture = page.locator("#scoped-paid-control");
  if (component === "comment" || component === "converse")
    await fixture.locator("textarea").fill("Original paid request content");
  if (component === "cover") {
    await fixture
      .getByRole("textbox", { name: "Describe your cover image" })
      .fill("Original paid cover prompt");
    await chooseAndAcceptCreatorCover(fixture);
  }
  if (component === "donation")
    await fixture.getByRole("button", { name: "Support", exact: true }).click();
  const button =
    component === "vote"
      ? fixture.getByRole("button", { name: "Upvote", exact: true })
      : component === "boost"
        ? fixture.getByRole("button", {
            name: "Boost this page with 2Z",
            exact: true,
          })
        : component === "donation"
          ? page.getByRole("button", { name: "Share 5 2Z", exact: true })
          : component === "cover"
            ? fixture.getByRole("button", {
                name: "Generate Image",
                exact: true,
              })
            : fixture.getByRole("button", { name: "Post", exact: true });
  return { fixture, button };
}
const scopedPaidSuccess = (component: ScopedPaidComponent) =>
  component === "vote"
    ? { tuzis: 17 }
    : component === "boost"
      ? { score: "99", replayed: true }
      : component === "cover"
        ? { url: "/owned-replay-cover.png" }
        : component === "donation"
          ? { replayed: true }
          : {
              uuid: "owned-replay-post",
              content: "Original paid request content",
              tuzis: 1,
              replayed: true,
            };
const scopedCoverPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
for (const component of ["vote", "boost", "donation", "cover"] as const) {
  for (const phase of component === "cover"
    ? (["payment", "preview"] as const)
    : (["payment"] as const)) {
    test(`${component} ${phase} success keeps its paid replay handle until same-account recovery is presented`, async ({
      page,
    }) => {
      await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
      await expect(
        page.getByRole("img", { name: "Zcash payment QR code" }),
      ).toBeVisible();
      const keys: string[] = [];
      let heldPayment: Route | undefined, heldPreview: Route | undefined;
      await page.route(scopedPaidEndpoints[component], (route) => {
        keys.push(route.request().headers()["idempotency-key"]);
        heldPayment = route;
      });
      await page.route("**/owned-replay-cover.png", (route) => {
        if (phase === "preview") heldPreview = route;
        else
          return route.fulfill({
            contentType: "image/png",
            body: scopedCoverPng,
          });
      });
      const { fixture, button } = await mountScopedPaidControl(page, component);
      await button.click();
      await expect.poll(() => Boolean(heldPayment)).toBe(true);
      if (phase === "preview") {
        await heldPayment!.fulfill({ json: scopedPaidSuccess(component) });
        await expect.poll(() => Boolean(heldPreview)).toBe(true);
      }
      await page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts",
          { authStore } = await import(module);
        let original: any;
        authStore.subscribe((value: any) => (original = value.creator))();
        authStore.hydrateFromSession(null);
        authStore.hydrateFromSession(original);
      });
      if (phase === "preview")
        await heldPreview!.fulfill({
          contentType: "image/png",
          body: scopedCoverPng,
        });
      else await heldPayment!.fulfill({ json: scopedPaidSuccess(component) });
      await expect(button).toBeEnabled();
      if (component === "cover")
        await expect(
          fixture.getByRole("img", { name: "Generated cover preview" }),
        ).toHaveCount(0);
      if (component === "donation")
        await expect(
          page.getByRole("heading", {
            name: "Usage credits sent",
            exact: true,
          }),
        ).toHaveCount(0);
      await page.route(scopedPaidEndpoints[component], (route) => {
        keys.push(route.request().headers()["idempotency-key"]);
        return route.fulfill({ json: scopedPaidSuccess(component) });
      });
      await page.route("**/owned-replay-cover.png", (route) =>
        route.fulfill({ contentType: "image/png", body: scopedCoverPng }),
      );
      await button.click();
      await expect.poll(() => keys.length).toBe(2);
      expect(keys[1]).toBe(keys[0]);
      expect(new Set(keys).size).toBe(1);
      if (component === "cover")
        await expect(
          fixture.getByRole("img", { name: "Generated cover preview" }),
        ).toBeVisible();
      else if (component === "donation")
        await expect(
          page.getByRole("heading", {
            name: "Usage credits sent",
            exact: true,
          }),
        ).toBeVisible();
      else if (component === "boost")
        await expect
          .poll(() => page.evaluate(() => (window as any).scopedPaidCallback))
          .toBe(1);
      else await expect(fixture.getByText("17", { exact: true })).toBeVisible();
    });
  }
}
for (const component of Object.keys(
  scopedPaidEndpoints,
) as ScopedPaidComponent[]) {
  for (const transition of ["other-account", "return-original"] as const) {
    test(`${component} rejects original intent before mint and POST when held authentication changes ${transition}`, async ({
      page,
    }) => {
      // A background auth refresh must observe the same actor this test places
      // in the browser store, or it can legitimately restore the mock's actor A.
      let authActor: Record<string, unknown> = {
        id: 4301,
        username: "fixtureowner",
        tuzis: "64672.234",
        balance_snapshot: "8123:0",
        member_price: "50",
      };
      await page.route("**/api/auth/user/", (route) =>
        route.fulfill({ json: authActor }),
      );
      await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
      if (component === "donation" || component === "cover")
        await billingInitialActorBarrier(page, "fixtureowner");
      await expect(
        page.getByRole("img", { name: "Zcash payment QR code" }),
      ).toBeVisible();
      let posts = 0;
      await page.route(scopedPaidEndpoints[component], (route) => {
        posts++;
        return route.fulfill({ json: scopedPaidSuccess(component) });
      });
      const { fixture, button } = await mountScopedPaidControl(page, component);
      const before = await page.evaluate(() =>
        Object.keys(localStorage)
          .filter(
            (key) =>
              key.startsWith("f2z:intent:") || key.startsWith("f2z:donation"),
          )
          .sort(),
      );
      await page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        const { authStore } = await import(module);
        (window as any).heldPaidAuthStarted = false;
        authStore.ensureAuthenticated = () =>
          new Promise<boolean>((resolve) => {
            (window as any).heldPaidAuthStarted = true;
            (window as any).releaseHeldPaidAuth = resolve;
          });
      });
      await button.click();
      await expect
        .poll(() => page.evaluate(() => (window as any).heldPaidAuthStarted))
        .toBe(true);
      if (transition === "other-account")
        authActor = { id: 8124, username: "other-account", tuzis: "50" };
      await page.evaluate(async (transition) => {
        const module = "/src/lib/stores/auth.ts",
          { authStore } = await import(module);
        let original: any;
        authStore.subscribe((value: any) => (original = value.creator))();
        authStore.hydrateFromSession({
          id: 8124,
          username: "other-account",
          tuzis: "50",
        });
        if (transition === "return-original")
          authStore.hydrateFromSession(original);
        (window as any).releaseHeldPaidAuth(true);
      }, transition);
      if (component === "cover" && transition === "other-account") {
        const prompt = fixture.getByRole("textbox", {
          name: "Describe your cover image",
        });
        await expect(prompt).toHaveValue("");
        await expect(fixture.getByRole("checkbox")).not.toBeChecked();
        await expect(button).toBeDisabled();
        await prompt.fill("New account cover prompt");
        await expect(button).toBeDisabled();
        await chooseAndAcceptCreatorCover(fixture);
      }
      if (component === "comment" && transition === "other-account") {
        const composer = fixture.locator("textarea");
        await expect(composer).toHaveValue("");
        await expect(button).toBeDisabled();
        await composer.fill("New account paid request content");
      }
      await expect(button).toBeEnabled();
      expect(posts).toBe(0);
      expect(
        await page.evaluate(() =>
          Object.keys(localStorage)
            .filter(
              (key) =>
                key.startsWith("f2z:intent:") || key.startsWith("f2z:donation"),
            )
            .sort(),
        ),
      ).toEqual(before);
      await expect(fixture.getByTestId("payment-outcome-error")).toHaveCount(0);
    });
  }
}
for (const component of ["vote", "cover"] as const) {
  test(`${component} permits a cold no-actor authentication to hydrate before deriving its paid key`, async ({
    page,
  }) => {
    await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
    await expect(
      page.getByRole("img", { name: "Zcash payment QR code" }),
    ).toBeVisible();
    const keys: string[] = [];
    await page.route(scopedPaidEndpoints[component], (route) => {
      keys.push(route.request().headers()["idempotency-key"]);
      return route.fulfill({ json: scopedPaidSuccess(component) });
    });
    await page.route("**/owned-replay-cover.png", (route) =>
      route.fulfill({ contentType: "image/png", body: scopedCoverPng }),
    );
    await page.evaluate(async () => {
      const module = "/src/lib/stores/auth.ts",
        { authStore } = await import(module);
      let original: any;
      authStore.subscribe((value: any) => (original = value.creator))();
      authStore.hydrateFromSession(null);
      authStore.ensureAuthenticated = async () => {
        authStore.hydrateFromSession(original);
        return true;
      };
    });
    // Establish the cold identity before entering private input or consent.
    // Clearing an already populated panel models logout instead.
    const { fixture, button } = await mountScopedPaidControl(page, component);
    await button.click();
    await expect.poll(() => keys.length).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).some(
          (key) => key.includes("anonymous") || key.includes("unknown"),
        ),
      ),
    ).toBe(false);
    if (component === "cover")
      await expect(
        fixture.getByRole("img", { name: "Generated cover preview" }),
      ).toBeVisible();
    else await expect(fixture.getByText("17", { exact: true })).toBeVisible();
  });
}

const genericExpiryGuidance = "Sign in again before continuing.";
type ExpiryTransition =
  "logout" | "other-account" | "return-original" | "destroy";
type ExpiryAuthRoute = {
  held: () => Route | undefined;
  setActor: (actor: any) => void;
  fulfillHeld: (response: Parameters<Route["fulfill"]>[0]) => Promise<void>;
  dispose: () => Promise<void>;
};
async function paidExpirySetup(page: Page, component: ScopedPaidComponent) {
  await initialRecoveryBarrier(page);
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect(
    page.locator('main[data-zcash-auth-mounted="true"]'),
  ).toBeAttached({ timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => (window as any).initialRecoverySettled))
    .toBe(true);
  await expect
    .poll(async () => expiryActorState(page))
    .toEqual({ status: "authenticated", username: "fixtureowner" });
  const control = await mountScopedPaidControl(page, component);
  // Finish any overlapping layout check before the held paid preflight.
  await billingFreshActorBarrier(page, "fixtureowner");
  await expect
    .poll(async () => (await expiryActorState(page)).status)
    .toBe("authenticated");
  await expect
    .poll(() =>
      page.evaluate(async (loader) => {
        const { toastPresentation } = await new Function(loader)();
        let ready = false;
        toastPresentation.subscribe((value: any) => (ready = value.ready))();
        return ready;
      }, TOAST_LOADER),
    )
    .toBe(true);
  const original = await page.evaluate(async (loader) => {
    const { authStore } = await new Function(loader)();
    let value: any;
    authStore.subscribe((state: any) => (value = state.creator))();
    return value;
  }, AUTH_STORE_LOADER);
  return { ...control, original };
}
async function paidReplayStorage(page: Page) {
  return page.evaluate(() =>
    Object.keys(localStorage)
      .filter(
        (key) =>
          key.startsWith("f2z:intent:") || key.startsWith("f2z:donation"),
      )
      .sort()
      .map((key) => [key, localStorage.getItem(key)]),
  );
}
async function expiryActorState(page: Page) {
  return page.evaluate(async (loader) => {
    let value: any;
    const { authStore } = await new Function(loader)();
    authStore.subscribe((state: any) => (value = state))();
    return { status: value.status, username: value.creator?.username ?? null };
  }, AUTH_STORE_LOADER);
}
async function changeExpiryOwner(
  page: Page,
  transition: ExpiryTransition,
  original: any,
  authRoute: ExpiryAuthRoute,
) {
  if (transition === "destroy") {
    authRoute.setActor(null);
    await page.evaluate(async () => {
      (window as any).expiryServerActor = null;
      const svelte = "/tests/browser/svelte-runtime.ts";
      await (await import(svelte)).unmount((window as any).scopedPaidMount);
    });
    return;
  }
  if (transition === "logout") {
    authRoute.setActor(null);
    await page.evaluate(async (loader) => {
      const { authStore } = await new Function(loader)();
      (window as any).expiryServerActor = null;
      authStore.clear();
    }, AUTH_STORE_LOADER);
    return;
  }
  const other = { ...original, id: 8124, username: "other-account" };
  authRoute.setActor(other);
  await page.evaluate(
    async ({ other, loader }) => {
      const { authStore } = await new Function(loader)();
      (window as any).expiryServerActor = other;
      if (
        !(await authStore.loginOnly("other-account", "fixture-password"))
          .success
      )
        throw new Error("B credential adoption failed");
    },
    { other, loader: AUTH_STORE_LOADER },
  );
  if (transition === "return-original") {
    authRoute.setActor(original);
    await page.evaluate(
      async ({ original, loader }) => {
        (window as any).expiryServerActor = original;
        const { authStore } = await new Function(loader)();
        if (
          !(await authStore.loginOnly(original.username, "fixture-password"))
            .success
        )
          throw new Error("A credential adoption failed");
      },
      { original, loader: AUTH_STORE_LOADER },
    );
  }
}
async function expiryAuthRoute(
  page: Page,
  holdFirst: boolean,
  original: any,
  expireOnPreflight = false,
): Promise<ExpiryAuthRoute> {
  let held: Route | undefined;
  let first = true;
  let actor = original;
  const loginHandler = (route: Route) =>
    route.fulfill({ json: { key: "expiry-fixture-session" } });
  const userHandler = async (route: Route) => {
    if (
      holdFirst &&
      first &&
      route.request().headers()["x-expiry-preflight"] === "1"
    ) {
      first = false;
      // Model expiry when the server receives this request. A background
      // refresh during the held response must observe the same expired
      // session, rather than a contradictory successful login response.
      if (expireOnPreflight) actor = null;
      held = route;
      return;
    }
    return actor
      ? route.fulfill({ json: actor })
      : route.fulfill({ status: 401, json: { detail: "Signed out" } });
  };
  await page.route("**/api/auth/login/", loginHandler);
  await page.route("**/api/auth/user/", userHandler);
  return {
    held: () => held,
    setActor: (next) => {
      actor = next;
    },
    fulfillHeld: async (response) => {
      const request = held;
      held = undefined;
      if (!request) throw new Error("no held expiry auth request to fulfill");
      await request.fulfill(response);
    },
    dispose: async () => {
      if (held) {
        try {
          await held.abort("failed");
        } catch {
          // The test may already have fulfilled the held request.
        }
        held = undefined;
      }
      await page.unroute("**/api/auth/user/", userHandler);
      await page.unroute("**/api/auth/login/", loginHandler);
    },
  };
}
async function installOwnedExpiryPreflight(page: Page, original: any) {
  await page.evaluate(
    async ({ original, loader }) => {
      (window as any).expiryServerActor = original;
      const { authStore } = await new Function(loader)();
      const native = window.fetch;
      window.fetch = (input, options) => {
        if (
          (window as any).expiryLookupPending &&
          String(input).endsWith("/api/auth/user/")
        ) {
          (window as any).expiryLookupPending = false;
          const headers = new Headers(options?.headers);
          headers.set("x-expiry-preflight", "1");
          return native(input, { ...options, headers });
        }
        return native(input, options);
      };
      const ensureAuthenticated = authStore.ensureAuthenticated;
      authStore.ensureAuthenticated = () => {
        (window as any).expiryLookupPending = true;
        // Expire only the validation cache at invocation. Preserve the native
        // ordinary check, including its reuse and ownership semantics.
        const now = Date.now;
        Date.now = () => now() + 16_000;
        try {
          return ensureAuthenticated().finally(
            () => ((window as any).expiryPreflightDone = true),
          );
        } finally {
          Date.now = now;
        }
      };
    },
    { original, loader: AUTH_STORE_LOADER },
  );
}
for (const component of Object.keys(
  scopedPaidEndpoints,
) as ScopedPaidComponent[]) {
  test(`${component} owned authentication expiry explains sign-in without minting or sending a payment`, async ({
    page,
  }) => {
    const { button, fixture, original } = await paidExpirySetup(
      page,
      component,
    );
    let posts = 0;
    await page.route(scopedPaidEndpoints[component], (route) => {
      posts++;
      return route.fulfill({ json: scopedPaidSuccess(component) });
    });
    const before = await paidReplayStorage(page);
    const authRoute = await expiryAuthRoute(page, true, original, true);
    await installOwnedExpiryPreflight(page, original);
    // Keep the real billing layout/socket active, but order its competing auth
    // read after the paid preflight and hold every replacement until the stale
    // response has arrived. This is the ordering that used to lose the toast.
    const replacements: Route[] = [];
    let preflightStarted = false;
    let releaseReplacements = false;
    const competingAuth = async (route: Route) => {
      if (route.request().headers()["x-expiry-preflight"] === "1") {
        preflightStarted = true;
        return route.fallback();
      }
      if (!preflightStarted) return route.fallback();
      if (releaseReplacements)
        return route.fulfill({ status: 401, json: { detail: "Signed out" } });
      replacements.push(route);
    };
    if (component === "vote")
      await page.route("**/api/auth/user/", competingAuth);
    await page.evaluate(async (loader) => {
      const { authStore } = await new Function(loader)();
      (window as any).ownedExpiryDiagnostic =
        authStore.captureRequestOwnership();
    }, AUTH_STORE_LOADER);
    await button.click();
    await expect.poll(() => Boolean(authRoute.held())).toBe(true);
    if (component === "vote") {
      await page.evaluate(async (loader) => {
        const { authStore } = await new Function(loader)();
        void authStore.checkAuth({ force: true, fresh: true, silent: true });
      }, AUTH_STORE_LOADER);
      await expect.poll(() => replacements.length).toBeGreaterThan(0);
    }
    await page.evaluate(() => ((window as any).expiryServerActor = null));
    authRoute.setActor(null);
    await authRoute.fulfillHeld({
      status: 401,
      json: { detail: "Private expired payment detail" },
    });
    if (component === "vote") {
      await page.waitForTimeout(100);
      expect(
        await page.evaluate(() => Boolean((window as any).expiryPreflightDone)),
      ).toBe(false);
      releaseReplacements = true;
      await Promise.all(
        replacements.map((route) =>
          route.fulfill({
            status: 401,
            json: { detail: "Signed out" },
          }),
        ),
      );
    }
    await expect
      .poll(() => page.evaluate(() => (window as any).expiryPreflightDone))
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).ownedExpiryDiagnostic?.wasExpired?.(),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(async (loader) => {
          const { toastPresentation } = await new Function(loader)();
          let ready = false;
          toastPresentation.subscribe((value: any) => (ready = value.ready))();
          return ready;
        }, TOAST_LOADER),
      )
      .toBe(true);
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: genericExpiryGuidance }),
    ).toHaveCount(1);
    expect(await expiryActorState(page)).toEqual({
      status: "anonymous",
      username: null,
    });
    expect(posts).toBe(0);
    expect(await paidReplayStorage(page)).toEqual(before);
    await expect(
      page.getByText("Private expired payment detail", { exact: true }),
    ).toHaveCount(0);
    if (component === "comment" || component === "converse") {
      await expect(fixture.locator("textarea")).toHaveCount(0);
      // Private composers are hidden while anonymous. Reauthenticate their
      // original owner to prove the existing draft survived that privacy UI.
      authRoute.setActor(original);
      await page.evaluate(async (original) => {
        (window as any).expiryServerActor = original;
        const module = "/src/lib/stores/auth.ts";
        if (
          !(
            await (
              await import(module)
            ).authStore.loginOnly(original.username, "fixture-password")
          ).success
        )
          throw new Error("Draft owner's credential adoption failed");
      }, original);
      await expect(fixture.locator("textarea")).toHaveValue(
        "Original paid request content",
      );
      expect(posts).toBe(0);
      expect(await paidReplayStorage(page)).toEqual(before);
    }
    if (component === "cover") {
      await expect(
        fixture.getByRole("textbox", { name: "Describe your cover image" }),
      ).toHaveValue("");
      await expect(fixture.getByRole("checkbox")).not.toBeChecked();
      await expect(button).toBeDisabled();
    }
    if (component === "boost")
      await expect(page.getByRole("dialog")).toBeVisible();
    expect(await page.evaluate(() => (window as any).scopedPaidCallback)).toBe(
      0,
    );
    if (component === "vote")
      await page.unroute("**/api/auth/user/", competingAuth);
    await authRoute.dispose();
  });
}
for (const transition of [
  "logout",
  "other-account",
  "return-original",
  "destroy",
] as const) {
  test(`vote held authentication expiry stays silent after ${transition}`, async ({
    page,
  }) => {
    const { button, original } = await paidExpirySetup(page, "vote");
    let posts = 0;
    await page.route(scopedPaidEndpoints.vote, (route) => {
      posts++;
      return route.fulfill({ json: scopedPaidSuccess("vote") });
    });
    const before = await paidReplayStorage(page);
    const authRoute = await expiryAuthRoute(page, true, original);
    await installOwnedExpiryPreflight(page, original);
    await button.click();
    await expect.poll(() => Boolean(authRoute.held())).toBe(true);
    await changeExpiryOwner(page, transition, original, authRoute);
    await authRoute.fulfillHeld({
      status: 401,
      json: { detail: "Private expired payment detail" },
    });
    await expect
      .poll(() => page.evaluate(() => (window as any).expiryPreflightDone))
      .toBe(true);
    if (transition !== "destroy") await expect(button).toBeEnabled();
    expect(await expiryActorState(page)).toEqual(
      transition === "logout" || transition === "destroy"
        ? { status: "anonymous", username: null }
        : {
            status: "authenticated",
            username:
              transition === "other-account"
                ? "other-account"
                : original.username,
          },
    );
    expect(posts).toBe(0);
    expect(await paidReplayStorage(page)).toEqual(before);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await expect(
      page.getByText("Private expired payment detail", { exact: true }),
    ).toHaveCount(0);
    await authRoute.dispose();
  });
}
for (const status of [401, 403]) {
  test(`boost owned POST ${status} preserves its replay handle and explains sign-in`, async ({
    page,
  }) => {
    const { button, original } = await paidExpirySetup(page, "boost");
    await page.evaluate(
      (original) => ((window as any).expiryServerActor = original),
      original,
    );
    const authRoute = await expiryAuthRoute(page, false, original);
    let held: Route | undefined,
      posts = 0;
    await page.route(scopedPaidEndpoints.boost, (route) => {
      posts++;
      held = route;
    });
    await button.click();
    await expect.poll(() => Boolean(held)).toBe(true);
    const key = held!.request().headers()["idempotency-key"];
    expect(key).toBeTruthy();
    const before = await paidReplayStorage(page);
    await page.evaluate(() => ((window as any).expiryServerActor = null));
    authRoute.setActor(null);
    await held!.fulfill({
      status,
      json: { detail: "Private expired payment detail" },
    });
    await expect(button).toBeEnabled();
    expect(await expiryActorState(page)).toEqual({
      status: "anonymous",
      username: null,
    });
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: genericExpiryGuidance }),
    ).toHaveCount(1);
    await expect(
      page.getByText("Private expired payment detail", { exact: true }),
    ).toHaveCount(0);
    expect(await paidReplayStorage(page)).toEqual(before);
    expect(posts).toBe(1);
    expect(await page.evaluate(() => (window as any).scopedPaidCallback)).toBe(
      0,
    );
    await authRoute.dispose();
  });
}
for (const transition of [
  "logout",
  "other-account",
  "return-original",
  "destroy",
] as const) {
  test(`boost held POST expiry stays silent and keeps its replay handle after ${transition}`, async ({
    page,
  }) => {
    const { button, original } = await paidExpirySetup(page, "boost");
    await page.evaluate(
      (original) => ((window as any).expiryServerActor = original),
      original,
    );
    const authRoute = await expiryAuthRoute(page, false, original);
    let held: Route | undefined,
      posts = 0;
    await page.route(scopedPaidEndpoints.boost, (route) => {
      posts++;
      held = route;
    });
    await button.click();
    await expect.poll(() => Boolean(held)).toBe(true);
    const key = held!.request().headers()["idempotency-key"];
    expect(key).toBeTruthy();
    const before = await paidReplayStorage(page);
    await changeExpiryOwner(page, transition, original, authRoute);
    await held!.fulfill({
      status: 401,
      json: { detail: "Private expired payment detail" },
    });
    if (transition !== "destroy") await expect(button).toBeEnabled();
    else
      await expect
        .poll(async () => (await expiryActorState(page)).status)
        .toBe("anonymous");
    expect(await expiryActorState(page)).toEqual(
      transition === "logout" || transition === "destroy"
        ? { status: "anonymous", username: null }
        : {
            status: "authenticated",
            username:
              transition === "other-account"
                ? "other-account"
                : original.username,
          },
    );
    expect(await paidReplayStorage(page)).toEqual(before);
    expect(posts).toBe(1);
    expect(await page.evaluate(() => (window as any).scopedPaidCallback)).toBe(
      0,
    );
    await authRoute.dispose();
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await expect(
      page.getByText("Private expired payment detail", { exact: true }),
    ).toHaveCount(0);
  });
}

test("a second actual credit during Notifications action exit survives the old summary removal", async ({
  page,
  request,
}) => {
  await initialRecoveryBarrier(page);
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect
    .poll(() => page.evaluate(() => (window as any).initialRecoverySettled))
    .toBe(true);
  await expect
    .poll(async () => (await expiryActorState(page)).status)
    .toBe("authenticated");
  await emit(page, "action-exit-first-credit", "BOUGHT_TUZI");
  const first = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Payment received — 2,500 2Z credited." });
  await expect(first).toBeVisible();
  await expect(
    first.getByRole("button", { name: "Notifications", exact: true }),
  ).toBeEnabled();
  await request.post(
    `${browserMockApiOrigin()}/__billing/balance?amount=64697.234`,
  );
  await page.evaluate(() => {
    const notice = Array.from(
      document.querySelectorAll("[data-sonner-toast]"),
    ).find((node) => node.textContent?.includes("Payment received"))!;
    (
      Array.from(notice.querySelectorAll("button")).find(
        (button) => button.textContent === "Notifications",
      ) as HTMLButtonElement
    ).click();
    // Same browser task, before Sonner's 200ms exit can remove the old node.
    (window as any).purchaseSocket.onmessage({
      data: JSON.stringify({
        content: {
          id: "action-exit-second-credit",
          type: "BOUGHT_TUZI",
          amount: 25,
          receiving_user: { username: "fixtureowner" },
          message: "You bought 25 tuzi",
          created_at: new Date().toISOString(),
        },
      }),
    });
  });
  const latest = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Payment received — 25 2Z credited." });
  await expect(latest).toBeVisible();
  await expect(first).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelectorAll("[data-sonner-toast]").length,
      ),
    )
    .toBeLessThanOrEqual(3);
  await page.waitForTimeout(4500);
  await expect(latest).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const module = "/src/lib/stores/eventNotifications.ts";
      let state: any;
      (await import(module)).eventNotifications.subscribe(
        (value: any) => (state = value),
      )();
      return state.events
        .filter((event: any) => event.id.startsWith("action-exit-"))
        .map((event: any) => event.id)
        .sort();
    }),
  ).toEqual(["action-exit-first-credit", "action-exit-second-credit"]);
  await latest.getByRole("button", { name: "Close notification" }).click();
  await expect(latest).toHaveCount(0);
});

test("a prevented payment action keeps a callback-delivered actual credit visible", async ({
  page,
}) => {
  await initialRecoveryBarrier(page);
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await expect
    .poll(() => page.evaluate(() => (window as any).initialRecoverySettled))
    .toBe(true);
  await expect
    .poll(async () => (await expiryActorState(page)).status)
    .toBe("authenticated");
  await emit(page, "prevented-first-credit", "BOUGHT_TUZI");
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Payment received — 2,500 2Z credited." }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    (await import(module)).paymentCreditedToast(
      "Payment received — 2,500 2Z credited.",
      {
        action: {
          label: "Keep payment open",
          onClick: (event: MouseEvent) => {
            event.preventDefault();
            (window as any).purchaseSocket.onmessage({
              data: JSON.stringify({
                content: {
                  id: "prevented-second-credit",
                  type: "BOUGHT_TUZI",
                  amount: 17,
                  receiving_user: { username: "fixtureowner" },
                  message: "You bought 17 tuzi",
                  created_at: new Date().toISOString(),
                },
              }),
            });
          },
        },
      },
    );
  });
  await page
    .getByRole("button", { name: "Keep payment open", exact: true })
    .click();
  const latest = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Payment received — 17 2Z credited." });
  await expect(latest).toBeVisible();
  await page.waitForTimeout(4500);
  await expect(latest).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const module = "/src/lib/toast.ts";
      return (await import(module)).toastQueueStatus();
    }),
  ).toMatchObject({ rendered: 1, paymentQueued: false });
  await latest.getByRole("button", { name: "Close notification" }).click();
  await expect(latest).toHaveCount(0);
});

for (const control of ["action", "cancel"] as const) {
  test(`a captured old ${control} callback cannot execute privately or retire the new account's reused ID`, async ({
    page,
  }) => {
    const { original } = await paidExpirySetup(page, "vote");
    await page.evaluate(
      (original) => ((window as any).expiryServerActor = original),
      original,
    );
    const authRoute = await expiryAuthRoute(page, false, original);
    await page.evaluate(async (control) => {
      const module = "/src/lib/toast.ts";
      const { toast } = await import(module);
      (window as any).oldPrivateActionCalls = 0;
      toast.info("Original account private action", {
        id: "reused-private-action",
        [control]: {
          label: "Original action",
          onClick: () => (window as any).oldPrivateActionCalls++,
        },
      });
    }, control);
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Original account private action" }),
    ).toBeVisible();
    await page.evaluate(async (control) => {
      const module = "/src/lib/toast.ts";
      const { toast } = await import(module);
      (window as any).oldPrivateAction = toast
        .getActiveToasts()
        .find((notice: any) => notice.id === "reused-private-action")[
        control
      ].onClick;
    }, control);
    await changeExpiryOwner(page, "other-account", original, authRoute);
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Original account private action" }),
    ).toHaveCount(0);
    await page.evaluate(async () => {
      const module = "/src/lib/toast.ts";
      (await import(module)).toast.info("New account retained action", {
        id: "reused-private-action",
        action: { label: "New account action", onClick: () => {} },
      });
    });
    const retained = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "New account retained action" });
    await expect(retained).toBeVisible();
    expect(
      await page.evaluate(() => {
        const event = new MouseEvent("click", { cancelable: true });
        (window as any).oldPrivateAction(event);
        return {
          calls: (window as any).oldPrivateActionCalls,
          prevented: event.defaultPrevented,
        };
      }),
    ).toEqual({ calls: 0, prevented: true });
    await page.waitForTimeout(4500);
    await expect(retained).toBeVisible();
    await retained.getByRole("button", { name: "Close notification" }).click();
    await expect(retained).toHaveCount(0);
  });
}

test("one active legacy stream notice cannot stall a new credit or exceed physical presentation capacity", async ({
  page,
}) => {
  await paidExpirySetup(page, "vote");
  await page.evaluate(async () => {
    const module = "/tests/browser/legacy-stream-toast-fixture.svelte",
      svelte = "/tests/browser/svelte-runtime.ts";
    const [{ default: Fixture }, { mount }] = await Promise.all([
      import(module),
      import(svelte),
    ]);
    const target = document.createElement("div");
    document.querySelector("main")!.prepend(target);
    mount(Fixture, { target });
    (window as any).mixedMaximumToastNodes = 0;
    new MutationObserver(
      () =>
        ((window as any).mixedMaximumToastNodes = Math.max(
          (window as any).mixedMaximumToastNodes,
          document.querySelectorAll("[data-sonner-toast]").length,
        )),
    ).observe(document.body, { childList: true, subtree: true });
  });
  await page
    .getByRole("button", { name: "Show legacy stream notice", exact: true })
    .click();
  const legacy = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Legacy stream remains active" });
  await expect(legacy).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    (await import(module)).toast.info("Managed activity to acknowledge");
  });
  const activity = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Managed activity to acknowledge" });
  await expect(activity).toBeVisible();
  await activity.getByRole("button", { name: "Close notification" }).click();
  await emit(page, "mixed-legacy-credit", "BOUGHT_TUZI");
  const payment = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Payment received — 2,500 2Z credited." });
  await expect(payment).toBeVisible();
  await expect(activity).toHaveCount(0);
  await expect(legacy).toBeVisible();
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    const { toast } = await import(module);
    toast.error("First managed urgent action");
    toast.error("Second managed urgent action");
  });
  const first = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "First managed urgent action" });
  const second = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Second managed urgent action" });
  await expect(first).toBeVisible();
  await expect(second).toHaveCount(0);
  await legacy.getByRole("button", { name: "Close notification" }).click();
  await expect(second).toBeVisible();
  await expect(payment).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).mixedMaximumToastNodes),
  ).toBeLessThanOrEqual(3);
});

test("detected payment stays dismissible until credit and late detection stays quiet", async ({
  page,
}) => {
  await initialRecoveryBarrier(page);
  await page.goto("/fixtureowner/dashboard/billing?tab=zcash");
  await billingInitialActorBarrier(page, "fixtureowner");
  await expect
    .poll(() => page.evaluate(() => (window as any).initialRecoverySettled))
    .toBe(true);
  const reference = {
    payment_id: "11111111-2222-4333-8444-555555555555",
    status: "pending",
  };
  await emit(page, "early-observation", "ZEC_PENDING", false, reference);
  const pending = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Your Zcash payment was detected." });
  await expect(pending).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const module = "/src/lib/toast.ts";
      const { toast } = await import(module);
      return (
        toast
          .getActiveToasts()
          .find(
            (notice: any) =>
              notice.id === "zec-pending-11111111-2222-4333-8444-555555555555",
          )?.duration === Infinity
      );
    }),
  ).toBe(true);
  await expect(
    pending.getByRole("button", { name: "Close notification" }),
  ).toBeVisible();
  await emit(page, "completed-credit", "BOUGHT_TUZI", false, {
    ...reference,
    status: "credited",
  });
  await expect(pending).toHaveCount(0);
  const credited = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Payment received — 2,500 2Z credited." });
  await expect(credited).toBeVisible();
  await emit(page, "late-observation", "ZEC_PENDING", false, reference);
  await expect(pending).toHaveCount(0);
  await credited.getByRole("button", { name: "Close notification" }).click();
  await expect(credited).toHaveCount(0);
});

for (const status of [401, 403]) {
  test(`anonymous ${status} rejection fences a delayed identity before a mounted boost`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { button, original } = await paidExpirySetup(page, "boost");
    let heldIdentity: Route | undefined;
    const posts: string[] = [];
    await page.route(scopedPaidEndpoints.boost, (route) => {
      posts.push(route.request().postData() ?? "");
      return route.fulfill({ json: scopedPaidSuccess("boost") });
    });
    await page.route("**/api/creator/sol-expiry/", (route) =>
      route.fulfill({ status, json: { detail: "Session revoked" } }),
    );
    await page.route("**/api/auth/user/", (route) => {
      if (route.request().headers()["x-pr2615-revival"] === "1") {
        heldIdentity = route;
        return;
      }
      return route.fulfill({ status, json: { detail: "Session revoked" } });
    });
    const replayBefore = await paidReplayStorage(page);
    await page.evaluate(async () => {
      const authModule = "/src/lib/stores/auth.ts";
      const mutatorModule = "/src/lib/api/mutator.ts";
      const [{ authStore }, { customInstance }] = await Promise.all([
        import(authModule),
        import(mutatorModule),
      ]);
      authStore.clear();
      (window as any).pr2615UuidCount = 0;
      const randomUUID = crypto.randomUUID.bind(crypto);
      crypto.randomUUID = () => {
        (window as any).pr2615UuidCount += 1;
        return randomUUID();
      };
      const nativeFetch = window.fetch;
      window.fetch = (input, init) => {
        if (
          (window as any).pr2615HoldIdentity &&
          String(input).endsWith("/api/auth/user/")
        ) {
          (window as any).pr2615HoldIdentity = false;
          const headers = new Headers(init?.headers);
          headers.set("x-pr2615-revival", "1");
          return nativeFetch(input, { ...init, headers });
        }
        return nativeFetch(input, init);
      };
      (window as any).pr2615HoldIdentity = true;
      (window as any).pr2615Identity = authStore.checkAuth({
        force: true,
        silent: true,
      });
      (window as any).pr2615Reject = () =>
        customInstance("/api/creator/sol-expiry/").catch(() => {});
    });

    await expect.poll(() => Boolean(heldIdentity)).toBe(true);
    expect(await expiryActorState(page)).toEqual({
      status: "anonymous",
      username: null,
    });
    await page.evaluate(() => (window as any).pr2615Reject());
    expect(await expiryActorState(page)).toEqual({
      status: "anonymous",
      username: null,
    });
    await heldIdentity!.fulfill({ json: original });
    expect(await page.evaluate(() => (window as any).pr2615Identity)).toBe(
      false,
    );
    expect(await expiryActorState(page)).toEqual({
      status: "anonymous",
      username: null,
    });
    expect(await page.evaluate(() => localStorage.getItem("auth"))).toBeNull();

    await button.click();
    await expect(button).toBeEnabled();
    expect(posts).toEqual([]);
    expect(await page.evaluate(() => (window as any).pr2615UuidCount)).toBe(0);
    expect(await paidReplayStorage(page)).toEqual(replayBefore);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  });
}

test("a native comment preflight retains its draft until the owned replacement confirms authentication", async ({
  page,
}) => {
  const { button, fixture, original } = await paidExpirySetup(page, "comment");
  let posts = 0;
  await page.route(scopedPaidEndpoints.comment, (route) => {
    posts++;
    expect(route.request().postDataJSON().content).toBe(
      "Original paid request content",
    );
    return route.fulfill({ json: scopedPaidSuccess("comment") });
  });
  const authRoute = await expiryAuthRoute(page, true, original);
  await installOwnedExpiryPreflight(page, original);
  const replacements: Route[] = [];
  let preflightStarted = false;
  let released = false;
  await page.route("**/api/auth/user/", (route) => {
    if (route.request().headers()["x-expiry-preflight"] === "1") {
      preflightStarted = true;
      return route.fallback();
    }
    if (!preflightStarted) return route.fallback();
    if (released) return route.fulfill({ json: original });
    replacements.push(route);
  });
  await button.click();
  await expect.poll(() => Boolean(authRoute.held())).toBe(true);
  await page.evaluate(async (loader) => {
    const { authStore } = await new Function(loader)();
    void authStore.checkAuth({ force: true, fresh: true, silent: true });
  }, AUTH_STORE_LOADER);
  await expect.poll(() => replacements.length).toBeGreaterThan(0);
  await authRoute.fulfillHeld({ json: original });
  await page.waitForTimeout(100);
  expect(posts).toBe(0);
  await expect(fixture.locator("textarea")).toHaveValue(
    "Original paid request content",
  );
  released = true;
  await Promise.all(
    replacements.map((route) => route.fulfill({ json: original })),
  );
  await expect.poll(() => posts).toBe(1);
  await expect(fixture.locator("textarea")).toHaveValue("");
  expect(await page.evaluate(() => (window as any).scopedPaidCallback)).toBe(1);
  expect(await expiryActorState(page)).toEqual({
    status: "authenticated",
    username: original.username,
  });
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: genericExpiryGuidance }),
  ).toHaveCount(0);
  await authRoute.dispose();
});

test("notification metadata refuses a stale recipient until an explicit account reset", async ({
  page,
}) => {
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({ status: 401, json: { detail: "Signed out" } }),
  );
  await page.goto("/search");
  await expect
    .poll(async () => (await expiryActorState(page)).status)
    .toBe("anonymous");
  let recipient = "fixtureowner";
  let requests = 0;
  await page.route("**/api/events/has/", (route) => {
    requests++;
    return route.fulfill({ json: true });
  });
  await page.route("**/api/events/unread_count/**", (route) => {
    requests++;
    return route.fulfill({
      json: {
        unread_count: recipient === "fixtureowner" ? 7 : 3,
        recipient_username: recipient,
      },
    });
  });
  const metadata = (username: string, reset: boolean) =>
    page.evaluate(
      async ({ loader, username, reset }) => {
        const { eventNotifications } = await new Function(loader)();
        if (reset) eventNotifications.clearForLogout();
        await eventNotifications.refreshMeta(username);
        let count = -1;
        eventNotifications.subscribe(
          (state: any) => (count = state.unreadCount),
        )();
        return count;
      },
      { loader: EVENT_NOTIFICATIONS_LOADER, username, reset },
    );
  expect(await metadata("fixtureowner", true)).toBe(7);
  const before = requests;
  recipient = "other-account";
  expect(await metadata("other-account", false)).toBe(7);
  expect(requests).toBe(before);
  expect(await metadata("other-account", true)).toBe(3);
  expect(requests).toBe(before + 2);
});
