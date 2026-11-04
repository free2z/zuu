import { expect, test, type Page, type Route } from "@playwright/test";
import { AUTH_STORE_LOADER, devSourceModuleLoader } from "./dev-source-module";

const USER = "streamaudienceowner";
const DASHBOARD = `/${USER}/dashboard/stream`;
const SECRET = "owner-a-private-secret";
const LIVE_STREAM_STORE_LOADER = devSourceModuleLoader(
  "/src/lib/stores/liveStreamStore.ts",
);

declare global {
  interface Window {
    hostTest: {
      copied: string[];
      sdkCalls: any[];
      joinCalls: number;
      left: number;
      finishProvider: () => void;
      finishSecondProvider: () => void;
      finishLeave: () => void;
      endRoom: (state?: string) => void;
    };
  }
}

async function prepareSession(page: Page) {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "stream-audience-owner-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.addInitScript(() => {
    window.hostTest = {
      copied: [],
      sdkCalls: [],
      joinCalls: 0,
      left: 0,
      finishProvider: () => {},
      finishSecondProvider: () => {},
      finishLeave: () => {},
      endRoom: () => {},
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (url: string) => window.hostTest.copied.push(url),
      },
    });
  });
  await page.route(`**/api/dyte/${USER}/host-session`, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      json: {
        active: false,
        host_session: null,
        meeting_type: null,
        last_seen_at: null,
        ttl_seconds: 60,
      },
    });
  });
}

async function openDashboard(page: Page) {
  await prepareSession(page);
  const auth = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/auth/user/",
  );
  await page.goto(`${DASHBOARD}?lang=en`);
  expect((await auth).status()).toBe(200);
  await expect(page.getByTestId("stream-start")).toBeEnabled();
}

async function changeAccount(page: Page, returnToA = false) {
  await page.evaluate(
    async ({ loader, returnToA }) => {
      const { authStore } = await new Function(loader)();
      let original: any;
      authStore.subscribe((state: any) => {
        original = state.creator;
      })();
      authStore.updateCreator({
        ...original,
        id: original.id + 1000,
        username: "hostactorb",
      });
      // Both updates in one JS turn: a reactive username check alone misses B.
      if (returnToA) authStore.updateCreator(original);
    },
    { loader: AUTH_STORE_LOADER, returnToA },
  );
}

async function holdStart(page: Page, type: "broadcast" | "private") {
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const bodies: any[] = [];
  await page.route(`**/api/dyte/${USER}/${type}`, async (route) => {
    bodies.push(route.request().postDataJSON());
    await held;
    await route.fulfill({
      json:
        type === "private"
          ? { secret: SECRET }
          : { auth_token: "host-token-a" },
    });
  });
  return { bodies, finish };
}

async function finishResponse(page: Page, finish: () => void, type: string) {
  const response = page.waitForResponse(`**/api/dyte/${USER}/${type}`);
  finish();
  await (await response).finished();
  // Allow the real component's async continuation and any attempted navigation
  // to run before asserting absence. The held response is already complete.
  await page.waitForTimeout(300);
}

async function stubProvider(
  page: Page,
  held = false,
  canRecord = false,
  heldLeave = false,
  failDuringInit = false,
  failSecondInit = false,
  failSecondInitWithRoomFailure = false,
  terminalDuringInit?: "kicked" | "rejected",
  terminalSecondInit?: "kicked" | "rejected",
  heldSecondInit = false,
) {
  await page.evaluate(
    async ({
      held,
      canRecord,
      heldLeave,
      failDuringInit,
      failSecondInit,
      failSecondInitWithRoomFailure,
      terminalDuringInit,
      terminalSecondInit,
      heldSecondInit,
    }) => {
      const text = await (await fetch("/src/lib/utils/rtk-manager.ts")).text();
      const path = text.match(
        /from \"([^\"]*cloudflare_realtimekit[^\"]*)\"/,
      )?.[1];
      if (!path)
        throw new Error("Actual host manager SDK import was not found");
      const { default: SDK } = await import(path);
      const meeting = {
        meta: { meetingTitle: "owner-a-room" },
        join: async () => {
          window.hostTest.joinCalls++;
        },
        recording: {
          recordingState: "IDLE",
          addListener: () => {},
          removeListener: () => {},
        },
        self: {
          on: (
            name: string,
            callback: (event: any) => Promise<void> | void,
          ) => {
            if (name === "roomLeft") {
              if (terminalDuringInit) {
                const state = terminalDuringInit;
                terminalDuringInit = undefined;
                callback({ state });
              }
              if (terminalSecondInit && window.hostTest.sdkCalls.length === 2) {
                const state = terminalSecondInit;
                terminalSecondInit = undefined;
                callback({ state });
              }
              if (failDuringInit) {
                failDuringInit = false;
                // The manager installs its store listener before its promise
                // resolves; this failure precedes the dashboard listener.
                callback({ state: "failed" });
              }
              if (
                failSecondInitWithRoomFailure &&
                window.hostTest.sdkCalls.length === 2
              ) {
                failSecondInitWithRoomFailure = false;
                // The retry SDK init has resolved, but the manager is still
                // attaching its listeners when the room failure arrives.
                callback({ state: "failed" });
              }
              window.hostTest.endRoom = (state = "left") => {
                void callback({ state });
              };
            }
          },
          off: () => {},
          permissions: { canRecord },
        },
        participants: {
          on: () => {},
          off: () => {},
          joined: { on: () => {}, off: () => {}, toArray: () => [] },
        },
        leave: async () => {
          window.hostTest.left++;
          if (heldLeave)
            await new Promise<void>((resolve) => {
              window.hostTest.finishLeave = resolve;
            });
        },
      };
      SDK.init = async (options: any) => {
        window.hostTest.sdkCalls.push(options);
        if (failSecondInit && window.hostTest.sdkCalls.length === 2)
          throw new Error("synthetic SDK initialization failure");
        if (held) {
          held = false;
          await new Promise<void>((resolve) => {
            window.hostTest.finishProvider = resolve;
          });
        }
        if (heldSecondInit && window.hostTest.sdkCalls.length === 2) {
          await new Promise<void>((resolve) => {
            window.hostTest.finishSecondProvider = resolve;
          });
        }
        return meeting;
      };
    },
    {
      held,
      canRecord,
      heldLeave,
      failDuringInit,
      failSecondInit,
      failSecondInitWithRoomFailure,
      terminalDuringInit,
      terminalSecondInit,
      heldSecondInit,
    },
  );
}

test("takeover during host retry SDK initialization abandons and cleans up the stale meeting", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(
    page,
    false,
    false,
    false,
    false,
    false,
    false,
    undefined,
    undefined,
    true,
  );
  const bodies: any[] = [];
  await page.route(`**/api/dyte/${USER}/broadcast`, (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      json: { auth_token: `host-token-${bodies.length}` },
    });
  });
  await page.route(`**/api/dyte/${USER}/host-session`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            active: false,
            host_session: null,
            meeting_type: null,
            ttl_seconds: 60,
          },
        })
      : route.fulfill({ json: {} }),
  );

  await page.getByTestId("stream-start").click();
  await expect.poll(async () => (await meetingState(page)).calls).toBe(1);
  await page.evaluate(() => window.hostTest.endRoom("failed"));
  await expect.poll(async () => (await meetingState(page)).calls).toBe(2);
  await page.evaluate((user) => {
    const channel = new BroadcastChannel(`f2z:host-seat:${user}`);
    channel.postMessage({
      kind: "takeover",
      session: "new-host",
      meetingType: "broadcast",
    });
    channel.close();
  }, USER);
  await expect(page.getByTestId("stream-seat-panel")).toHaveAttribute(
    "data-seat-state",
    "superseded",
  );
  await page.evaluate(() => window.hostTest.finishSecondProvider());
  await expect.poll(async () => (await meetingState(page)).room).toBeNull();
  expect(bodies).toHaveLength(2);
  await expect(page.getByTestId("host-reconnecting")).toHaveCount(0);
  await expect
    .poll(async () => page.evaluate(() => window.hostTest.left))
    .toBeGreaterThanOrEqual(2);
});

test("initial host SDK failure does not announce success while recovery is pending", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page, false, false, false, true);
  const bodies: any[] = [];
  let finishRetry!: () => void;
  const retryHeld = new Promise<void>((resolve) => (finishRetry = resolve));
  await page.route(`**/api/dyte/${USER}/broadcast`, async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 2) await retryHeld;
    return route.fulfill({
      json: { auth_token: `host-token-${bodies.length}` },
    });
  });
  await page.route(`**/api/dyte/${USER}/host-session`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            active: false,
            host_session: null,
            meeting_type: null,
            ttl_seconds: 60,
          },
        })
      : route.fulfill({ json: {} }),
  );

  await page.getByTestId("stream-start").click();
  await expect.poll(() => bodies.length).toBe(2);
  await expect(
    page.getByText("The stream started successfully. You are live!", {
      exact: true,
    }),
  ).toHaveCount(0);
  finishRetry();
  await expect.poll(async () => (await meetingState(page)).calls).toBe(2);
});

test("failed room during gated host initialization retries with the same seat", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page, true, false, false, true);
  const bodies: any[] = [];
  const releases: any[] = [];
  await page.route(`**/api/dyte/${USER}/broadcast`, (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      json: { auth_token: `host-token-${bodies.length}` },
    });
  });
  await page.route(`**/api/dyte/${USER}/host-session`, (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          active: false,
          host_session: null,
          meeting_type: null,
          ttl_seconds: 60,
        },
      });
    releases.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });

  await page.getByTestId("stream-start").click();
  await expect.poll(() => bodies.length).toBe(1);
  await expect.poll(async () => (await meetingState(page)).calls).toBe(1);
  await page.evaluate(() => window.hostTest.finishProvider());
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toMatchObject({
    role: "host",
    host_session: bodies[0].host_session,
  });
  await expect.poll(async () => (await meetingState(page)).calls).toBe(2);
  expect(releases).toEqual([]);
});

async function meetingState(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/lib/stores/liveStreamStore.ts";
    const { liveStreamStore } = await import(path);
    let state: any;
    liveStreamStore.subscribe((value: any) => {
      state = value;
    })();
    return {
      room: state.meeting?.meta.meetingTitle ?? null,
      type: state.streamType,
      host: state.isHost,
      left: window.hostTest.left,
      calls: window.hostTest.sdkCalls.length,
    };
  });
}

for (const returnToA of [false, true]) {
  test(`held private secret is discarded after A -> B${returnToA ? " -> A" : ""}`, async ({
    page,
  }) => {
    await openDashboard(page);
    await page.locator('label[for="stream-audience-private"]').click();
    const held = await holdStart(page, "private");
    await page.getByTestId("stream-start").click();
    await expect.poll(() => held.bodies.length).toBe(1);
    await changeAccount(page, returnToA);
    await finishResponse(page, held.finish, "private");
    expect(await page.evaluate(() => window.hostTest.copied)).toEqual([]);
    expect(page.url()).not.toContain(`/private/${SECRET}`);
    await expect(
      page.getByText("Secret link copied to the clipboard!", { exact: true }),
    ).toHaveCount(0);
    if (returnToA) await expect(page.getByTestId("stream-start")).toBeEnabled();
  });
}

test("same-account private start copies and navigates with the original username", async ({
  page,
}) => {
  await openDashboard(page);
  await page.locator('label[for="stream-audience-private"]').click();
  await page.route(`**/api/dyte/${USER}/private`, (route) =>
    route.fulfill({ json: { secret: SECRET } }),
  );
  await page.route(`**/api/dyte/${USER}/private/${SECRET}`, (route) =>
    route.fulfill({ status: 503, body: "mock provider unavailable" }),
  );
  await page.getByTestId("stream-start").click();
  await expect(page).toHaveURL(new RegExp(`/${USER}/private/${SECRET}`));
  expect(await page.evaluate(() => window.hostTest.copied)).toEqual([
    new URL(`/${USER}/private/${SECRET}`, page.url()).toString(),
  ]);
});

test("failed host room reinitializes with the same seat and keeps that seat", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page);
  const bodies: any[] = [];
  const releases: any[] = [];
  await page.route(`**/api/dyte/${USER}/broadcast`, (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      json: { auth_token: `host-token-${bodies.length}` },
    });
  });
  await page.route(`**/api/dyte/${USER}/host-session`, (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          active: false,
          host_session: null,
          meeting_type: null,
          ttl_seconds: 60,
        },
      });
    releases.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });

  await page.getByTestId("stream-start").click();
  await expect.poll(() => bodies.length).toBe(1);
  // The request can precede SDK listener installation; fail an established room.
  await expect(
    page.getByText("The stream started successfully. You are live!"),
  ).toBeVisible();
  await page.evaluate(() => window.hostTest.endRoom("failed"));
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toMatchObject({
    role: "host",
    host_session: bodies[0].host_session,
  });
  await expect.poll(async () => (await meetingState(page)).calls).toBe(2);
  expect(releases).toEqual([]);
  await expect(page.getByTestId("stream-seat-panel")).toHaveCount(0);
});

test("room failure during host retry initialization releases the seat without retrying forever", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page, false, false, false, false, false, true);
  const bodies: any[] = [];
  const releases: any[] = [];
  await page.route(`**/api/dyte/${USER}/broadcast`, (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      json: { auth_token: `host-token-${bodies.length}` },
    });
  });
  await page.route(`**/api/dyte/${USER}/host-session`, (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          active: false,
          host_session: null,
          meeting_type: null,
          ttl_seconds: 60,
        },
      });
    releases.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });

  await page.getByTestId("stream-start").click();
  await expect.poll(async () => (await meetingState(page)).calls).toBe(1);
  await page.evaluate(() => window.hostTest.endRoom("failed"));

  await expect(page.getByTestId("host-reconnect")).toBeVisible();
  await expect.poll(() => releases.length).toBe(1);
  expect(releases[0]).toMatchObject({
    action: "release",
    host_session: bodies[0].host_session,
  });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toMatchObject({
    role: "host",
    host_session: bodies[0].host_session,
  });
  expect(await meetingState(page)).toMatchObject({ calls: 2, room: null });
  await page.waitForTimeout(300);
  expect(bodies).toHaveLength(2);
  expect(releases).toHaveLength(1);
});

const hostTerminalCases = [
  {
    state: "kicked",
    message:
      "You were removed from the live room. Reconnect to start a new broadcast.",
  },
  {
    state: "rejected",
    message:
      "The live room rejected the connection. Reconnect to start a new broadcast.",
  },
] as const;

for (const { state, message } of hostTerminalCases) {
  test(`${state} during initial host SDK initialization releases the seat and offers reconnect`, async ({
    page,
  }) => {
    await openDashboard(page);
    await stubProvider(page, false, false, false, false, false, false, state);
    const bodies: any[] = [];
    const releases: any[] = [];
    await page.route(`**/api/dyte/${USER}/broadcast`, (route) => {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({
        json: { auth_token: `host-token-${bodies.length}` },
      });
    });
    await page.route(`**/api/dyte/${USER}/host-session`, (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: {
            active: false,
            host_session: null,
            meeting_type: null,
            ttl_seconds: 60,
          },
        });
      releases.push(route.request().postDataJSON());
      return route.fulfill({ json: {} });
    });

    await page.getByTestId("stream-start").click();
    await expect(page.getByTestId("host-reconnect")).toBeVisible();
    await expect(
      page.locator("main").getByText(message, { exact: false }),
    ).toBeVisible();
    await expect.poll(() => releases.length).toBe(1);
    expect(releases[0]).toMatchObject({
      action: "release",
      host_session: bodies[0].host_session,
    });
    expect(await meetingState(page)).toMatchObject({ calls: 1, room: null });
    await expect(
      page.getByText("The stream started successfully. You are live!", {
        exact: true,
      }),
    ).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(bodies).toHaveLength(1);
    expect(releases).toHaveLength(1);
  });

  test(`${state} during host retry SDK initialization releases the seat without retrying forever`, async ({
    page,
  }) => {
    await openDashboard(page);
    await stubProvider(
      page,
      false,
      false,
      false,
      false,
      false,
      false,
      undefined,
      state,
    );
    const bodies: any[] = [];
    const releases: any[] = [];
    await page.route(`**/api/dyte/${USER}/broadcast`, (route) => {
      bodies.push(route.request().postDataJSON());
      return route.fulfill({
        json: { auth_token: `host-token-${bodies.length}` },
      });
    });
    await page.route(`**/api/dyte/${USER}/host-session`, (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: {
            active: false,
            host_session: null,
            meeting_type: null,
            ttl_seconds: 60,
          },
        });
      releases.push(route.request().postDataJSON());
      return route.fulfill({ json: {} });
    });

    await page.getByTestId("stream-start").click();
    await expect.poll(async () => (await meetingState(page)).calls).toBe(1);
    await page.evaluate(() => window.hostTest.endRoom("failed"));
    await expect(page.getByTestId("host-reconnect")).toBeVisible();
    await expect(
      page.locator("main").getByText(message, { exact: false }),
    ).toBeVisible();
    await expect.poll(() => releases.length).toBe(1);
    expect(releases[0]).toMatchObject({
      action: "release",
      host_session: bodies[0].host_session,
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      role: "host",
      host_session: bodies[0].host_session,
    });
    expect(await meetingState(page)).toMatchObject({ calls: 2, room: null });
    await page.waitForTimeout(300);
    expect(bodies).toHaveLength(2);
    expect(releases).toHaveLength(1);
  });
}

test("kicked host ends its seat and gets an explicit reconnect action", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page);
  const releases: any[] = [];
  await page.route(`**/api/dyte/${USER}/broadcast`, (route) =>
    route.fulfill({ json: { auth_token: "host-token" } }),
  );
  await page.route(`**/api/dyte/${USER}/host-session`, (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          active: false,
          host_session: null,
          meeting_type: null,
          ttl_seconds: 60,
        },
      });
    releases.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  await page.getByTestId("stream-start").click();
  await expect.poll(async () => (await meetingState(page)).calls).toBe(1);
  await page.evaluate(() => window.hostTest.endRoom("kicked"));
  await expect(page.getByTestId("host-reconnect")).toBeVisible();
  await expect(
    page.getByText(
      "You were removed from the live room. Reconnect to start a new broadcast.",
    ),
  ).toBeVisible();
  await expect.poll(() => releases.length).toBe(1);
  expect(releases[0]).toMatchObject({ action: "release" });
});

for (const failure of ["token", "initialization"] as const) {
  test(`failed host retry ${failure} ends the seat and offers reconnect`, async ({
    page,
  }) => {
    await openDashboard(page);
    await stubProvider(
      page,
      false,
      false,
      false,
      false,
      failure === "initialization",
    );
    const bodies: any[] = [];
    const releases: any[] = [];
    await page.route(`**/api/dyte/${USER}/broadcast`, (route) => {
      bodies.push(route.request().postDataJSON());
      if (failure === "token" && bodies.length === 2)
        return route.fulfill({ status: 503, body: "synthetic token failure" });
      return route.fulfill({
        json: { auth_token: `host-token-${bodies.length}` },
      });
    });
    await page.route(`**/api/dyte/${USER}/host-session`, (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: {
            active: false,
            host_session: null,
            meeting_type: null,
            ttl_seconds: 60,
          },
        });
      releases.push(route.request().postDataJSON());
      return route.fulfill({ json: {} });
    });

    await page.getByTestId("stream-start").click();
    await expect.poll(async () => (await meetingState(page)).calls).toBe(1);
    await page.evaluate(() => window.hostTest.endRoom("failed"));
    await expect(page.getByTestId("host-reconnect")).toBeVisible();
    await expect(
      page.getByText(
        "The stream could not reconnect. Reconnect to start a new broadcast.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect.poll(() => releases.length).toBe(1);
    expect(releases[0]).toMatchObject({
      action: "release",
      host_session: bodies[0].host_session,
    });
    await expect(page.getByTestId("stream-start")).toBeEnabled();
  });
}

test("late public grant after A -> B -> A releases the original seat without joining and permits retry", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page);
  const held = await holdStart(page, "broadcast");
  const releases: any[] = [];
  await page.route(`**/api/dyte/${USER}/host-session`, (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    releases.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  await page.getByTestId("stream-start").click();
  await expect.poll(() => held.bodies.length).toBe(1);
  await changeAccount(page, true);
  await finishResponse(page, held.finish, "broadcast");
  await expect.poll(() => releases.length).toBe(1);
  expect(releases[0]).toMatchObject({
    action: "release",
    host_session: held.bodies[0].host_session,
  });
  expect(await meetingState(page)).toMatchObject({ room: null, calls: 0 });
  await expect(page.getByTestId("stream-start")).toBeEnabled();
  await page.route(`**/api/dyte/${USER}/broadcast`, (route) =>
    route.fulfill({ status: 503, body: "mock provider unavailable" }),
  );
  await page.getByTestId("stream-start").click();
  await expect(
    page.getByText("Failed to start the stream.", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByTestId("stream-start")).toBeEnabled();
});

test("provider initializing across A -> B -> A leaves the abandoned meeting and a fresh start still works", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page, true);
  const bodies: any[] = [];
  const releases: any[] = [];
  let lease: { session: string; expires: number } | null = null;
  let finishRelease!: () => void;
  const heldRelease = new Promise<void>((resolve) => {
    finishRelease = resolve;
  });
  await page.route(`**/api/dyte/${USER}/broadcast`, (route) => {
    const body = route.request().postDataJSON();
    bodies.push(body);
    if (
      lease &&
      lease.expires > Date.now() &&
      lease.session !== body.host_session
    ) {
      return route.fulfill({
        status: 409,
        json: {
          code: "already_live_elsewhere",
          meeting_type: "broadcast",
        },
      });
    }
    lease = { session: body.host_session, expires: Date.now() + 60_000 };
    return route.fulfill({ json: { auth_token: "host-token-a" } });
  });
  await page.route(`**/api/dyte/${USER}/host-session`, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: {
          active: Boolean(lease && lease.expires > Date.now()),
          host_session: lease?.session ?? null,
          meeting_type: "broadcast",
          ttl_seconds: 60,
        },
      });
    }
    releases.push(route.request().postDataJSON());
    await heldRelease;
    // Match Django's identity check: releasing an old session can never
    // clear a different session, and every unrenewed lease lasts 60 seconds.
    if (lease?.session === releases.at(-1).host_session) lease = null;
    return route.fulfill({ json: {} });
  });
  await page.getByTestId("stream-start").click();
  await expect.poll(async () => (await meetingState(page)).calls).toBe(1);
  await changeAccount(page, true);
  await expect.poll(() => releases.length).toBe(1);
  expect(releases[0]).toMatchObject({
    action: "release",
    host_session: bodies[0].host_session,
  });
  await page.evaluate(() => window.hostTest.finishProvider());
  await expect.poll(async () => (await meetingState(page)).left).toBe(1);
  expect(await meetingState(page)).toMatchObject({ room: null });
  await expect(
    page.getByText("The stream started successfully. You are live!", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.getByTestId("stream-start")).toBeDisabled();
  await page.waitForTimeout(300);
  expect(bodies).toHaveLength(1);
  const releaseResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/dyte/${USER}/host-session` &&
      response.request().method() === "POST",
  );
  finishRelease();
  await (await releaseResponse).finished();
  await expect(page.getByTestId("stream-start")).toBeEnabled();
  await page.getByTestId("stream-start").click();
  await expect
    .poll(async () => (await meetingState(page)).room)
    .toBe("owner-a-room");
  expect(await meetingState(page)).toMatchObject({
    calls: 2,
    type: "broadcast",
    host: true,
  });
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({ role: "host" });
  expect(bodies[1].host_session).not.toBe(bodies[0].host_session);
  await expect(
    page.getByText("The stream started successfully. You are live!", {
      exact: true,
    }),
  ).toBeVisible();
});

test("a granted public seat is not released using the replacement account's credentials", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page);
  const held = await holdStart(page, "broadcast");
  const releases: any[] = [];
  await page.route(`**/api/dyte/${USER}/host-session`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    releases.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  await page.getByTestId("stream-start").click();
  await expect.poll(() => held.bodies.length).toBe(1);
  await changeAccount(page);
  await finishResponse(page, held.finish, "broadcast");
  expect(releases).toEqual([]);
  expect(await meetingState(page)).toMatchObject({ room: null, calls: 0 });
});

test("a granted public seat arriving after logout neither throws nor joins nor releases", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page);
  const held = await holdStart(page, "broadcast");
  const releases: any[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`**/api/dyte/${USER}/host-session`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    releases.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  await page.getByTestId("stream-start").click();
  await expect.poll(() => held.bodies.length).toBe(1);
  await page.evaluate(async (loader) => {
    const { authStore } = await new Function(loader)();
    authStore.clear();
  }, AUTH_STORE_LOADER);
  await finishResponse(page, held.finish, "broadcast");
  expect(releases).toEqual([]);
  expect(await meetingState(page)).toMatchObject({ room: null, calls: 0 });
  expect(errors).toEqual([]);
});

test("an established host meeting leaves immediately when its account changes", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page);
  await page.route(`**/api/dyte/${USER}/broadcast`, (route) =>
    route.fulfill({ json: { auth_token: "host-token-a" } }),
  );
  await page.getByTestId("stream-start").click();
  await expect
    .poll(async () => (await meetingState(page)).room)
    .toBe("owner-a-room");
  await changeAccount(page, true);
  await expect.poll(async () => (await meetingState(page)).left).toBe(1);
  expect(await meetingState(page)).toMatchObject({ room: null });
  await expect(page.getByTestId("stream-start")).toBeEnabled();
});

test("a clipboard completion after the account changed cannot navigate or announce A's secret", async ({
  page,
}) => {
  await openDashboard(page);
  await page.locator('label[for="stream-audience-private"]').click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (url: string) => {
          window.hostTest.copied.push(url);
          await new Promise<void>((resolve) => {
            window.hostTest.finishProvider = resolve;
          });
        },
      },
    });
  });
  await page.route(`**/api/dyte/${USER}/private`, (route) =>
    route.fulfill({ json: { secret: SECRET } }),
  );
  await page.getByTestId("stream-start").click();
  await expect
    .poll(async () => page.evaluate(() => window.hostTest.copied.length))
    .toBe(1);
  await changeAccount(page, true);
  await page.evaluate(() => window.hostTest.finishProvider());
  await page.waitForTimeout(300);
  expect(page.url()).not.toContain(`/private/${SECRET}`);
  await expect(
    page.getByText("Secret link copied to the clipboard!", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("stream-start")).toBeEnabled();
});

test("an abandoned provider completion preserves a replacement meeting", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page, true);
  await page.route(`**/api/dyte/${USER}/broadcast`, (route) =>
    route.fulfill({ json: { auth_token: "host-token-a" } }),
  );
  await page.route(`**/api/dyte/${USER}/host-session`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: {} });
  });
  await page.getByTestId("stream-start").click();
  await expect.poll(async () => (await meetingState(page)).calls).toBe(1);
  await changeAccount(page, true);
  await page.evaluate(async () => {
    const path = "/src/lib/stores/liveStreamStore.ts";
    const { liveStreamStore } = await import(path);
    liveStreamStore.init(
      {
        meta: { meetingTitle: "replacement-room" },
        self: { on: () => {}, off: () => {}, permissions: {} },
        participants: {
          on: () => {},
          off: () => {},
          joined: { on: () => {}, off: () => {}, toArray: () => [] },
        },
      },
      "broadcast",
      false,
    );
    window.hostTest.finishProvider();
  });
  await expect.poll(async () => (await meetingState(page)).left).toBe(1);
  expect(await meetingState(page)).toMatchObject({
    room: "replacement-room",
    host: false,
  });
});

test("a host response outliving navigation does not release A's seat after a later account change", async ({
  page,
}) => {
  await openDashboard(page);
  const held = await holdStart(page, "broadcast");
  const releases: any[] = [];
  await page.route(`**/api/dyte/${USER}/host-session`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    releases.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  await page.getByTestId("stream-start").click();
  await expect.poll(() => held.bodies.length).toBe(1);
  await page.evaluate(async () => {
    const navigation =
      "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
    const { goto } = await import(navigation);
    await goto("/?lang=en");
  });
  await expect(page.getByTestId("stream-start")).toHaveCount(0);
  await changeAccount(page);
  await finishResponse(page, held.finish, "broadcast");
  expect(releases).toEqual([]);
});

async function openLiveHost(page: Page) {
  await openDashboard(page);
  await stubProvider(page);
  await page.route(`**/api/dyte/${USER}/broadcast`, (route) =>
    route.fulfill({ json: { auth_token: "host-token-a" } }),
  );
  await page.route(`**/api/dyte/${USER}/host-session`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: {} });
  });
  await page.getByTestId("stream-start").click();
  await expect(
    page.getByRole("button", { name: "Copy viewer link", exact: true }),
  ).toBeVisible();
}

test("public host can review and publish a Converse live link without leaving the broadcast", async ({
  page,
}) => {
  await openLiveHost(page);
  const hostBefore = await meetingState(page);
  await page.getByTestId("share-live-to-converse").click();
  const composer = page.getByTestId("live-converse-composer");
  await expect(composer).toBeVisible();
  const body = composer.locator("#converse-content");
  await expect(body).toHaveValue(
    `I'm live — come watch! ${new URL(`/${USER}/broadcast`, page.url()).toString()}`,
  );
  await body.fill(
    `I'm live — come watch! ${new URL(`/${USER}/broadcast`, page.url())}`,
  );
  await expect(composer).toContainText("2Z");
  await expect(page).toHaveURL(new RegExp(`${USER}/dashboard/stream`));
  expect(await meetingState(page)).toMatchObject(hostBefore);

  const posts: any[] = [];
  await page.route("**/api/comments/", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts.push(route.request().postDataJSON());
    return route.fulfill({
      json: { uuid: "live-announcement", content: posts[0].content },
    });
  });
  await composer.getByRole("button", { name: /post/i }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].content).toContain(`/${USER}/broadcast`);
  expect(await meetingState(page)).toMatchObject(hostBefore);

  const reader = await page.context().newPage();
  await reader.route(`**/${USER}/broadcast**`, async (route) =>
    route.fulfill({ status: 200, body: "viewer route reached" }),
  );
  await reader.goto(new URL(`/${USER}/broadcast`, page.url()).toString());
  await expect(reader).toHaveURL(new RegExp(`/${USER}/broadcast`));
  await reader.close();
});

test("share action is absent when stream is inactive or configured private", async ({
  page,
}) => {
  await openDashboard(page);
  await expect(page.getByTestId("share-live-to-converse")).toHaveCount(0);
  await page.locator('label[for="stream-audience-private"]').click();
  await expect(page.getByTestId("share-live-to-converse")).toHaveCount(0);
});

async function holdViewerCopy(page: Page, fail = false) {
  await page.evaluate((fail) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (url: string) => {
          window.hostTest.copied.push(url);
          await new Promise<void>((resolve, reject) => {
            window.hostTest.finishProvider = () =>
              fail
                ? reject(new Error("mock clipboard unavailable"))
                : resolve();
          });
        },
      },
    });
    if (fail) document.execCommand = () => false;
  }, fail);
  await page
    .getByRole("button", { name: "Copy viewer link", exact: true })
    .click();
  await expect
    .poll(async () => page.evaluate(() => window.hostTest.copied.length))
    .toBe(1);
}

test("a current host's viewer link notice fades after copying", async ({
  page,
}) => {
  await openLiveHost(page);
  // The facade deliberately presents one routine acknowledgement at a time.
  // Dismiss the existing Started notice as a user would before the next copy.
  const started = page.locator("[data-sonner-toast]").filter({
    hasText: "The stream started successfully. You are live!",
  });
  await started.getByRole("button", { name: "Close notification" }).click();
  await expect(started).toHaveCount(0);
  await page
    .getByRole("button", { name: "Copy viewer link", exact: true })
    .click();
  expect(await page.evaluate(() => window.hostTest.copied)).toEqual([
    new URL(`/${USER}/broadcast`, page.url()).toString(),
  ]);
  const notice = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Viewer link copied to the clipboard!" });
  await expect(notice).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(notice).toHaveCount(0, { timeout: 8000 });
  await expect(
    page.getByRole("button", { name: "Copy viewer link", exact: true }),
  ).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test("an old viewer copy completion cannot mark a fresh A -> B -> A host as Copied", async ({
  page,
}) => {
  await openLiveHost(page);
  await holdViewerCopy(page);
  await changeAccount(page, true);
  await expect.poll(async () => (await meetingState(page)).left).toBe(1);
  await expect(page.getByTestId("stream-start")).toBeEnabled();
  await page.getByTestId("stream-start").click();
  const copy = page.getByRole("button", {
    name: /^(Copy viewer link|Copied)$/,
  });
  await expect(copy).toHaveText("Copy viewer link");
  await page.evaluate(async () => {
    window.hostTest.finishProvider();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  expect((await copy.textContent())?.trim()).toBe("Copy viewer link");
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Viewer link copied to the clipboard!" }),
  ).toHaveCount(0);
});

test("a failed viewer copy completion after client navigation cannot leave a stale error notice", async ({
  page,
}) => {
  await openLiveHost(page);
  await holdViewerCopy(page, true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.evaluate(async () => {
    const path =
      "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
    const { goto } = await import(path);
    await goto("/?lang=en");
  });
  await expect(
    page.getByRole("button", { name: "Copy viewer link", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(async () => {
    window.hostTest.finishProvider();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await expect(
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Failed to copy the viewer link." }),
  ).toHaveCount(0);
});

for (const width of [320, 390, 1280]) {
  test(`host actions occupy their own header above media at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await openDashboard(page);
    await stubProvider(page, false, true);
    await page.route(`**/api/dyte/${USER}/broadcast`, (route) =>
      route.fulfill({ json: { auth_token: "host-token-a" } }),
    );
    await page.route(`**/api/dyte/${USER}/recording**`, (route) =>
      route.fulfill({ json: { recording_state: "IDLE" } }),
    );
    await page.getByTestId("stream-start").click();
    const header = page.getByTestId("stream-host-header");
    const record = header.getByRole("button", {
      name: "Record livestream",
      exact: true,
    });
    const copy = header.getByRole("button", {
      name: "Copy viewer link",
      exact: true,
    });
    await expect(record).toBeVisible();
    await expect(copy).toBeVisible();
    const media = page.locator("rtk-meeting");
    await expect(media).toBeVisible();
    // The host opened the meeting, but the provider's setup screen still owns
    // the final join action so the host can choose pre-join media settings.
    expect(await page.evaluate(() => window.hostTest.joinCalls)).toBe(0);
    const h = (await header.boundingBox())!;
    const m = (await media.boundingBox())!;
    expect(m.y).toBeGreaterThanOrEqual(h.y + h.height - 1);
    expect(m.height).toBeGreaterThan(300);
    for (const action of [record, copy]) {
      const box = (await action.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(m.y);
    }
    await copy.click();
    await expect(
      header.getByRole("button", { name: "Copied", exact: true }),
    ).toBeVisible();
  });
}

for (const [owner, encrypted, mixedCase, lateJoin = false] of [
  [true, false, false],
  [false, false, false],
  [true, true, false],
  [true, false, true],
  [true, false, false, true],
]) {
  test(`private recording uses the existing secret room and is owner-only: ${owner}, encrypted: ${encrypted}, mixedCase: ${mixedCase}, lateJoin: ${lateJoin}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page);
    await stubProvider(page, false, true);
    const requests: string[] = [];
    let state = "IDLE";
    const routeUser = mixedCase ? USER.toUpperCase() : USER;
    const secret = "428f3df0-59b7-4ee5-98ef-df7045436005";
    let releaseJoin!: () => void;
    const joinGate = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
    await page.route(
      `**/api/dyte/${routeUser}/private/${secret}`,
      async (route) => {
        if (lateJoin) await joinGate;
        return route.fulfill({
          json: { auth_token: "private-existing-room", e2ee: encrypted },
        });
      },
    );
    await page.route(
      `**/api/dyte/${routeUser}/private/${secret}/recording**`,
      (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/recording-visibility")) {
          return route.fulfill({ json: { recording: false } });
        }
        const method = route.request().method();
        const stop = path.endsWith("/stop");
        requests.push(`${method}:${stop ? "stop" : "recording"}`);
        if (method === "POST") state = stop ? "STOPPING" : "INVOKED";
        return route.fulfill({ json: { recording_state: state } });
      },
    );
    const publicStarts: string[] = [];
    await page.route(`**/api/dyte/${USER}/broadcast`, (route) => {
      publicStarts.push(route.request().method());
      return route.fulfill({ status: 500 });
    });
    if (!owner) await changeAccount(page);
    await page.evaluate(
      async ({ user, secret }) => {
        const path =
          "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
        const { goto } = await import(path);
        await goto(`/${user}/private/${secret}?lang=en`);
      },
      { user: routeUser, secret },
    );
    if (lateJoin) {
      await page.evaluate(async (user) => {
        const path =
          "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
        const { goto } = await import(path);
        await goto(
          `/${user}/private/d60f180a-4e01-42ee-b765-c4416680c29d?lang=en`,
        );
      }, routeUser);
      releaseJoin();
      await expect(
        page.getByText(
          "The private call link changed. Reload to join the selected call.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByTestId("private-call-header")).toHaveCount(0);
      expect(requests).toEqual([]);
      expect(publicStarts).toEqual([]);
      // A token for a replaced route must never initialize the provider.
      expect(await page.evaluate(() => window.hostTest.sdkCalls.length)).toBe(
        0,
      );
      expect(await page.evaluate(() => window.hostTest.left)).toBe(0);
      return;
    }
    const header = page.getByTestId("private-call-header");
    await expect(header).toBeVisible();
    await expect(page.locator("rtk-meeting")).toBeVisible();
    // Private rooms also retain the provider setup screen; initializing the
    // meeting must not implicitly enable camera/microphone or enter the room.
    expect(await page.evaluate(() => window.hostTest.joinCalls)).toBe(0);
    await expect(
      header.getByRole("button", { name: "Copy Link", exact: true }),
    ).toBeVisible();
    const record = header.getByRole("button", {
      name: "Record livestream",
      exact: true,
    });
    if (owner && !encrypted) {
      await expect(record).toBeVisible();
      await record.click();
      await expect(
        header.getByText("Recording is starting", { exact: true }),
      ).toBeVisible();
      await header
        .getByRole("button", { name: "Stop recording", exact: true })
        .click();
      await expect(
        header.getByText("Stopping recording", { exact: true }),
      ).toBeVisible();
      expect(requests).toEqual([
        "GET:recording",
        "POST:recording",
        "POST:stop",
      ]);
    } else {
      await expect(record).toHaveCount(0);
      expect(requests).toEqual([]);
    }
    expect(publicStarts).toEqual([]);
    await expect(page.locator("rtk-recording-toggle")).toHaveCount(0);
    const h = (await header.boundingBox())!;
    const m = (await page.locator("rtk-meeting").boundingBox())!;
    expect(m.y).toBeGreaterThanOrEqual(h.y + h.height - 1);
    if (owner && !encrypted) {
      const priorRequests = requests.length;
      const otherSecret = "d60f180a-4e01-42ee-b765-c4416680c29d";
      const otherRoomRequests: string[] = [];
      await page.route(
        `**/api/dyte/${routeUser}/private/${otherSecret}/recording**`,
        (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path.endsWith("/recording-visibility")) {
            return route.fulfill({ json: { recording: false } });
          }
          otherRoomRequests.push(route.request().url());
          return route.fulfill({ json: { recording_state: "IDLE" } });
        },
      );
      await page.evaluate(
        async ({ user, secret }) => {
          const path =
            "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
          const { goto } = await import(path);
          await goto(`/${user}/private/${secret}?lang=en`);
        },
        { user: routeUser, secret: otherSecret },
      );
      await expect(
        page.getByText(
          "The private call link changed. Reload to join the selected call.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByTestId("private-call-header")).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => window.hostTest.left))
        .toBe(1);
      expect(otherRoomRequests).toEqual([]);
      expect(requests.length).toBe(priorRequests);
    }
  });
}

for (const [code, message] of [
  ["recording_active", "Stop recording before creating another private link."],
  [
    "recording_delivery_failed",
    "The recording could not be saved. Return to the current call or contact support before replacing its private link.",
  ],
  [
    "recording_delivery_pending",
    "The recording is processing. Wait for it to appear in your uploads, then retry creating the private link.",
  ],
  [
    "recording_status_unknown",
    "Recording status could not be confirmed. Retry before creating another private link.",
  ],
]) {
  test(`private link creation explains recording refusal: ${code}`, async ({
    page,
  }) => {
    await openDashboard(page);
    await page.locator('label[for="stream-audience-private"]').click();
    const secret = "428f3df0-59b7-4ee5-98ef-df7045436005";
    const requests: string[] = [];
    await page.route(`**/api/dyte/${USER}/private`, (route) => {
      requests.push(route.request().method());
      return route.fulfill(
        route.request().method() === "GET"
          ? { json: { secret, e2ee: false } }
          : {
              status: code === "recording_status_unknown" ? 503 : 409,
              json: { code, error: message },
            },
      );
    });
    await page.getByTestId("stream-start").click();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByTestId("stream-start")).toBeEnabled();
    await stubProvider(page, false, true);
    await page.route(`**/api/dyte/${USER}/private/${secret}`, (route) =>
      route.fulfill({ json: { auth_token: "resume-private", e2ee: false } }),
    );
    await page.route(
      `**/api/dyte/${USER}/private/${secret}/recording`,
      (route) => route.fulfill({ json: { recording_state: "RECORDING" } }),
    );
    await page
      .getByRole("button", { name: "Return to current call", exact: true })
      .click();
    await expect(
      page
        .getByTestId("private-call-header")
        .getByRole("button", { name: "Stop recording", exact: true }),
    ).toBeVisible();
    expect(requests).toEqual(["POST", "GET"]);
  });
}

test("a private meeting stays mounted through offline and reconnecting overlays", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page, false, true);
  const secret = "private-meeting-survives-offline";
  await page.route(`**/api/dyte/${USER}/private/${secret}`, (route) =>
    route.fulfill({
      json: { auth_token: "private-offline-room", e2ee: false },
    }),
  );
  await page.route(
    `**/api/dyte/${USER}/private/${secret}/recording**`,
    (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({
        json: path.endsWith("/recording-visibility")
          ? { recording: false }
          : { recording_state: "IDLE" },
      });
    },
  );

  await page.evaluate(
    async ({ user, secret }) => {
      const path =
        "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
      const { goto } = await import(path);
      await goto(`/${user}/private/${secret}?lang=en`);
    },
    { user: USER, secret },
  );
  const header = page.getByTestId("private-call-header");
  const meeting = page.locator("rtk-meeting");
  const recordButton = header.getByRole("button", {
    name: "Record livestream",
    exact: true,
  });
  await expect(header).toBeVisible();
  await expect(recordButton).toBeVisible();
  await expect(meeting).toBeVisible();
  await expect(meeting).toHaveCount(1);
  await expect(header.locator("..")).not.toHaveAttribute("inert", "");
  await recordButton.focus();
  await expect(recordButton).toBeFocused();
  await page.evaluate(async (loader) => {
    const { liveStreamStore } = await new Function(loader)();
    (window as any).__privateMeetingBeforeRecovery =
      document.querySelector("rtk-meeting");
    liveStreamStore.setOffline(true);
    liveStreamStore.setConnectionStatus("disconnected");
  }, LIVE_STREAM_STORE_LOADER);

  await expect(
    page.getByRole("heading", { name: "You are Offline" }),
  ).toBeVisible();
  const reconnect = page.getByTestId("private-call-reconnect");
  await expect(reconnect).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(reconnect).not.toBeFocused();
  await reconnect.focus();
  await expect(header).toBeVisible();
  await expect(header.locator("..")).toHaveAttribute("inert", "");
  await expect(meeting).toBeVisible();
  await expect(meeting).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        (window as any).__privateMeetingBeforeRecovery ===
        document.querySelector("rtk-meeting"),
    ),
  ).toBe(true);

  await page.evaluate(async (loader) => {
    const { liveStreamStore } = await new Function(loader)();
    liveStreamStore.setConnectionStatus("disconnected");
    liveStreamStore.setOffline(false);
  }, LIVE_STREAM_STORE_LOADER);
  await expect(header.locator("..")).toHaveAttribute("inert", "");
  await page.evaluate(async (loader) => {
    const { liveStreamStore } = await new Function(loader)();
    liveStreamStore.setConnectionStatus("connected");
  }, LIVE_STREAM_STORE_LOADER);
  await expect(recordButton).toBeFocused();

  await page.evaluate(async (loader) => {
    const external = document.createElement("button");
    external.id = "external-focus-target";
    document.body.append(external);
    const { liveStreamStore } = await new Function(loader)();
    liveStreamStore.setOffline(true);
  }, LIVE_STREAM_STORE_LOADER);
  await expect(page.getByTestId("private-call-reconnect")).toBeFocused();
  await page.locator("#external-focus-target").focus();
  await page.evaluate(async (loader) => {
    const { liveStreamStore } = await new Function(loader)();
    liveStreamStore.setOffline(false);
  }, LIVE_STREAM_STORE_LOADER);
  await expect(page.locator("#external-focus-target")).toBeFocused();

  await page.evaluate(async (loader) => {
    const { liveStreamStore } = await new Function(loader)();
    liveStreamStore.setConnectionStatus("disconnected");
  }, LIVE_STREAM_STORE_LOADER);
  const reconnecting = page
    .getByRole("status")
    .filter({ hasText: /Reconnecting/ });
  await expect(reconnecting).toBeVisible();
  await expect(reconnecting).toHaveCSS("pointer-events", "none");
  await expect(reconnecting.locator("button, a, [tabindex='0']")).toHaveCount(
    0,
  );
  expect(
    await reconnecting.evaluate((node) =>
      node.contains(document.activeElement),
    ),
  ).toBe(false);
  await expect(meeting).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        (window as any).__privateMeetingBeforeRecovery ===
        document.querySelector("rtk-meeting"),
    ),
  ).toBe(true);

  await page.evaluate(async (loader) => {
    const { liveStreamStore } = await new Function(loader)();
    liveStreamStore.setConnectionStatus("connected");
  }, LIVE_STREAM_STORE_LOADER);
  await expect(
    page.getByRole("status").filter({ hasText: /Reconnecting/ }),
  ).toHaveCount(0);
  await expect(header).toBeVisible();
  await expect(meeting).toHaveCount(1);
  expect(await page.evaluate(() => window.hostTest.joinCalls)).toBe(0);
});

test("an offline focus restore tick cannot steal focus after leaving a private call", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page, false, true);
  const secret = "private-focus-restore-teardown";
  await page.route(`**/api/dyte/${USER}/private/${secret}`, (route) =>
    route.fulfill({
      json: { auth_token: "private-focus-restore-room", e2ee: false },
    }),
  );
  await page.route(
    `**/api/dyte/${USER}/private/${secret}/recording**`,
    (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({
        json: path.endsWith("/recording-visibility")
          ? { recording: false }
          : { recording_state: "IDLE" },
      });
    },
  );

  await page.evaluate(
    async ({ user, secret }) => {
      const path =
        "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
      const { goto } = await import(path);
      await goto(`/${user}/private/${secret}?lang=en`);
    },
    { user: USER, secret },
  );
  const recordButton = page
    .getByTestId("private-call-header")
    .getByRole("button", { name: "Record livestream", exact: true });
  await expect(recordButton).toBeVisible();

  // Keep both focus targets outside the route so they survive its teardown.
  await page.evaluate(() => {
    const saved = document.createElement("button");
    saved.id = "saved-external-focus-target";
    const current = document.createElement("button");
    current.id = "current-external-focus-target";
    document.body.append(saved, current);
    saved.focus();
  });
  await page.evaluate(async (loader) => {
    const { liveStreamStore } = await new Function(loader)();
    liveStreamStore.setOffline(true);
  }, LIVE_STREAM_STORE_LOADER);
  await expect(page.getByTestId("private-call-reconnect")).toBeFocused();

  // Going online queues the restoration tick. Start navigation in the same
  // browser task so route teardown aborts that pending callback.
  await page.evaluate(async (loader) => {
    const { liveStreamStore } = await new Function(loader)();
    const path =
      "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
    const { goto } = await import(path);
    liveStreamStore.setOffline(false);
    await goto("/dashboard?lang=en");
  }, LIVE_STREAM_STORE_LOADER);
  const currentTarget = page.locator("#current-external-focus-target");
  await currentTarget.focus();
  await expect(page.getByTestId("private-call-header")).toHaveCount(0);
  await expect(currentTarget).toBeFocused();
  await page.waitForTimeout(50);
  await expect(currentTarget).toBeFocused();
});

test("a private-call recovery response cannot navigate a changed account", async ({
  page,
}) => {
  await openDashboard(page);
  await page.locator('label[for="stream-audience-private"]').click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reading = false;
  await page.route(`**/api/dyte/${USER}/private`, async (route) => {
    if (route.request().method() === "POST")
      return route.fulfill({ status: 409, json: { code: "recording_active" } });
    reading = true;
    await gate;
    await route.fulfill({
      json: { secret: "428f3df0-59b7-4ee5-98ef-df7045436005", e2ee: false },
    });
  });
  await page.getByTestId("stream-start").click();
  await page
    .getByRole("button", { name: "Return to current call", exact: true })
    .click();
  await expect.poll(() => reading).toBe(true);
  await changeAccount(page);
  release();
  await expect(
    page.getByRole("button", { name: "Return to current call", exact: true }),
  ).toHaveCount(0);
  await expect(page).not.toHaveURL(/\/private\//);
  await expect(
    page.getByText("Secret link copied to the clipboard!", { exact: true }),
  ).toHaveCount(0);
});

for (const phase of [
  "token",
  "provider",
  "joined",
  "joined-delayed-leave",
  "room-left",
] as const) {
  for (const returnToA of [false, true]) {
    test(`private call invalidates account credentials during ${phase}, returnToA: ${returnToA}`, async ({
      page,
    }) => {
      await openDashboard(page);
      await stubProvider(
        page,
        phase === "provider",
        true,
        phase === "joined-delayed-leave" || phase === "room-left",
      );
      const secret = "8367f7e5-5588-4a7d-a6e4-7c83bb6496ee";
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let requested = false;
      await page.route(
        `**/api/dyte/${USER}/private/${secret}`,
        async (route) => {
          requested = true;
          if (phase === "token") await gate;
          await route
            .fulfill({
              json: { auth_token: "synthetic-private-account-a", e2ee: false },
            })
            .catch(() => {});
        },
      );
      await page.evaluate(
        async ({ user, secret }) => {
          const path =
            "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
          const { goto } = await import(path);
          await goto(`/${user}/private/${secret}?lang=en`);
        },
        { user: USER, secret },
      );
      await expect.poll(() => requested).toBe(true);
      if (phase !== "token") {
        await expect
          .poll(() => page.evaluate(() => window.hostTest.sdkCalls.length))
          .toBe(1);
      }
      if (phase.startsWith("joined") || phase === "room-left")
        await expect(page.getByTestId("private-call-header")).toBeVisible();
      if (phase === "room-left")
        await page.evaluate(() => window.hostTest.endRoom());
      await changeAccount(page, returnToA);
      if (phase === "token") release();
      if (phase === "provider")
        await page.evaluate(() => window.hostTest.finishProvider());
      await expect(
        page.getByText(
          "Your account changed. Reload to join this call with the current account.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByTestId("private-call-header")).toHaveCount(0);
      const globalMeeting = await meetingState(page);
      expect(globalMeeting.room).toBeNull();
      expect(globalMeeting.host).toBe(false);
      if (phase === "joined-delayed-leave" || phase === "room-left") {
        await page.evaluate(() => window.hostTest.finishLeave());
        if (phase === "room-left") {
          await page.waitForTimeout(300);
          await expect(page).toHaveURL(new RegExp(`/private/${secret}`));
        }
      }
      if (phase === "token") {
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => window.hostTest.sdkCalls.length)).toBe(
          0,
        );
      } else {
        await expect
          .poll(() => page.evaluate(() => window.hostTest.left))
          .toBeGreaterThan(0);
      }
    });
  }
}

for (const initialFailure of [false, true]) {
  test(`a cold private-call load waits for session resolution, initialFailure: ${initialFailure}`, async ({
    page,
  }) => {
    // This case compiles the private-call SSR route before any dashboard visit.
    test.setTimeout(60_000);
    await prepareSession(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let authRequested = false;
    let authAttempts = 0;
    let joinRequested = false;
    await page.route("**/api/auth/user/", async (route) => {
      authAttempts++;
      if (initialFailure && authAttempts === 1) {
        await route.fulfill({
          status: 503,
          json: { detail: "Synthetic transient session failure" },
        });
        return;
      }
      authRequested = true;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    const secret = "3f961c9d-aee4-4d87-83eb-6f7ba892e1c4";
    await page.route(`**/api/dyte/${USER}/private/${secret}`, async (route) => {
      joinRequested = true;
      await route.fulfill({
        json: { auth_token: "synthetic-cold-private-call", e2ee: false },
      });
    });
    await page.goto(`/${USER}/private/${secret}?lang=en`);
    await expect.poll(() => authRequested).toBe(true);
    expect(joinRequested).toBe(false);
    await stubProvider(page, false, true);
    release();
    await expect.poll(() => joinRequested).toBe(true);
    await expect
      .poll(() => page.evaluate(() => window.hostTest.sdkCalls.length))
      .toBe(1);
    await expect(page.getByTestId("private-call-header")).toBeVisible();
    expect((await meetingState(page)).host).toBe(true);
    await expect(
      page.getByText(
        "Your account changed. Reload to join this call with the current account.",
      ),
    ).toHaveCount(0);
  });
}

test("private recovery stays single-flight while provider leave is pending", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await prepareSession(page);
  const secret = "3f961c9d-aee4-4d87-83eb-6f7ba892e1c4";
  let releaseJoin!: () => void;
  let joinRequested = false;
  const joinGate = new Promise<void>((resolve) => {
    releaseJoin = resolve;
  });
  let joins = 0;
  await page.route(`**/api/dyte/${USER}/private/${secret}`, async (route) => {
    joinRequested = true;
    joins++;
    await joinGate;
    await route.fulfill({
      json: { auth_token: `synthetic-private-${joins}`, e2ee: false },
    });
  });
  await page.goto(`/${USER}/private/${secret}?lang=en`);
  await expect.poll(() => joinRequested).toBe(true);
  await stubProvider(page, false, true, true);
  releaseJoin();
  await expect(page.getByTestId("private-call-header")).toBeVisible();
  await expect.poll(() => joins).toBe(1);

  await page.evaluate(async (loader) => {
    const { liveStreamStore } = await new Function(loader)();
    liveStreamStore.setConnectionStatus("failed");
  }, LIVE_STREAM_STORE_LOADER);
  await expect.poll(() => page.evaluate(() => window.hostTest.left)).toBe(1);
  await page.evaluate(async (loader) => {
    const { liveStreamStore } = await new Function(loader)();
    liveStreamStore.setConnectionStatus("connected");
    liveStreamStore.setConnectionStatus("failed");
  }, LIVE_STREAM_STORE_LOADER);
  await page.waitForTimeout(2_000);
  expect(joins).toBe(1);

  await page.evaluate(() => window.hostTest.finishLeave());
  await expect.poll(() => joins).toBe(2);
  await expect
    .poll(() => page.evaluate(() => window.hostTest.sdkCalls.length))
    .toBe(2);
});

test("an online event does not overlap a gated initial private join", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await prepareSession(page);
  const secret = "private-initial-join-online-single-flight";
  let attempts = 0;
  let releaseInitial!: () => void;
  const initialGate = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  await page.route(`**/api/dyte/${USER}/private/${secret}`, async (route) => {
    attempts++;
    await initialGate;
    await route.fulfill({
      json: { auth_token: `synthetic-private-${attempts}`, e2ee: false },
    });
  });

  await page.goto(`/${USER}/private/${secret}?lang=en`);
  await expect.poll(() => attempts).toBe(1);
  await stubProvider(page, false, true);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  // The retry timer is longer than this wait. The still-pending initial token
  // request must remain the only request even when online recovery fires.
  await page.waitForTimeout(2_200);
  expect(attempts).toBe(1);
  releaseInitial();
  await expect(page.getByTestId("private-call-header")).toBeVisible();
  await expect.poll(() => attempts).toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.hostTest.sdkCalls.length))
    .toBe(1);
});

test("private recovery retries a failed join after coming back online", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await prepareSession(page);
  const secret = "private-recovery-retries-room";
  let attempts = 0;
  let releaseInitial!: () => void;
  const initialGate = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  await page.route(`**/api/dyte/${USER}/private/${secret}`, async (route) => {
    attempts++;
    if (attempts === 1) await initialGate;
    if (attempts === 2) {
      await route.fulfill({
        status: 503,
        json: { detail: "temporary outage" },
      });
      return;
    }
    await route.fulfill({
      json: { auth_token: `synthetic-private-${attempts}`, e2ee: false },
    });
  });
  await page.goto(`/${USER}/private/${secret}?lang=en`);
  await expect.poll(() => attempts).toBe(1);
  await stubProvider(page, false, true);
  releaseInitial();
  await expect(page.getByTestId("private-call-header")).toBeVisible();
  await expect.poll(() => attempts).toBe(1);

  // A failed room while offline must not start recovery. Returning online
  // should re-arm recovery; the first attempt fails transiently and a later
  // scheduled attempt must proceed after the in-flight guard is released.
  await page.evaluate(async (loader) => {
    const { liveStreamStore } = await new Function(loader)();
    liveStreamStore.setOffline(true);
    liveStreamStore.setConnectionStatus("failed");
  }, LIVE_STREAM_STORE_LOADER);
  await page.waitForTimeout(1_300);
  expect(attempts).toBe(1);
  await page.evaluate(async (loader) => {
    const { liveStreamStore } = await new Function(loader)();
    liveStreamStore.setOffline(false);
  }, LIVE_STREAM_STORE_LOADER);
  await expect.poll(() => attempts, { timeout: 10_000 }).toBe(3);
  await expect
    .poll(() => page.evaluate(() => window.hostTest.sdkCalls.length))
    .toBe(2);
  await expect(page.getByTestId("private-call-header")).toBeVisible();
});

test("a private-call route change during a rejected join retains reload controls", async ({
  page,
}) => {
  await openDashboard(page);
  await stubProvider(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route(
    `**/api/dyte/${USER}/private/pending-room`,
    async (route) => {
      requested = true;
      await gate;
      await route.abort("failed").catch(() => {});
    },
  );
  const navigate = (secret: string) =>
    page.evaluate(
      async ({ user, secret }) => {
        const path =
          "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
        const { goto } = await import(path);
        await goto(`/${user}/private/${secret}?lang=en`);
      },
      { user: USER, secret },
    );
  await navigate("pending-room");
  await expect.poll(() => requested).toBe(true);
  await navigate("selected-room");
  release();
  await expect(
    page.getByText(
      "The private call link changed. Reload to join the selected call.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Try Again", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.hostTest.sdkCalls.length)).toBe(0);
});

test("exhausted private-call identity checks do not join with an unverified owner", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await prepareSession(page);
  let authAttempts = 0;
  let joinRequested = false;
  await page.route("**/api/auth/user/", async (route) => {
    authAttempts++;
    if (authAttempts <= 3) {
      await route.fulfill({
        status: 503,
        json: { detail: "Synthetic session outage" },
      });
    } else {
      await route.fulfill({ response: await route.fetch() });
    }
  });
  const secret = "identity-outage-room";
  await page.route(`**/api/dyte/${USER}/private/${secret}`, async (route) => {
    joinRequested = true;
    await route.fulfill({
      json: { auth_token: "synthetic-recovered-owner", e2ee: false },
    });
  });
  // Document load can precede hydration and both bounded bootstrap retries.
  // Assert the error UI only after the three failing identity reads complete.
  const exhaustedChecks = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/user/" &&
      response.status() === 503 &&
      authAttempts === 3,
  );
  await page.goto(`/${USER}/private/${secret}?lang=en`);
  await (await exhaustedChecks).finished();
  await expect(
    page.getByRole("button", { name: "Try Again", exact: true }),
  ).toBeVisible();
  expect(authAttempts).toBe(3);
  expect(joinRequested).toBe(false);
  await stubProvider(page, false, true);
  await page.evaluate(async (loader) => {
    const { authStore } = await new Function(loader)();
    await authStore.checkAuth({ force: true, silent: true });
  }, AUTH_STORE_LOADER);
  await expect.poll(() => joinRequested).toBe(true);
  await expect(page.getByTestId("private-call-header")).toBeVisible();
  expect((await meetingState(page)).host).toBe(true);
  await expect(
    page.getByText(
      "Your account changed. Reload to join this call with the current account.",
    ),
  ).toHaveCount(0);
});
