import { expect, test, type Page } from "@playwright/test";
import { SONNER_LOADER } from "./dev-source-module";

//  -- the pay-per-view prompt sells nothing.
//
// It used to transfer the per-minute price to the creator as an "unlock" and
// then retry the join. Admission is a balance reserve (ceil(price * 30) + 15),
// and nothing recorded the payment, so the prompt -- reachable only after a
// join was refused for being under that reserve -- took 2Z from a viewer it
// could not admit, again on every retry. The server now refuses the unlock
// (py/dj/apps/dyte/test_ppv_unlock_sequence.py); these pin the page's half:
// no money request leaves the browser from this dialog, under the reserve it
// says so and offers no button, and at the reserve "Start Watching" is just
// the join again.
//
// No spec here reaches RealtimeKit: every join is answered by a route stub,
// so the assertions are about what the page ASKED the server for.

const OWNER = "livefixture";
const PRICE = "2.00";
const RESERVE = 75; // ceil(2 * 30) + 15

test("payment action waits for dismissal and clears when leaving its stream", async ({
  page,
}) => {
  test.setTimeout(60_000); // cold stream compilation plus deliberate 9-second persistence wait
  await signInWithBalance(page, "74.000");
  await stubLivePpv(page);
  await refuseJoins(page, "74.000");
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts";
    await (
      await import(module)
    ).authStore.checkAuth({ force: true, fresh: true, silent: true });
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/lib/toast.ts";
        let ready = false;
        (await import(module)).toastPresentation.subscribe(
          (value: { ready: boolean; generation: number }) =>
            (ready = value.ready && value.generation > 0),
        )();
        return ready;
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    const { toast } = await import(module);
    toast.success("Routine copy completed");
  });
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Routine copy completed" }),
  ).toBeVisible();
  await page.evaluate(async (owner) => {
    const module =
      "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
    await (await import(module)).goto(`/${owner}/ppv?lang=en`);
  }, OWNER);
  const action = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Payment required to watch." });
  await expect(action).toBeVisible();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(9000);
  await expect(action).toBeVisible();
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Routine copy completed" }),
  ).toHaveCount(0);
  await page.evaluate(async (loader) => {
    const { toast } = await new Function(loader)();
    toast.loading("Export keeps running", { id: "stream-unrelated-progress" });
    (window as any).streamNavigationMarker = true;
  }, SONNER_LOADER);
  await page.getByRole("link", { name: "Go to homepage" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(
    await page.evaluate(() => (window as any).streamNavigationMarker),
  ).toBe(true);
  await expect(action).toHaveCount(0);
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Export keeps running" }),
  ).toBeVisible();
});

async function signInWithBalance(page: Page, tuzis: string) {
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "profile-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route("**/api/auth/user/", async (route) => {
    const response = await route.fetch();
    const user = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({ ...user, tuzis }),
    });
  });
}

async function stubLivePpv(page: Page) {
  await page.route(`**/api/dyte/${OWNER}/live-status`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        is_live: true,
        participant_count: 3,
        streams: [
          {
            type: "ppv",
            participant_count: 3,
            price_per_minute: PRICE,
          },
        ],
      }),
    }),
  );
}

/** Every join POST, refused as the server refuses an under-reserve viewer. */
async function refuseJoins(page: Page, balance: string) {
  const joins: unknown[] = [];
  await page.route(`**/api/dyte/${OWNER}/ppv`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    joins.push(route.request().postDataJSON() ?? {});
    return route.fulfill({
      status: 402,
      contentType: "application/json",
      body: JSON.stringify({
        code: "insufficient_funds",
        cost: `${RESERVE}.000`,
        balance,
        shortfall: "1.000",
        action: "stream_join",
      }),
    });
  });
  return joins;
}

/** Any money request at all: the dialog must never send one. */
function recordMoneyRequests(page: Page) {
  const money: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      new URL(request.url()).pathname.startsWith("/api/tuzis/")
    ) {
      money.push(`${request.method()} ${request.url()}`);
    }
  });
  return money;
}

test("under the reserve the prompt explains it and offers nothing to buy", async ({
  page,
}) => {
  const money = recordMoneyRequests(page);
  await signInWithBalance(page, "74.000");
  await stubLivePpv(page);
  const joins = await refuseJoins(page, "74.000");

  await page.goto(`/${OWNER}/ppv?lang=en`);
  await expect.poll(() => joins.length).toBe(1);

  await page.getByRole("button", { name: /Start Watching \(2/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("insufficient-funds")).toBeVisible();
  // The old dialog offered "Start Watching (2 2Z)" here -- a 74 balance can
  // "afford" a 2Z unlock -- and that click was the money leak.
  await expect(dialog.getByRole("button", { name: /Start/ })).toHaveCount(0);
  await expect(dialog.getByTestId("ppv-reserve")).toContainText("75");

  expect(money).toEqual([]);
  expect(joins).toHaveLength(1);

  // The quote is cached and the server is the authority (a restart at a
  // lower price lowers the reserve), so a non-paying retry stays reachable:
  // it is the join again, never a payment.
  await dialog.getByTestId("ppv-retry-join").click();
  await expect.poll(() => joins.length).toBe(2);
  expect(joins[1]).toEqual({ role: "viewer", expected_actor_id: 4498 });
  expect(money).toEqual([]);
});

test("at the reserve Start Watching joins again and pays nothing", async ({
  page,
}) => {
  const money = recordMoneyRequests(page);
  // The page loaded under the reserve; the viewer has since topped up.
  await signInWithBalance(page, `${RESERVE}.000`);
  await stubLivePpv(page);
  const joins = await refuseJoins(page, "74.000");

  await page.goto(`/${OWNER}/ppv?lang=en`);
  await expect.poll(() => joins.length).toBe(1);

  await page.getByRole("button", { name: /Start Watching \(2/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("insufficient-funds")).toHaveCount(0);
  // By role, not test id: the old dialog's "Start Watching (2 2Z)" matches
  // too, so against it this click is the unlock and `money` is not empty.
  await dialog.getByRole("button", { name: /^Start Watching/ }).click();

  await expect.poll(() => joins.length).toBe(2);
  expect(joins[1]).toEqual({ role: "viewer", expected_actor_id: 4498 });
  expect(money).toEqual([]);
});

test("without a rate on screen the prompt offers no join at all", async ({
  page,
}) => {
  const money = recordMoneyRequests(page);
  await signInWithBalance(page, "500.000");
  // The quote lookup fails after the refusal, so the price is unknown.
  await page.route(`**/api/dyte/${OWNER}/live-status`, (route) =>
    route.fulfill({ status: 503, body: "" }),
  );
  const joins = await refuseJoins(page, "74.000");

  await page.goto(`/${OWNER}/ppv?lang=en`);
  await expect.poll(() => joins.length).toBe(1);

  await page.getByRole("button", { name: /^Start Watching/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("unavailable");
  await expect(dialog.getByTestId("ppv-start-watching")).toHaveCount(0);
  await expect(dialog.getByTestId("ppv-retry-join")).toHaveCount(0);

  expect(joins).toHaveLength(1);
  expect(money).toEqual([]);
});

test("paid viewer join refuses a different session before granting a chargeable token", async ({
  page,
}) => {
  await signInWithBalance(page, "100.000");
  await stubLivePpv(page);
  const joins = await refuseJoins(page, "100.000");
  // First establish A in the real client. The held ownership transition being
  // exercised is A's join verification discovering B, not cold hydration.
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts";
    await (
      await import(module)
    ).authStore.checkAuth({ force: true, fresh: true, silent: true });
  });
  await expect(
    page.getByRole("button", { name: "Profile", exact: true }),
  ).toBeVisible();
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({
      json: { id: 9999, username: "other-viewer", tuzis: "100.000" },
    }),
  );
  await page.evaluate(async (owner) => {
    const module =
      "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
    await (await import(module)).goto(`/${owner}/ppv?lang=en`);
  }, OWNER);
  await expect(
    page.getByText("Joining stream...", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByText("Sign in again before continuing.", { exact: false })
      .first(),
  ).toBeVisible();
  expect(joins).toEqual([]);
});

test("a server-side actor switch refusal is visible without automatic paid-join retries", async ({
  page,
}) => {
  await signInWithBalance(page, "100.000");
  await stubLivePpv(page);
  const joins: unknown[] = [];
  await page.route(`**/api/dyte/${OWNER}/ppv`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    joins.push(route.request().postDataJSON());
    return route.fulfill({
      status: 409,
      json: { code: "actor_changed", detail: "The original actor changed." },
    });
  });
  await page.goto(`/${OWNER}/ppv?lang=en`);
  await expect(
    page
      .getByText("Sign in again before continuing.", { exact: false })
      .first(),
  ).toBeVisible();
  expect(joins).toEqual([{ role: "viewer", expected_actor_id: 4498 }]);
  await expect(
    page.getByText("Retrying connection...", { exact: true }),
  ).toHaveCount(0);
});

test("temporary paid-viewer verification failure blocks admission and retries the original actor after recovery", async ({
  page,
}) => {
  await signInWithBalance(page, "100.000");
  await stubLivePpv(page);
  const joins = await refuseJoins(page, "100.000");
  let available = false;
  let checks = 0;
  let releaseRecovery!: () => void;
  const recoveryHeld = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  let recoveryStarted = false;
  await page.route("**/api/auth/user/", async (route) => {
    checks++;
    if (available) {
      recoveryStarted = true;
      await recoveryHeld;
      return route.fallback();
    }
    return route.fulfill({
      status: 503,
      json: { detail: "Temporarily unavailable" },
    });
  });
  await page.goto(`/${OWNER}/ppv?lang=en`);
  await expect(
    page
      .getByText("We couldn't verify your account just now. Please retry.", {
        exact: false,
      })
      .first(),
  ).toBeVisible();
  expect(checks).toBeGreaterThan(0);
  expect(joins).toEqual([]);
  available = true;
  await expect.poll(() => recoveryStarted).toBe(true);
  await expect(
    page.getByText("Retrying connection...", { exact: true }),
  ).toBeVisible();
  expect(joins).toEqual([]);
  releaseRecovery();
  await expect.poll(() => joins.length).toBe(1);
  expect(joins).toEqual([{ role: "viewer", expected_actor_id: 4498 }]);
});

async function leaveStreamWithoutReload(page: Page) {
  await page.evaluate(async () => {
    const path =
      "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
    const { goto } = await import(path);
    await goto("/converse?lang=en");
  });
  await expect(page).toHaveURL(/\/converse/);
}

async function sharedMeetingState(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/lib/stores/liveStreamStore.ts";
    const { liveStreamStore } = await import(path);
    let state: unknown;
    liveStreamStore.subscribe((value: any) => {
      state = {
        meeting: !!value.meeting,
        status: value.connectionStatus,
        error: value.error,
      };
    })();
    return state;
  });
}

for (const lateResult of [
  "verification failure",
  "successful token",
] as const) {
  test(`leaving a paid stream fences a delayed ${lateResult} without admission recovery or store mutation`, async ({
    page,
  }) => {
    await signInWithBalance(page, "100.000");
    await stubLivePpv(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    let joins = 0;
    await page.route(`**/api/dyte/${OWNER}/ppv`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      joins++;
      if (lateResult === "successful token") {
        started = true;
        await held;
      }
      await route
        .fulfill({ json: { auth_token: "abandoned-page-token" } })
        .catch(() => {});
    });
    if (lateResult === "verification failure") {
      await page.route("**/api/auth/user/", async (route) => {
        started = true;
        await held;
        await route.fulfill({
          status: 503,
          json: { detail: "Temporarily unavailable" },
        });
      });
    }
    await page.goto(`/${OWNER}/ppv?lang=en`);
    await expect.poll(() => started).toBe(true);
    await leaveStreamWithoutReload(page);
    const before = await sharedMeetingState(page);
    release();
    // Beyond the first recovery deadline: an abandoned component must not retry.
    await page.waitForTimeout(1600);
    expect(joins).toBe(lateResult === "successful token" ? 1 : 0);
    expect(await sharedMeetingState(page)).toEqual(before);
  });
}

test("late provider initialization leaves its abandoned meeting without replacing another stream", async ({
  page,
}) => {
  await signInWithBalance(page, "100.000");
  await stubLivePpv(page);
  await refuseJoins(page, "74.000");
  await page.goto(`/${OWNER}/ppv?lang=en`);
  await expect(
    page.getByRole("button", { name: /Start Watching/ }),
  ).toBeVisible();
  const result = await page.evaluate(async () => {
    const managerPath = "/src/lib/utils/rtk-manager.ts";
    const moduleText = await (await fetch(managerPath)).text();
    const sdkPath = moduleText.match(
      /from \"([^\"]*cloudflare_realtimekit[^\"]*)\"/,
    )?.[1];
    if (!sdkPath) throw new Error("Actual manager SDK import was not found");
    const { default: SDK } = await import(sdkPath);
    const { initRtkMeeting } = await import(managerPath);
    const storePath = "/src/lib/stores/liveStreamStore.ts";
    const { liveStreamStore } = await import(storePath);
    const originalInit = SDK.init;
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    SDK.init = () => pending;
    const controller = new AbortController();
    let left = 0;
    const abandoned = {
      leave: async () => {
        left++;
      },
    };
    const replacement = { meta: { meetingTitle: "replacement" } };
    try {
      const operation = initRtkMeeting({
        authToken: "old",
        streamType: "ppv",
        isHost: false,
        signal: controller.signal,
      }).catch((error: Error) => error.name);
      controller.abort();
      liveStreamStore.init(replacement, "broadcast", false);
      finish(abandoned);
      const outcome = await operation;
      let retained = false;
      liveStreamStore.subscribe((state: any) => {
        retained = state.meeting === replacement;
      })();
      const handlers: Record<string, (event?: unknown) => void> = {};
      let completeLeave!: () => void;
      const leaving = new Promise<void>((resolve) => {
        completeLeave = resolve;
      });
      const initialized = {
        meta: {},
        self: {
          on: (name: string, callback: (event?: unknown) => void) => {
            handlers[name] = callback;
          },
        },
        participants: {
          on: () => {},
          off: () => {},
          joined: { on: () => {}, off: () => {}, toArray: () => [] },
        },
        leave: () => leaving,
      };
      SDK.init = async () => initialized;
      const current = await initRtkMeeting({
        authToken: "initialized",
        streamType: "ppv",
        isHost: false,
      });
      const cleanup = current.cleanup();
      liveStreamStore.init(replacement, "broadcast", false);
      handlers.roomLeft({ state: "failed" });
      handlers.roomJoined();
      completeLeave();
      await cleanup;
      let cleanupRetained = false;
      liveStreamStore.subscribe((state: any) => {
        cleanupRetained =
          state.meeting === replacement &&
          state.connectionStatus === "initializing" &&
          state.error === null;
      })();
      return { left, retained, outcome, cleanupRetained };
    } finally {
      SDK.init = originalInit;
      liveStreamStore.reset();
    }
  });
  expect(result).toEqual({
    left: 1,
    retained: true,
    outcome: "AbortError",
    cleanupRetained: true,
  });
});

test("an established paid viewer leaves its original meeting when the displayed actor changes", async ({
  page,
}) => {
  await signInWithBalance(page, "100.000");
  await stubLivePpv(page);
  await refuseJoins(page, "74.000");
  await page.goto(`/${OWNER}/ppv?lang=en`);
  await expect(
    page.getByRole("button", { name: /Start Watching/ }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const moduleText = await (
      await fetch("/src/lib/utils/rtk-manager.ts")
    ).text();
    const sdkPath = moduleText.match(
      /from \"([^\"]*cloudflare_realtimekit[^\"]*)\"/,
    )?.[1];
    if (!sdkPath) throw new Error("Actual manager SDK import was not found");
    const { default: SDK } = await import(sdkPath);
    const handlers: Record<string, (...args: any[]) => void> = {};
    (window as any).__actorLeaveCalls = 0;
    SDK.init = async () => ({
      meta: {},
      self: {
        roomJoined: false,
        on: (name: string, callback: (...args: any[]) => void) => {
          handlers[name] = callback;
        },
        off: () => {},
      },
      participants: {
        on: () => {},
        off: () => {},
        joined: { on: () => {}, off: () => {}, toArray: () => [] },
      },
      leave: async () => {
        (window as any).__actorLeaveCalls++;
      },
    });
  });
  await page.route(`**/api/dyte/${OWNER}/ppv`, (route) =>
    route.fulfill({ json: { auth_token: "synthetic-paid-viewer-token" } }),
  );
  await page.getByRole("button", { name: /Start Watching/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Start Watching/ })
    .click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/lib/stores/liveStreamStore.ts";
        const { liveStreamStore } = await import(path);
        let connected = false;
        liveStreamStore.subscribe((state: any) => {
          connected = !!state.meeting;
        })();
        return connected;
      }),
    )
    .toBe(true);
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "profile-nodrafts-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.evaluate(async () => {
    const path =
      "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
    const { invalidateAll } = await import(path);
    await invalidateAll();
  });
  await expect(
    page
      .getByText("Sign in again before continuing.", { exact: false })
      .first(),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).__actorLeaveCalls))
    .toBe(1);
  expect(await sharedMeetingState(page)).toEqual({
    meeting: false,
    status: "idle",
    error: null,
  });
});
