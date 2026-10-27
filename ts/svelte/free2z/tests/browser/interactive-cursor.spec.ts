import { expect, test, type Page } from "@playwright/test";
import { browserAppOrigin } from "./ports";

/**
 *enabled interactions need one site-wide pointer affordance. This
 * visits the real notifications page because its headline was the reported
 * native-button miss, then checks the shared Button/Select controls and the
 * controls' disabled and inert counterparts.
 */
test.describe.configure({ timeout: 90_000 });

const VIEWPORT = { width: 1280, height: 900 };
const CREATOR = {
  id: 1498,
  username: "cursor-fixture-user",
  full_name: "Cursor Fixture User",
};

const EVENTS = [
  {
    id: "cursor-headline",
    type: "PAGE_UPDATE",
    amount: 0,
    receiving_user: CREATOR,
    contributor: {
      id: 2,
      username: "cursor-author",
      full_name: "Cursor Author",
    },
    payee: null,
    message: "ignored by the client formatter",
    content_url: "/cursor-fixture-target",
    content_title: "A cursor fixture article",
    created_at: "2026-08-30T12:00:00Z",
    read: false,
  },
  {
    id: "cursor-inert-event",
    type: "NEW_REPLY",
    amount: 0,
    receiving_user: CREATOR,
    contributor: {
      id: 3,
      username: "inert-author",
      full_name: "Inert Author",
    },
    payee: null,
    message: "ignored by the client formatter",
    content_url: null,
    content_title: null,
    created_at: "2026-08-29T12:00:00Z",
    read: true,
  },
];

async function installMocks(page: Page) {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "cursor-fixture-session",
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

  let readAllRequested = () => {};
  const readAllRequest = new Promise<void>((resolve) => {
    readAllRequested = resolve;
  });
  let releaseReadAll = () => {};
  const readAllReleased = new Promise<void>((resolve) => {
    releaseReadAll = resolve;
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    // Vite source modules can also match this route pattern.
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
        json: { unread_count: 1, recipient_username: CREATOR.username },
      });
      return;
    }
    if (pathname === "/api/events/" && request.method() === "GET") {
      await route.fulfill({
        json: { count: EVENTS.length, next: null, results: EVENTS },
      });
      return;
    }
    if (pathname === "/api/events/read/all/" && request.method() === "POST") {
      readAllRequested();
      await readAllReleased;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (
      pathname.startsWith("/api/events/read/") &&
      request.method() === "POST"
    ) {
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    await route.fulfill({ json: { count: 0, results: [], next: null } });
  });

  return {
    readAllRequest,
    releaseReadAll: () => releaseReadAll(),
  };
}

async function openNotifications(page: Page) {
  await page.setViewportSize(VIEWPORT);
  await page.goto(`/${CREATOR.username}/dashboard/notifications`, {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("button", {
      name: /a cursor fixture article.*was updated/i,
    }),
  ).toBeVisible({ timeout: 30_000 });
}

async function mockCreatorDirectory(page: Page) {
  await page.route(
    (url) => url.pathname === "/api/creator/",
    (route) =>
      route.fulfill({
        json: { count: 0, next: null, previous: null, results: [] },
      }),
  );
  await page.route(
    (url) => url.pathname === "/api/zpage/",
    (route) =>
      route.fulfill({
        json: { count: 0, next: null, previous: null, results: [] },
      }),
  );
}

async function mountBrowserFixture(
  page: Page,
  fixtureModule: string,
  props: Record<string, unknown> = {},
) {
  // Load a normal page so the root layout's stylesheet and hydrated SvelteKit
  // tree are present. Keep that tree mounted: replacing body.innerHTML races
  // Svelte's pending hydration/effect cleanup in CI. Hide its top-level
  // children and mount the harness beside them instead.
  // Disconnect any previous Vite client before warming a fixture. A cold
  // optimizer can broadcast a full reload to connected pages while it finds
  // dependencies; warming from about:blank keeps that reload out of a mounted
  // Svelte tree.
  await page.goto("about:blank");
  for (const modulePath of [fixtureModule, "/tests/browser/svelte-mount.ts"]) {
    const fixtureResponse = await page.request.get(
      new URL(modulePath, browserAppOrigin()).toString(),
    );
    if (!fixtureResponse.ok()) {
      throw new Error(
        `Vite fixture prewarm failed (${fixtureResponse.status()}): ${modulePath}`,
      );
    }
  }
  await page.goto("/search");
  const mountFixture = () =>
    page.evaluate(
      async ({ fixtureModule, props }) => {
        for (const child of Array.from(document.body.children)) {
          child.setAttribute("hidden", "");
          child.setAttribute("aria-hidden", "true");
        }
        const harness = document.createElement("main");
        harness.id = "component-harness";
        document.body.append(harness);
        // Load the component graph first. If Vite just replaced an optimized
        // dependency chunk, loading Svelte concurrently can capture the stale
        // runtime while the component resolves against the new one.
        const { default: CursorFixture } = await import(fixtureModule);
        const loadSvelteMount = new Function(
          "specifier",
          "return import(specifier)",
        ) as (
          specifier: string,
        ) => Promise<{ mount: typeof import("svelte").mount }>;
        const { mount } = await loadSvelteMount(
          "/tests/browser/svelte-mount.ts",
        );
        mount(CursorFixture, {
          target: document.querySelector("#component-harness")!,
          props,
        });
      },
      { fixtureModule, props },
    );

  await mountFixture();
}

async function mountPrimitiveFixture(page: Page) {
  await mountBrowserFixture(
    page,
    "/tests/browser/interactive-cursor-fixture.svelte",
  );
  await expect(page.locator('[data-testid="button-enabled"]')).toBeVisible();
}

test("the real notification headline and enabled shared controls use a pointer", async ({
  page,
}) => {
  await installMocks(page);
  await openNotifications(page);

  const headline = page.getByRole("button", {
    name: /a cursor fixture article.*was updated/i,
  });
  await expect(headline).toHaveCSS("cursor", "pointer");
  await expect(page.getByRole("button", { name: "Mark read" })).toHaveCSS(
    "cursor",
    "pointer",
  );

  const readFilter = page.getByRole("button", {
    name: "Filter notifications by read status",
  });
  await expect(readFilter).toHaveCSS("cursor", "pointer");
  await readFilter.click();
  await expect(page.getByRole("option", { name: "Unread" })).toHaveCSS(
    "cursor",
    "pointer",
  );
});

test("the real notification headline opens its event target", async ({
  page,
}) => {
  await installMocks(page);
  await openNotifications(page);

  await page
    .getByRole("button", { name: /a cursor fixture article.*was updated/i })
    .click();

  await expect(page).toHaveURL(/\/cursor-fixture-target$/);
});

test("creator active-filter chips are pointer and keyboard buttons", async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORT);
  await mockCreatorDirectory(page);
  await page.addInitScript(() =>
    localStorage.setItem("creators_verified_status", "verified"),
  );
  await page.goto("/creators", { waitUntil: "domcontentloaded" });

  const verification = page.getByRole("button", { name: /verified only/i });
  const chips = page.getByTestId("creator-active-filter").filter({
    visible: true,
  });
  const chip = chips.first();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveJSProperty("tagName", "BUTTON");
  await expect(chip).toHaveAccessibleName("Remove filter: Verified");
  await expect(chip).toHaveCSS("cursor", "pointer");

  await chip.focus();
  await page.keyboard.press("Enter");
  const allCreators = page.getByRole("button", { name: /all creators/i });
  await expect(allCreators).toHaveText("All creators");

  await page.evaluate(() =>
    localStorage.setItem("creators_verified_status", "verified"),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(chip).toBeVisible();
  const bounds = await chip.boundingBox();
  if (!bounds) throw new Error("Active filter chip has no bounds");
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await expect(allCreators).toHaveText("All creators");
});

test("disabled and inert controls keep non-pointer cursors", async ({
  page,
}) => {
  const { readAllRequest, releaseReadAll } = await installMocks(page);
  await openNotifications(page);

  // This is the real shared Button disabled branch. Holding its request keeps
  // `disabled` true long enough to observe the cursor before the response.
  const markAll = page.getByRole("button", {
    name: /mark all as read|marking/i,
  });
  await markAll.click();
  await readAllRequest;
  await expect(markAll).toBeDisabled();
  // With pointer-events enabled, Playwright can hover the disabled native
  // button itself instead of falling through to its ancestor.
  await expect(markAll).toHaveCSS("pointer-events", "auto");
  await markAll.hover();
  await expect(markAll).toHaveCSS("cursor", "not-allowed");
  releaseReadAll();

  const inertHeadline = page.getByText("New reply from inert-author.", {
    exact: true,
  });
  await expect(inertHeadline).toHaveCSS("cursor", "auto");

  // These are deliberately non-interactive or explicitly specialized test
  // controls, with no click-only div. The semantic rule must not turn text,
  // drag, resize, or zoom surfaces into generic pointers or erase their
  // intentional cursor contracts.
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.innerHTML = `
      <a data-cursor-link href="/cursor-link">link</a>
      <button data-cursor-native-button type="button">native button</button>
      <details><summary data-cursor-summary>details summary</summary></details>
      <input data-cursor-text type="text" value="copy">
      <textarea data-cursor-textarea>copy</textarea>
      <div data-cursor-inert>copy</div>
      <div data-cursor-drag style="cursor: move">drag</div>
      <div data-cursor-resize style="cursor: col-resize">resize</div>
      <div data-cursor-zoom style="cursor: zoom-in">zoom</div>
      <button data-cursor-disabled disabled>disabled</button>
      <button data-cursor-aria-disabled aria-disabled="true">aria disabled</button>
    `;
    document.body.append(fixture);
  });

  for (const selector of [
    "[data-cursor-link]",
    "[data-cursor-native-button]",
    "[data-cursor-summary]",
  ]) {
    await expect(page.locator(selector)).toHaveCSS("cursor", "pointer");
  }

  await expect(page.locator("[data-cursor-text]")).toHaveCSS("cursor", "text");
  await expect(page.locator("[data-cursor-textarea]")).toHaveCSS(
    "cursor",
    "text",
  );
  await expect(page.locator("[data-cursor-inert]")).toHaveCSS("cursor", "auto");
  await expect(page.locator("[data-cursor-drag]")).toHaveCSS("cursor", "move");
  await expect(page.locator("[data-cursor-resize]")).toHaveCSS(
    "cursor",
    "col-resize",
  );
  await expect(page.locator("[data-cursor-zoom]")).toHaveCSS(
    "cursor",
    "zoom-in",
  );
  await expect(page.locator("[data-cursor-disabled]")).not.toHaveCSS(
    "cursor",
    "pointer",
  );
  await expect(page.locator("[data-cursor-aria-disabled]")).not.toHaveCSS(
    "cursor",
    "pointer",
  );

  await page.evaluate(() => {
    const disabledInput = document.createElement("input");
    disabledInput.id = "associated-disabled-input";
    disabledInput.disabled = true;
    const disabledLabel = document.createElement("label");
    disabledLabel.htmlFor = disabledInput.id;
    disabledLabel.dataset.cursorDisabledLabel = "true";
    disabledLabel.textContent = "Disabled field";
    document.body.append(disabledInput, disabledLabel);
  });
  // `label[for]` is outside the CSS contract (it cannot see the state of a
  // control elsewhere in the DOM), so an ENABLED one is default too: this
  // pins that the disabled case stays non-pointer, not that the rule fired.
  // The wrapping form, which the rule does cover, is tested below.
  await expect(page.locator("[data-cursor-disabled-label]")).toHaveCSS(
    "cursor",
    "default",
  );
});

test("a label that wraps an enabled choice control uses a pointer; disabled or text-field labels do not", async ({
  page,
}) => {
  await mountPrimitiveFixture(page);

  // The shared Checkbox/Switch render a role=checkbox|switch <button>.
  for (const id of [
    "label-wraps-checkbox-enabled",
    "label-wraps-switch-enabled",
  ]) {
    await expect(page.getByTestId(id)).toHaveCSS("cursor", "pointer");
  }
  for (const id of [
    "label-wraps-checkbox-disabled",
    "label-wraps-switch-disabled",
  ]) {
    await expect(page.getByTestId(id)).not.toHaveCSS("cursor", "pointer");
  }

  // Clicking the wrapping label really activates the control: the pointer is
  // telling the truth.
  const wrapped = page
    .getByTestId("label-wraps-checkbox-enabled")
    .getByRole("checkbox");
  await expect(wrapped).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("label-wraps-checkbox-enabled").click();
  await expect(wrapped).toHaveAttribute("aria-checked", "true");

  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.innerHTML = `
      <label data-native-checkbox><input type="checkbox"> native checkbox</label>
      <label data-native-radio><input type="radio" name="r"> native radio</label>
      <label data-native-file><input type="file" hidden> upload</label>
      <label data-native-checkbox-disabled><input type="checkbox" disabled> disabled</label>
      <fieldset disabled>
        <label data-native-fieldset-disabled><input type="radio" name="f"> in a disabled fieldset</label>
      </fieldset>
      <label data-native-text>Name <input type="text"></label>
      <label data-native-bare>no control at all</label>
    `;
    document.body.append(fixture);
  });

  for (const selector of [
    "[data-native-checkbox]",
    "[data-native-radio]",
    "[data-native-file]",
  ]) {
    await expect(page.locator(selector)).toHaveCSS("cursor", "pointer");
  }
  for (const selector of [
    "[data-native-checkbox-disabled]",
    "[data-native-fieldset-disabled]",
    "[data-native-text]",
    "[data-native-bare]",
  ]) {
    await expect(page.locator(selector)).toHaveCSS("cursor", "default");
  }
});

test("shared command, dropdown, and select primitives expose enabled and disabled cursor states", async ({
  page,
}) => {
  await mountPrimitiveFixture(page);

  for (const selector of [
    "[data-testid=button-enabled]",
    "[data-testid=command-item-enabled]",
    "[data-testid=command-link-item-enabled]",
  ]) {
    await expect(page.locator(selector)).toHaveCSS("cursor", "pointer");
  }
  for (const selector of [
    "[data-testid=button-disabled]",
    "[data-testid=command-item-disabled]",
    "[data-testid=command-link-item-disabled]",
  ]) {
    await expect(page.locator(selector)).toHaveCSS(
      "cursor",
      selector.includes("button") ? "not-allowed" : "default",
    );
  }

  await page.getByTestId("dropdown-trigger").click();
  for (const selector of [
    "[data-testid=dropdown-item-enabled]",
    "[data-testid=dropdown-checkbox-enabled]",
    "[data-testid=dropdown-radio-enabled]",
    "[data-testid=dropdown-sub-trigger-enabled]",
  ]) {
    await expect(page.locator(selector)).toHaveCSS("cursor", "pointer");
  }
  for (const selector of [
    "[data-testid=dropdown-item-disabled]",
    "[data-testid=dropdown-checkbox-disabled]",
    "[data-testid=dropdown-radio-disabled]",
    "[data-testid=dropdown-sub-trigger-disabled]",
  ]) {
    await expect(page.locator(selector)).toHaveCSS("cursor", "default");
  }

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("dropdown-item-enabled")).toBeHidden();
  await page.getByTestId("select-trigger").click();
  await expect(page.getByTestId("select-item-1")).toHaveCSS(
    "cursor",
    "pointer",
  );
  await expect(page.getByTestId("select-item-20")).toHaveCSS(
    "cursor",
    "default",
  );

  const scrollUp = page.locator('[data-slot="select-scroll-up-button"]');
  const scrollDown = page.locator('[data-slot="select-scroll-down-button"]');
  // Bits UI mounts each scroll button only while scrolling in that direction
  // is possible, so the button at the current edge is absent rather than a
  // hidden element with a computed cursor.
  await expect(scrollUp).toHaveCount(0);
  await expect(scrollDown).toHaveCSS("cursor", "pointer");

  const viewport = page.locator("[data-select-viewport]");
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(scrollUp).toHaveCSS("cursor", "pointer");
  await expect(scrollDown).toHaveCount(0);
});

test("editor cover picker is a native pointer and keyboard activated button", async ({
  page,
}) => {
  await mountBrowserFixture(page, "/tests/browser/editor-cover-fixture.svelte");

  const coverPicker = page.getByRole("button", {
    name: "Add or change the cover image",
  });
  await expect(coverPicker).toBeVisible();
  await expect(coverPicker).toHaveJSProperty("tagName", "BUTTON");
  await expect(coverPicker).toHaveCSS("cursor", "pointer");
  await expect(coverPicker.locator("button, a")).toHaveCount(0);

  await page.keyboard.press("Tab");
  await expect(coverPicker).toBeFocused();
  await expect(
    page.locator(".group .border-dashed"),
    "the empty cover placeholder becomes visible while its button has keyboard focus",
  ).toHaveCSS("opacity", "1");
  const focusedBoxShadow = await coverPicker.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  expect(focusedBoxShadow).not.toBe("none");

  const dialog = page.getByRole("dialog", { name: "Choose a cover image" });
  await coverPicker.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await coverPicker.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
});

test("an existing editor cover still opens the picker from Change", async ({
  page,
}) => {
  await mountBrowserFixture(
    page,
    "/tests/browser/editor-cover-existing-fixture.svelte",
  );

  const changeCover = page.getByRole("button", { name: "Change", exact: true });
  await expect(changeCover).toHaveCSS("cursor", "pointer");
  await changeCover.click();
  const dialog = page.getByRole("dialog", { name: "Choose a cover image" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("an empty editor cover picker paints keyboard focus inside its clipped frame", async ({
  page,
}) => {
  await mountBrowserFixture(page, "/tests/browser/editor-cover-fixture.svelte");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Browser fixture has no viewport size");
  await page.mouse.move(viewport.width - 1, viewport.height - 1);
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  const picker = page.getByTestId("editor-cover-activate");
  const border = page.getByTestId("editor-cover-focus-border");
  await expect(border).toHaveCSS("opacity", "0");
  const unfocused = await picker.screenshot({ animations: "disabled" });

  await page.keyboard.press("Tab");
  await picker.focus();
  await expect(picker).toBeFocused();
  await expect(picker).toHaveCSS("box-shadow", /inset/);
  await expect(border).toHaveCSS("opacity", "1");
  const pickerBox = await picker.boundingBox();
  const borderBox = await border.boundingBox();
  expect(pickerBox).not.toBeNull();
  expect(borderBox).not.toBeNull();
  expect(borderBox!.x).toBeGreaterThan(pickerBox!.x);
  expect(borderBox!.y).toBeGreaterThan(pickerBox!.y);
  expect(borderBox!.x + borderBox!.width).toBeLessThan(
    pickerBox!.x + pickerBox!.width,
  );
  expect(borderBox!.y + borderBox!.height).toBeLessThan(
    pickerBox!.y + pickerBox!.height,
  );
  const focused = await picker.screenshot({ animations: "disabled" });
  expect(
    focused.equals(unfocused),
    "keyboard focus must change painted pixels",
  ).toBe(false);
});

test("unavailable carousel controls do not expose pointer or activate", async ({
  page,
}) => {
  await mountBrowserFixture(
    page,
    "/tests/browser/carousel-edge-fixture.svelte",
  );
  const next = page.getByTestId("carousel-next-caller-enabled-at-edge");
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(next).toHaveJSProperty("disabled", false);
  await expect(next).not.toHaveCSS("cursor", "pointer");

  await page.evaluate(() => {
    document.body.dataset.disabledCarouselActivations = "0";
    document.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-testid^='carousel-']")) {
        document.body.dataset.disabledCarouselActivations = String(
          Number(document.body.dataset.disabledCarouselActivations) + 1,
        );
      }
    });
  });

  await next.focus();
  await expect(next).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(next).toBeFocused();
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselKeyboardNext ?? 0),
    ),
  ).toBe(0);
  await page.keyboard.press("ArrowLeft");
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselKeyboardPrevious ?? 0),
    ),
  ).toBe(1);
  const bounds = await next.boundingBox();
  if (!bounds) throw new Error("Unavailable carousel control has no bounds");
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await next.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.disabledCarouselActivations),
    ),
  ).toBe(0);
});

test("carousel edge guards compose safely with caller event handlers", async ({
  page,
}) => {
  await mountBrowserFixture(
    page,
    "/tests/browser/carousel-edge-fixture.svelte",
  );
  const next = page.getByTestId("carousel-next-caller-enabled-at-edge");
  const previous = page.getByTestId(
    "carousel-previous-available-with-caller-handlers",
  );

  await next.evaluate((element) => {
    document.body.dataset.carouselBubbledClicks = "0";
    document.body.dataset.carouselBubbledKeydowns = "0";
    const carouselRegion = element.closest("main")!;
    carouselRegion.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-testid^='carousel-']")) {
        document.body.dataset.carouselBubbledClicks = String(
          Number(document.body.dataset.carouselBubbledClicks) + 1,
        );
      }
    });
    carouselRegion.addEventListener("keydown", (event) => {
      if ((event.target as HTMLElement).closest("[data-testid^='carousel-']")) {
        document.body.dataset.carouselBubbledKeydowns = String(
          Number(document.body.dataset.carouselBubbledKeydowns) + 1,
        );
      }
    });
  });

  await next.focus();
  await expect(next).toBeFocused();
  const urlBeforeBlockedClick = page.url();
  const blockedClick = await next.evaluate((element) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented };
  });
  expect(blockedClick).toEqual({ defaultPrevented: true });
  expect(page.url()).toBe(urlBeforeBlockedClick);
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.callerNextClicks ?? 0),
    ),
  ).toBe(0);
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselBubbledClicks),
    ),
  ).toBe(0);
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselScrollNext ?? 0),
    ),
  ).toBe(0);

  const blockedDirection = await next.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented };
  });
  expect(blockedDirection).toEqual({ defaultPrevented: true });
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.callerNextKeydowns ?? 0),
    ),
  ).toBe(0);
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselBubbledKeydowns),
    ),
  ).toBe(0);
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselKeyboardNext ?? 0),
    ),
  ).toBe(0);
  await expect(next).toBeFocused();

  const availableDirection = await next.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented };
  });
  expect(availableDirection).toEqual({ defaultPrevented: true });
  expect(
    await page.evaluate(() => Number(document.body.dataset.callerNextKeydowns)),
  ).toBe(1);
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselKeyboardPrevious),
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselBubbledKeydowns),
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () => document.body.dataset.carouselKeyboardHandlerSawStoppedPropagation,
    ),
  ).toBe("false");

  const availableClick = await previous.evaluate((element) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented };
  });
  expect(availableClick).toEqual({ defaultPrevented: false });
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.callerPreviousClicks),
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselScrollPrevious),
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselBubbledClicks),
    ),
  ).toBe(1);

  const callerCanceledDirection = await previous.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented };
  });
  expect(callerCanceledDirection).toEqual({ defaultPrevented: true });
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.callerPreviousKeydowns),
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselKeyboardPrevious),
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselBubbledKeydowns),
    ),
  ).toBe(1);
});

test("carousel caller disabled state composes with availability", async ({
  page,
}) => {
  await mountBrowserFixture(
    page,
    "/tests/browser/carousel-edge-fixture.svelte",
  );
  const atEdge = page.getByTestId("carousel-next-caller-enabled-at-edge");
  await expect(atEdge).toHaveJSProperty("disabled", false);
  await expect(atEdge).toHaveAttribute("aria-disabled", "true");
  await atEdge.focus();
  await expect(atEdge).toBeFocused();

  await mountBrowserFixture(
    page,
    "/tests/browser/carousel-interaction-fixture.svelte",
  );
  const callerDisabled = page.getByTestId("carousel-next-caller-disabled");
  await expect(callerDisabled).toBeDisabled();
  await expect(callerDisabled).toHaveAttribute("aria-disabled", "true");
  await expect(callerDisabled).not.toHaveCSS("cursor", "pointer");
  await callerDisabled.evaluate((element) =>
    (element as HTMLButtonElement).click(),
  );
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselActivations ?? 0),
    ),
  ).toBe(0);

  const enabled = page.getByTestId("carousel-next-enabled");
  await expect(enabled).toBeEnabled();
  await expect(enabled).toHaveAttribute("aria-disabled", "false");
  await expect(enabled).toHaveCSS("cursor", "pointer");
  await enabled.click();
  await enabled.focus();
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(() =>
      Number(document.body.dataset.carouselActivations ?? 0),
    ),
  ).toBe(2);
});

test("disabled Button links suppress callbacks and ancestor activation", async ({
  page,
}) => {
  await mountBrowserFixture(
    page,
    "/tests/browser/disabled-button-link-fixture.svelte",
  );
  const disabled = page.getByTestId("button-disabled-link");
  await expect(disabled).toHaveAttribute("aria-disabled", "true");
  await expect(disabled).not.toHaveAttribute("href");
  await expect(disabled).toHaveAttribute("tabindex", "-1");
  await expect(disabled).not.toHaveCSS("cursor", "pointer");

  await page.getByTestId("disabled-link-descendant").click();
  await disabled.evaluate((element) => (element as HTMLElement).focus());
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  expect(
    await page.evaluate(() => ({
      linkMouse: Number(document.body.dataset.disabledLinkCallbacks ?? 0),
      linkKey: Number(document.body.dataset.disabledLinkKeyCallbacks ?? 0),
      ancestor: Number(
        document.body.dataset.disabledLinkAncestorActivations ?? 0,
      ),
    })),
  ).toEqual({ linkMouse: 0, linkKey: 0, ancestor: 0 });

  const enabled = page.getByTestId("button-enabled-link");
  await expect(enabled).toHaveCSS("cursor", "pointer");
  await enabled.click();
  await enabled.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("body")).toHaveAttribute(
    "data-enabled-link-callbacks",
    "2",
  );
  await expect(page).toHaveURL(/#enabled-link$/);
});

test("search result article and tag links activate their own destinations", async ({
  page,
}) => {
  await mountBrowserFixture(
    page,
    "/tests/browser/search-result-card-fixture.svelte",
  );
  const articleLink = page.getByRole("link", {
    name: "Read article: Cursor fixture article",
  });
  const tagLink = page.getByRole("link", { name: "#cursor-tag" });
  await expect(articleLink.locator("xpath=ancestor::a")).toHaveCount(0);
  await expect(tagLink.locator("xpath=ancestor::a")).toHaveCount(0);
  await expect(articleLink).toHaveAttribute("href", "/cursor-article/");
  await expect(tagLink).toHaveAttribute("href", "/tag/cursor-tag");

  const card = articleLink.locator("xpath=../..");
  const initialBorder = await card.evaluate(
    (element) => getComputedStyle(element).borderTopColor,
  );
  await tagLink.hover();
  await expect
    .poll(() =>
      card.evaluate((element) => getComputedStyle(element).borderTopColor),
    )
    .toBe(initialBorder);
  await articleLink.hover();
  await expect
    .poll(() =>
      card.evaluate((element) => getComputedStyle(element).borderTopColor),
    )
    .not.toBe(initialBorder);

  await page.route("**/tag/cursor-tag", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "tag" }),
  );
  await tagLink.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/tag\/cursor-tag$/);

  await mountBrowserFixture(
    page,
    "/tests/browser/search-result-card-fixture.svelte",
  );
  await page.route("**/cursor-article/", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "article" }),
  );
  const article = page.getByRole("link", {
    name: "Read article: Cursor fixture article",
  });
  const expectedArticleUrl = new URL(
    (await article.getAttribute("href"))!,
    page.url(),
  );
  await article.click();
  await expect
    .poll(() => {
      const current = new URL(page.url());
      current.pathname = current.pathname.replace(/\/+$/, "");
      return current.href;
    })
    .toBe(
      `${expectedArticleUrl.origin}${expectedArticleUrl.pathname.replace(
        /\/+$/,
        "",
      )}${expectedArticleUrl.search}${expectedArticleUrl.hash}`,
    );
});

test("active creator filter accessible name is localized in Spanish", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("free2z-locale", "es");
  });
  await mountBrowserFixture(
    page,
    "/tests/browser/localized-filter-fixture.svelte",
  );
  await expect(
    page.getByRole("button", { name: "Eliminar filtro: Nuevo" }),
  ).toBeVisible();
});

test("carousel availability follows real resize reinitialization", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mountBrowserFixture(
    page,
    "/tests/browser/carousel-resize-fixture.svelte",
  );
  const next = page.getByTestId("resize-next");
  const previous = page.getByTestId("resize-previous");
  await expect(next).toBeDisabled();
  await expect(previous).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(previous).toBeEnabled();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(next).toBeDisabled();
  await expect(previous).toBeDisabled();
});
