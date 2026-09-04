import { expect, test, type Page } from "@playwright/test";

const PROFILE_WIDTHS = [320, 390, 767, 768, 799, 800, 801, 900, 1023, 1024] as const;

type Box = {
  clientWidth: number;
  height: number;
  left: number;
  right: number;
  scrollWidth: number;
  top: number;
};

type CreatorLayout = {
  actions: Box;
  actionTargets: Array<Box & { name: string }>;
  content: Box;
  grid: Box;
  gridCards: Box[];
  gridColumns: number;
  handle: Box;
  header: Box;
  headerDirection: string;
  identity: Box;
  name: Box;
  profile: Box;
  route: Box;
};

async function openCreator(page: Page, username = "zooko") {
  await page.goto(`/creator/${username}`);
  await page.locator("[data-creator-profile]").waitFor();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator(".creator-pages-grid")).toBeVisible();
}

async function creatorLayout(page: Page): Promise<CreatorLayout> {
  return page.evaluate(() => {
    function required(selector: string): HTMLElement {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing creator layout element: ${selector}`);
      return element;
    }

    function box(element: HTMLElement): Box {
      const rect = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        scrollWidth: element.scrollWidth,
        top: rect.top,
      };
    }

    const route = required("[data-scroll-area-viewport]");
    const content = required("main.app-scroll-content");
    const profile = required("[data-creator-profile]");
    const header = required("[data-creator-profile-header]");
    const identity = required("[data-creator-identity]");
    const actions = required("[data-creator-actions]");
    const grid = required(".creator-pages-grid");
    const name = required("[data-creator-identity] h1");
    const handle = [...identity.querySelectorAll<HTMLElement>("div")].find(
      (element) => element.textContent?.trim() === "@zooko",
    );
    if (!handle) throw new Error("Creator handle is missing");

    const actionTargets = [...actions.querySelectorAll<HTMLElement>("a, button")].map(
      (element) => ({
        ...box(element),
        name: element.getAttribute("aria-label") ?? element.innerText.trim(),
      }),
    );

    return {
      actions: box(actions),
      actionTargets,
      content: box(content),
      grid: box(grid),
      gridCards: [...grid.children].map((element) => box(element as HTMLElement)),
      gridColumns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      handle: box(handle),
      header: box(header),
      headerDirection: getComputedStyle(header).flexDirection,
      identity: box(identity),
      name: box(name),
      profile: box(profile),
      route: box(route),
    };
  });
}

function expectNoHorizontalOverflow(layout: CreatorLayout, width: number) {
  const expectedRouteWidth = width >= 768 ? width - 240 : width;
  const expectedProfileWidth = expectedRouteWidth - (width >= 768 ? 64 : 32);
  const tolerance = 1;

  expect(layout.route.clientWidth, "Radix route viewport must reflect the sidebar").toBe(
    expectedRouteWidth,
  );
  expect(layout.content.clientWidth, "route content must use the Radix viewport").toBe(
    expectedRouteWidth,
  );
  expect(layout.profile.clientWidth, "profile width must come from route content").toBe(
    expectedProfileWidth,
  );

  for (const [name, element] of Object.entries({
    route: layout.route,
    content: layout.content,
    profile: layout.profile,
    header: layout.header,
    identity: layout.identity,
    actions: layout.actions,
    grid: layout.grid,
  })) {
    expect(
      element.scrollWidth,
      `${name} must not acquire horizontal overflow at ${width}px`,
    ).toBeLessThanOrEqual(element.clientWidth + tolerance);
    expect(element.left, `${name} must stay inside the route's left edge`).toBeGreaterThanOrEqual(
      layout.route.left - tolerance,
    );
    expect(element.right, `${name} must stay inside the route's right edge`).toBeLessThanOrEqual(
      layout.route.right + tolerance,
    );
  }

  expect(layout.name.clientWidth, "creator name must remain readable").toBeGreaterThan(0);
  expect(layout.name.right, "creator name must stay inside its identity row").toBeLessThanOrEqual(
    layout.identity.right + tolerance,
  );
  expect(layout.handle.right, "creator handle must stay inside its identity row").toBeLessThanOrEqual(
    layout.identity.right + tolerance,
  );

  // ZUULI's action row leads with "Watch Zooko live". `features/live` has not
  // moved to this surface (#904), so the live signal is a non-interactive
  // marker here and only the two paid actions are touch targets.
  expect(layout.actionTargets.map(({ name }) => name)).toEqual([
    "Tip Zooko",
    "Subscribe to Zooko · 500 2Z/mo",
  ]);
  for (const target of layout.actionTargets) {
    expect(target.height, `${target.name} must keep its 44px touch height`).toBeGreaterThanOrEqual(
      44,
    );
    expect(
      target.clientWidth,
      `${target.name} must keep its 44px touch width`,
    ).toBeGreaterThanOrEqual(44);
    expect(target.left, `${target.name} must stay inside the actions row`).toBeGreaterThanOrEqual(
      layout.actions.left - tolerance,
    );
    expect(target.right, `${target.name} must stay inside the actions row`).toBeLessThanOrEqual(
      layout.actions.right + tolerance,
    );
  }

  const expectedColumns = layout.profile.clientWidth >= 672 ? 3 : layout.profile.clientWidth >= 384 ? 2 : 1;
  expect(layout.gridColumns, "page grid columns must follow profile width").toBe(
    expectedColumns,
  );
  expect(layout.gridCards.length, "published pages must remain visible").toBeGreaterThan(0);
  for (const card of layout.gridCards) {
    expect(card.left, "page cards must stay inside the grid").toBeGreaterThanOrEqual(
      layout.grid.left - tolerance,
    );
    expect(card.right, "page cards must stay inside the grid").toBeLessThanOrEqual(
      layout.grid.right + tolerance,
    );
  }

  expect(layout.headerDirection, "header breakpoint must follow profile width").toBe(
    layout.profile.clientWidth >= 720 ? "row" : "column",
  );
}

test("creator profile follows its Radix route viewport from phones through sidebar tablets", async ({
  page,
}) => {
  for (const width of PROFILE_WIDTHS) {
    await page.setViewportSize({ width, height: 1280 });
    await openCreator(page);
    expectNoHorizontalOverflow(await creatorLayout(page), width);
  }
});

test("tablet creator actions remain usable and preserve anonymous tip intent", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 1280 });
  await openCreator(page);

  const tip = page.getByRole("button", { name: "Tip Zooko" });
  await tip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Tip Zooko" })).toBeVisible();
  await page.getByLabel("Amount (2Z)").fill("5000");
  await expect(page.getByText(/^(?:Your |Current )?Balance(?: after)?:/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in to tip" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem("zuuli.auth.pending-paid-intent");
        return raw ? JSON.parse(raw) : null;
      }),
    )
    .toMatchObject({
      returnTo: "/creator/zooko",
      intent: { amount: "5000", kind: "creator-tip", subject: "zooko" },
    });
});

test("free follow keeps a 44px target and preserves its sign-in return", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 1280 });
  await openCreator(page, "f2z");

  const follow = page.getByRole("button", { name: "Follow Free2Z" });
  const followBox = await follow.boundingBox();
  const routeBox = await page.locator("[data-scroll-area-viewport]").boundingBox();
  expect(followBox).not.toBeNull();
  expect(routeBox).not.toBeNull();
  expect(followBox!.width).toBeGreaterThanOrEqual(44);
  expect(followBox!.height).toBeGreaterThanOrEqual(44);
  expect(followBox!.x).toBeGreaterThanOrEqual(routeBox!.x - 1);
  expect(followBox!.x + followBox!.width).toBeLessThanOrEqual(
    routeBox!.x + routeBox!.width + 1,
  );

  await follow.click();
  await expect(page).toHaveURL(/\/login$/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem("zuuli.auth.pending-paid-intent");
        return raw ? JSON.parse(raw) : null;
      }),
    )
    .toMatchObject({
      returnTo: "/creator/f2z",
      intent: { kind: "creator-subscription", subject: "f2z" },
    });
});
