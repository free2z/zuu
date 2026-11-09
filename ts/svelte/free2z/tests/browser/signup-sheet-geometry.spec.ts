import { expect, test, type Locator, type Page } from "@playwright/test";

// The signup sheet's keyboard inset follows MobileConverseComposer:
// bottom lifts by innerHeight - visualViewport.height - offsetTop, and the
// sheet height is the visual viewport minus 16px. Playwright does not open
// the OS keyboard, so the fake visualViewport test drives that path. The
// phone cases below cover the no-keyboard clip in the issue screenshots
// (an 80vh drawer, no inner scroll, submit past the bottom of the screen).

const PHONES = [
  { width: 360, height: 700 },
  { width: 360, height: 825 },
] as const;
const DESKTOPS = [
  { width: 1280, height: 640 },
  { width: 1280, height: 900 },
] as const;
const TOLERANCE = 2;

function fullyInside(
  box: { x: number; y: number; width: number; height: number },
  bounds: { left: number; top: number; right: number; bottom: number },
) {
  return (
    box.width > 0 &&
    box.height > 0 &&
    box.x >= bounds.left - TOLERANCE &&
    box.y >= bounds.top - TOLERANCE &&
    box.x + box.width <= bounds.right + TOLERANCE &&
    box.y + box.height <= bounds.bottom + TOLERANCE
  );
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} has no box`);
  return box;
}

async function assertInsideViewport(
  locator: Locator,
  page: Page,
  label: string,
) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("viewport is unset");
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        if (!box) return false;
        return fullyInside(box, {
          left: 0,
          top: 0,
          right: viewport.width,
          bottom: viewport.height,
        });
      },
      { message: label },
    )
    .toBe(true);
}

test.describe("signup sheet keeps the submit button on screen", () => {
  test.describe.configure({ timeout: 120_000 });

  for (const viewport of PHONES) {
    test(`phone ${viewport.width}×${viewport.height} shows the signup button and focused fields`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/login?view=signup");
      const sheet = page.getByTestId("auth-sheet");
      const scroll = page.getByTestId("auth-sheet-scroll");
      const username = sheet.locator("#signup-username");
      const password = sheet.locator("#signup-password");
      const email = sheet.locator("#email");
      const submit = sheet.locator('form button[type="submit"]');

      await expect(username).toBeVisible();
      // No keyboard: the drawer must not carry an inline viewport size.
      // Writing one on visualViewport scroll restarts vaul's slide.
      await expect
        .poll(() =>
          sheet.evaluate((el: HTMLElement) => ({
            bottom: el.style.bottom,
            height: el.style.height,
            maxHeight: el.style.maxHeight,
          })),
        )
        .toEqual({ bottom: "", height: "", maxHeight: "" });
      await expect(scroll).toHaveAttribute("data-vaul-no-drag", "");
      await expect(scroll).toHaveCSS("touch-action", "pan-y");
      await expect(scroll).toHaveCSS("overflow-y", "auto");
      await assertInsideViewport(submit, page, "signup submit");

      await password.focus();
      await assertInsideViewport(password, page, "focused password");
      await assertInsideViewport(submit, page, "submit after password focus");
      await password.fill("Correct-password-123!");
      await expect(password).toHaveValue("Correct-password-123!");

      await email.focus();
      await assertInsideViewport(email, page, "focused email");
      await assertInsideViewport(submit, page, "submit after email focus");
      await email.fill("signup@example.test");
      await expect(email).toHaveValue("signup@example.test");
      await username.fill("fixtureowner");
      await expect(username).toHaveValue("fixtureowner");
    });
  }

  for (const viewport of DESKTOPS) {
    test(`desktop ${viewport.width}×${viewport.height} keeps the signup button inside the window`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/login?view=signup");
      const sheet = page.getByTestId("auth-sheet");
      const username = sheet.locator("#signup-username");
      const submit = sheet.locator('form button[type="submit"]');
      await expect(username).toBeVisible();
      await assertInsideViewport(submit, page, "desktop signup submit");
      await username.fill("fixtureowner");
      await expect(username).toHaveValue("fixtureowner");
    });
  }

  test("visualViewport inset lifts the sheet the way the composer does", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 700 });
    await page.addInitScript(() => {
      const viewport = new EventTarget();
      Object.defineProperties(viewport, {
        height: {
          get: () =>
            (window as unknown as { __keyboardHeight?: number })
              .__keyboardHeight ?? window.innerHeight,
        },
        offsetTop: {
          get: () =>
            (window as unknown as { __keyboardOffset?: number })
              .__keyboardOffset ?? 0,
        },
      });
      Object.defineProperty(window, "visualViewport", { get: () => viewport });
      (
        window as unknown as { __keyboardViewport: EventTarget }
      ).__keyboardViewport = viewport;
    });
    await page.goto("/login?view=signup");
    const sheet = page.getByTestId("auth-sheet");
    const submit = sheet.locator('form button[type="submit"]');
    await expect(sheet.locator("#signup-username")).toBeVisible();

    const showKeyboard = async (height: number, offsetTop: number) => {
      await page.evaluate(
        ({ height: nextHeight, offsetTop: nextOffset }) => {
          const host = window as unknown as {
            __keyboardHeight: number;
            __keyboardOffset: number;
            __keyboardViewport: EventTarget;
          };
          host.__keyboardHeight = nextHeight;
          host.__keyboardOffset = nextOffset;
          host.__keyboardViewport.dispatchEvent(new Event("resize"));
          host.__keyboardViewport.dispatchEvent(new Event("scroll"));
        },
        { height, offsetTop },
      );
    };

    await showKeyboard(360, 0);
    await expect(sheet).toHaveAttribute("data-auth-keyboard-inset", "340");
    await expect(sheet).toHaveAttribute("data-auth-visible-height", "360");
    await expect
      .poll(async () => {
        const box = await boxOf(sheet);
        const submitBox = await boxOf(submit);
        return {
          bottom: Math.round(box.y + box.height),
          height: Math.round(box.height),
          submitInside: fullyInside(submitBox, {
            left: 0,
            top: 0,
            right: 360,
            bottom: 360,
          }),
        };
      })
      .toEqual({ bottom: 360, height: 344, submitInside: true });

    const password = sheet.locator("#signup-password");
    await password.focus();
    await showKeyboard(360, 30);
    await expect(sheet).toHaveAttribute("data-auth-keyboard-inset", "310");
    const visual = { left: 0, top: 30, right: 360, bottom: 390 };
    await expect
      .poll(async () => {
        const box = await boxOf(sheet);
        return Math.round(box.y + box.height);
      })
      .toBe(390);
    await expect
      .poll(async () => fullyInside(await boxOf(password), visual))
      .toBe(true);
    await expect
      .poll(async () => fullyInside(await boxOf(submit), visual))
      .toBe(true);
    await password.fill("Correct-password-123!");
    await expect(password).toHaveValue("Correct-password-123!");

    await showKeyboard(700, 0);
    await expect
      .poll(() =>
        sheet.evaluate((el: HTMLElement) => ({
          bottom: el.style.bottom,
          height: el.style.height,
          maxHeight: el.style.maxHeight,
        })),
      )
      .toEqual({ bottom: "", height: "", maxHeight: "" });
  });
});
