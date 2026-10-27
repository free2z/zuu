import { expect, test, type Page, type Route } from "@playwright/test";
import { AUTH_STORE_LOADER } from "./dev-source-module";

const USER = "streamaudienceowner";
const DASHBOARD = `/${USER}/dashboard/stream`;
const SECRET = "owner-a-private-secret";

declare global {
  interface Window {
    hostTest: {
      copied: string[];
      sdkCalls: any[];
      left: number;
      finishProvider: () => void;
      finishLeave: () => void;
      endRoom: () => void;
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
      left: 0,
      finishProvider: () => {},
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
) {
  await page.evaluate(
    async ({ held, canRecord, heldLeave }) => {
      const text = await (await fetch("/src/lib/utils/rtk-manager.ts")).text();
      const path = text.match(
        /from \"([^\"]*cloudflare_realtimekit[^\"]*)\"/,
      )?.[1];
      if (!path)
        throw new Error("Actual host manager SDK import was not found");
      const { default: SDK } = await import(path);
      const meeting = {
        meta: { meetingTitle: "owner-a-room" },
        recording: {
          recordingState: "IDLE",
          addListener: () => {},
          removeListener: () => {},
        },
        self: {
          on: (
            name: string,
            callback: (event: { state: string }) => Promise<void>,
          ) => {
            if (name === "roomLeft")
              window.hostTest.endRoom = () => {
                void callback({ state: "left" });
              };
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
        if (held) {
          held = false;
          await new Promise<void>((resolve) => {
            window.hostTest.finishProvider = resolve;
          });
        }
        return meeting;
      };
    },
    { held, canRecord, heldLeave },
  );
}

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
        const method = route.request().method();
        const stop = new URL(route.request().url()).pathname.endsWith("/stop");
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
  await page.goto(`/${USER}/private/${secret}?lang=en`);
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
