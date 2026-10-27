import { expect, test, type Page } from "@playwright/test";

import { devSourceModuleLoader } from "./dev-source-module";
import { decodePng } from "./png-pixels.mjs";

// zPage -> zPage client navigation must never show the page being left
//. `[username]/[vanity]/+page.svelte` is REUSED when only the params
// change, so without an explicit loading state the old page stays on screen
// for the whole load, and after it an `<img>` whose `src` changes keeps
// painting its previous bitmap until the new one has arrived: the wrong cover
// and the wrong creator's face next to the new title.
//
// The fixtures (tests/browser/mock-api.mjs) give page A a pure-red cover and
// avatar and page B pure-blue ones, so a screenshot says whose pixels are on
// screen. Checking `img.src` would not: the stale bitmap belongs to an element
// whose `src` already names the new page.

// A cold vite dev server compiles this route on first request (~50s measured
// locally for the first `goto`).
test.describe.configure({ timeout: 120_000 });

const PAGE_A = "/hero-user/hero-nav-a-fixture";
const PAGE_B = "/hero-user/hero-nav-b-fixture";
const PAYMENT_PAGE_A = "/hero-user/hero-payment-a-fixture";
const PAYMENT_PAGE_B = "/hero-user/hero-payment-b-fixture";
const TITLE_A = "Navigation origin fixture";
const TITLE_B = "Navigation target fixture";
const AUTH_SESSION = "billing-fixture-session";
const DRAFT_CONTENT = "A real authenticated draft that must come back.";
// Enough to be unmistakable (a 40px avatar alone is ~1250 pixels), low enough
// that a partly painted image still counts.
const VISIBLE_PIXELS = 50;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function colourCounts(page: Page) {
  const image = decodePng(await page.screenshot());
  let red = 0;
  let blue = 0;
  for (let offset = 0; offset < image.data.length; offset += image.channels) {
    const r = image.data[offset];
    const g = image.data[offset + 1];
    const b = image.data[offset + 2];
    if (r > 170 && g < 90 && b < 90) red += 1;
    if (b > 170 && r < 90 && g < 90) blue += 1;
  }
  return { red, blue };
}

/** Screenshot the viewport several times over a window of real time. */
async function sample(page: Page, times = 5) {
  const samples: Array<{ red: number; blue: number }> = [];
  for (let index = 0; index < times; index += 1) {
    samples.push(await colourCounts(page));
    await page.waitForTimeout(120);
  }
  return samples;
}

/**
 * Slow the page's main thread down. SvelteKit defers a link
 * navigation past the next frame, so how long the frame after a click stays
 * on screen depends on how busy the renderer is — a fast machine hid the bug
 * and a loaded CI runner showed it. Throttling makes the slow case the normal
 * one; the first-frame probe below makes the verdict independent of it.
 */
async function throttleCpu(page: Page, rate: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await cdp.detach();
}

type FrameState = {
  skeleton: boolean;
  plate: string | null;
  avatar: string | null;
  headings: string[];
};

/**
 * Record what the FIRST frame after the next `eventType` event shows.
 *
 * The listener is a capture listener on `window`, so it runs before any other
 * handler of that event, and its `requestAnimationFrame` callback runs at the
 * start of the very next rendering step, before SvelteKit's own deferred
 * navigation has even begun. Whatever it finds visible there is what the
 * reader saw one frame after the click (or Back). This samples the frame; it
 * does not wait for the skeleton to appear, which would hide exactly the
 * delay  is about.
 *
 * `plate` and `avatar` are the fill colour of the VISIBLE hero and avatar
 * image (null when none is visible), read off the fixture URL.
 */
async function recordFirstFrameAfter(page: Page, eventType: string) {
  await page.evaluate((type) => {
    const probe = window as unknown as { __f2zFirstFrame?: unknown };
    probe.__f2zFirstFrame = undefined;
    window.addEventListener(
      type,
      () => {
        requestAnimationFrame(() => {
          const visibleFill = (selector: string) => {
            const image = Array.from(
              document.querySelectorAll<HTMLImageElement>(selector),
            ).find((node) => node.checkVisibility());
            if (!image) return null;
            return new URL(image.src).searchParams.get("fill");
          };
          probe.__f2zFirstFrame = {
            skeleton: Boolean(
              document
                .querySelector('[data-testid="zpage-loading"]')
                ?.checkVisibility(),
            ),
            plate: visibleFill(".hero-media__img"),
            avatar: visibleFill('a[rel="author"] img'),
            headings: Array.from(document.querySelectorAll("h1"))
              .filter((node) => node.checkVisibility())
              .map((node) => node.textContent?.trim() ?? ""),
          };
        });
      },
      { capture: true, once: true },
    );
  }, eventType);
  return async () => {
    const handle = await page.waitForFunction(
      () =>
        (window as unknown as { __f2zFirstFrame?: unknown }).__f2zFirstFrame,
    );
    return (await handle.jsonValue()) as FrameState;
  };
}

/** Count every skeleton ever inserted into the document from now on. */
async function countSkeletonInsertions(page: Page) {
  await page.evaluate(() => {
    const probe = window as unknown as { __f2zSkeletons?: number };
    probe.__f2zSkeletons = 0;
    const skeleton = '[data-testid="zpage-loading"]';
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (
            node instanceof Element &&
            (node.matches(skeleton) || node.querySelector(skeleton))
          ) {
            probe.__f2zSkeletons = (probe.__f2zSkeletons ?? 0) + 1;
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { __f2zSkeletons?: number }).__f2zSkeletons,
    );
}

/** Let several frames and timer turns go by. */
async function severalFrames(page: Page) {
  await page.evaluate(async () => {
    for (let frame = 0; frame < 10; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function gotoHydrated(page: Page, path: string) {
  await page.goto(path);
  // `scrollScene` stamps this on mount: the page is hydrated and its client
  // router owns link clicks.
  await expect(page.locator("main[data-scroll-scene]")).toHaveCount(1, {
    timeout: 30_000,
  });
}

async function imagesPainted(page: Page) {
  return page.evaluate(() => {
    const plate = document.querySelector<HTMLImageElement>(".hero-media__img");
    const avatar = document.querySelector<HTMLImageElement>(
      'a[rel="author"] img',
    );
    return Boolean(
      plate?.complete &&
      plate.naturalWidth > 0 &&
      avatar?.complete &&
      avatar.naturalWidth > 0,
    );
  });
}

/** Hold every request for page B's data and page B's images until opened. */
async function holdPageData(page: Page, path: string) {
  const data = gate();
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.route(
    new RegExp(`${escapedPath}/__data\\.json`),
    async (route) => {
      await data.opened;
      await route.continue();
    },
  );
  return { data };
}

/** Hold every request for page B's data and page B's images until opened. */
async function holdPageB(page: Page, path = PAGE_B) {
  const held = await holdPageData(page, path);
  const images = gate();
  await page.route(/\/fixture-hero\.svg\?.*fill=%230000ff/, async (route) => {
    await images.opened;
    await route.continue();
  });
  return { ...held, images };
}

test("zPage -> zPage navigation never shows the previous page's cover or avatar", async ({
  page,
}) => {
  const held = await holdPageB(page);

  await gotoHydrated(page, PAGE_A);
  await expect.poll(() => imagesPainted(page)).toBe(true);
  // Positive control for the pixel probe: A's pixels ARE detectable.
  expect((await colourCounts(page)).red).toBeGreaterThan(VISIBLE_PIXELS);

  await throttleCpu(page, 6);
  const firstFrame = await recordFirstFrameAfter(page, "click");
  await page.getByRole("link", { name: "Go to the navigation target" }).click();
  // Straight away, before anything else goes back and forth to the page.
  const atClick = await colourCounts(page);

  // Phase 1 — B's data has not arrived. Nothing of A may remain, starting
  // with the very first frame after the click.
  expect(await firstFrame(), "the first frame after the click").toEqual({
    skeleton: true,
    plate: null,
    avatar: null,
    headings: [],
  });
  expect(
    atClick.red,
    "page A's cover/avatar right after the click",
  ).toBeLessThan(VISIBLE_PIXELS);
  // The link sits below the hero; look at the top of the page, where the old
  // cover and avatar would be.
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const counts of await sample(page)) {
    expect(counts.red, "page A's cover/avatar during the load").toBeLessThan(
      VISIBLE_PIXELS,
    );
  }
  await throttleCpu(page, 1);
  await expect(page.getByTestId("zpage-loading")).toBeVisible();
  // Hidden (display: none, so out of the accessibility tree too), not
  // necessarily removed: see the comment-form test below.
  await expect(page.getByRole("heading", { name: TITLE_A })).toHaveCount(0);
  await expect(page.getByText("hero-body-sentinel")).toBeHidden();
  // A slow, ordinary client navigation must retain the loading state beyond
  // the full-page fallback grace period; no unload signal was observed.
  await page.waitForTimeout(3100);
  await expect(page.getByTestId("zpage-loading")).toBeVisible();
  await expect(page).toHaveTitle("Loading story…");

  // Phase 2 — B's data is in, its images are still on the wire. Neither A's
  // pixels nor (obviously) B's may be painted; the layout is B's.
  held.data.open();
  await expect(page).toHaveURL(new RegExp(`${PAGE_B}$`));
  await expect(page.getByRole("heading", { name: TITLE_B })).toBeVisible();
  await expect(page.getByTestId("zpage-loading")).toHaveCount(0);
  for (const counts of await sample(page)) {
    expect(
      counts.red,
      "page A's cover/avatar while page B's images load",
    ).toBeLessThan(VISIBLE_PIXELS);
    expect(counts.blue).toBeLessThan(VISIBLE_PIXELS);
  }
  // A fresh hero starts from the SSR default fit, not A's measurement.
  await expect(page.locator(".hero-media")).toHaveAttribute(
    "data-hero-fit",
    "contain",
  );
  await expect(page.locator(".hero-media")).toHaveAttribute("data-loading", "");

  // Phase 3 — B's images arrive and are shown.
  held.images.open();
  await expect.poll(() => imagesPainted(page)).toBe(true);
  await expect
    .poll(async () => (await colourCounts(page)).blue)
    .toBeGreaterThan(VISIBLE_PIXELS);
  expect((await colourCounts(page)).red).toBeLessThan(VISIBLE_PIXELS);
  await expect(page.locator(".hero-media")).not.toHaveAttribute(
    "data-loading",
    /.*/,
  );

  // Back to A (a popstate navigation), with A's data held this time: B's
  // pixels must go just as promptly.
  const backData = gate();
  await page.route(/\/hero-nav-a-fixture\/__data\.json/, async (route) => {
    await backData.opened;
    await route.continue();
  });
  const firstFrameBack = await recordFirstFrameAfter(page, "popstate");
  await page.goBack();
  // A popstate navigation is not deferred the way a link click is.
  expect(await firstFrameBack(), "the first frame after Back").toEqual({
    skeleton: true,
    plate: null,
    avatar: null,
    headings: [],
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByTestId("zpage-loading")).toBeVisible();
  for (const counts of await sample(page, 3)) {
    expect(
      counts.blue,
      "page B's cover/avatar during the back load",
    ).toBeLessThan(VISIBLE_PIXELS);
  }
  backData.open();
  await expect(page.getByRole("heading", { name: TITLE_A })).toBeVisible();
  await expect
    .poll(async () => (await colourCounts(page)).red)
    .toBeGreaterThan(VISIBLE_PIXELS);
});

test("a navigation that supersedes the zPage load does not bring the old page back", async ({
  page,
}) => {
  const held = await holdPageB(page);
  const home = gate();
  await page.route(
    (url) => url.pathname === "/__data.json",
    async (route) => {
      await home.opened;
      await route.continue();
    },
  );

  await gotoHydrated(page, PAGE_A);
  await expect.poll(() => imagesPainted(page)).toBe(true);
  await page.getByRole("link", { name: "Go to the navigation target" }).click();
  await expect(page.getByTestId("zpage-loading")).toBeVisible();

  // B is still loading; the reader gives up and goes Home.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByTestId("navbar-brand").click();
  for (const counts of await sample(page)) {
    expect(counts.red, "page A while Home loads").toBeLessThan(VISIBLE_PIXELS);
  }
  await expect(page.getByRole("heading", { name: TITLE_A })).toHaveCount(0);
  await expect(page.getByTestId("zpage-loading")).toBeVisible();
  await page.waitForTimeout(3100);
  await expect(page.getByTestId("zpage-loading")).toBeVisible();
  await expect(page).toHaveTitle("Loading story…");

  home.open();
  held.data.open();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("zpage-loading")).toHaveCount(0);
});

test("the comment form and the page actions survive a zPage -> zPage navigation", async ({
  page,
}) => {
  // Both can own an in-flight paid request (a 2Z comment, a boost). Their
  // instances have always been reused across a zPage change; the loading
  // state must hide them, never unmount them — a fresh comment form would
  // restore the draft of a comment that is already being paid for.
  await page.context().addCookies([
    {
      name: "sessionid",
      value: AUTH_SESSION,
      domain: "127.0.0.1",
      path: "/",
    },
    {
      name: "csrftoken",
      value: "billing-fixture-csrf",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.addInitScript((content) => {
    sessionStorage.setItem(
      "f2z:comment-draft:fixtureowner:zpage:hero-nav-a-fixture",
      JSON.stringify({ headline: "", content, tuzis: 3 }),
    );
  }, DRAFT_CONTENT);

  const held = await holdPageB(page);
  held.images.open();

  await gotoHydrated(page, PAGE_A);
  const link = page.getByRole("link", {
    name: "Continue to the navigation target",
  });
  await link.scrollIntoViewIfNeeded();
  const commentForm = page.locator("#comment-content");
  await expect(commentForm).toBeVisible();
  await expect(commentForm).toHaveValue(DRAFT_CONTENT);
  const actions = page.locator('aside[aria-label="Page actions"]');
  await expect(actions).toHaveCount(1);
  await commentForm.evaluate((node) =>
    node.setAttribute("data-nav-probe", "comment-form"),
  );
  await actions.evaluate((node) =>
    node.setAttribute("data-nav-probe", "page-actions"),
  );

  await link.click();
  await expect(page.getByTestId("zpage-loading")).toBeVisible();
  await expect(commentForm).toBeHidden();
  await expect(actions).toBeHidden();

  held.data.open();
  await expect(page.getByRole("heading", { name: TITLE_B })).toBeVisible();
  await expect(page.locator('[data-nav-probe="comment-form"]')).toHaveCount(1);
  await expect(page.locator('[data-nav-probe="page-actions"]')).toBeVisible();

  // The real form swaps to B's own draft key, then restores A's draft when the
  // reader returns. Check the retained component probes again so a fresh mount
  // that happens to restore sessionStorage cannot satisfy this test.
  await expect(page.locator("#comment-content")).toHaveValue("");
  await page.goBack();
  await expect(page.getByRole("heading", { name: TITLE_A })).toBeVisible();
  await expect(page.locator('[data-nav-probe="comment-form"]')).toHaveCount(1);
  await expect(page.locator('[data-nav-probe="page-actions"]')).toBeVisible();
  await expect(page.locator("#comment-content")).toHaveValue(DRAFT_CONTENT);
});

async function preparePaymentNavigation(page: Page) {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: AUTH_SESSION,
      domain: "127.0.0.1",
      path: "/",
    },
    {
      name: "csrftoken",
      value: "billing-fixture-csrf",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const held = await holdPageB(page, PAYMENT_PAGE_B);
  held.images.open();
  await gotoHydrated(page, PAYMENT_PAGE_A);
  return held;
}

async function openActions(page: Page) {
  const actionTrigger = page.locator(".page-action-trigger");
  await page.waitForLoadState("networkidle");
  await page.mouse.move(0, 0);
  await actionTrigger.press("Enter");
  await expect(actionTrigger).toHaveAttribute("aria-expanded", "true");
}

async function playFixtureAudio(page: Page) {
  const audio = page.locator("audio");
  await expect(audio).toHaveCount(1, { timeout: 30_000 });
  await audio.evaluate(async (element) => {
    const media = element as HTMLAudioElement;
    const sampleRate = 8_000;
    const dataBytes = (sampleRate / 10) * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);
    const write = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1) {
        view.setUint8(offset + index, value.charCodeAt(index));
      }
    };
    write(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    write(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    view.setUint32(40, dataBytes, true);
    media.src = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
    media.loop = true;
    await media.play();
  });
  await expect
    .poll(() =>
      audio.evaluate((element) => (element as HTMLAudioElement).paused),
    )
    .toBe(false);
  return audio;
}

async function navigateWithOpenPaymentDialog(
  page: Page,
  held: { data: ReturnType<typeof gate> },
  dialogButton: string,
) {
  await openActions(page);
  await page.getByRole("button", { name: dialogButton, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The open modal covers the page link. Put a real navigable anchor in the
  // dialog itself so Playwright's normal hit-tested click reaches an actual
  // link while the dialog remains open. A forced click on the covered page
  // link targets the overlay in a browser and never exercises the router.
  const targetHref = await page
    .getByRole("link", { name: "Continue to the navigation target" })
    .getAttribute("href");
  expect(targetHref).toBeTruthy();
  await dialog.evaluate((node, href) => {
    const link = document.createElement("a");
    link.href = href as string;
    link.textContent = "Navigate from payment dialog";
    link.dataset.testid = "payment-dialog-navigation-link";
    node.append(link);
  }, targetHref);
  await dialog.getByTestId("payment-dialog-navigation-link").click();
  await expect(page.getByTestId("zpage-loading")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  held.data.open();
  await expect(
    page.getByRole("heading", { name: "Payment navigation target fixture" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/**
 * Mount a compiled Svelte `onclick` that prevents its link's default inside
 * the real payment dialog portal, outside the hydrated app's event root, so
 * Svelte handles it at its document fallback AFTER SvelteKit's router.
 */
async function mountDelegatedPortalLink(page: Page) {
  await preparePaymentNavigation(page);
  const audio = await playFixtureAudio(page);

  await openActions(page);
  await page.getByRole("button", { name: "Support", exact: true }).click();
  const paymentDialog = page.getByRole("dialog", { name: /Support hero-user/ });
  await expect(paymentDialog).toBeVisible();
  const titleBefore = await page.title();
  const href = await page
    .getByRole("link", { name: "Continue to the navigation target" })
    .getAttribute("href");
  expect(href).toBeTruthy();
  let paymentRouteRequestSeen = false;
  page.on("request", (request) => {
    if (request.url().includes("hero-payment-b-fixture/__data.json")) {
      paymentRouteRequestSeen = true;
    }
  });
  await paymentDialog.evaluate(
    async (portal, { loader, href }) => {
      const { mountPreventedPortalLink } = await new Function(loader)();
      const eventRoot = document.body.firstElementChild;
      if (!eventRoot) throw new Error("SvelteKit app event root is missing");
      // Put the real payment dialog portal outside the hydrated app root so
      // Svelte must use its document fallback for this delegated handler.
      document.documentElement.append(portal);
      mountPreventedPortalLink(eventRoot, portal, href);
      const state = window as unknown as {
        __portalEventOrdering?: {
          bodyPrevented?: boolean;
          documentPrevented?: boolean;
        };
      };
      state.__portalEventOrdering = {};
      const isPortalClick = (event: Event) =>
        event
          .composedPath()
          .some(
            (node) =>
              node instanceof HTMLAnchorElement &&
              node.textContent?.trim() === "Cancel delegated portal navigation",
          );
      document.body.addEventListener("click", (event) => {
        if (isPortalClick(event) && state.__portalEventOrdering) {
          state.__portalEventOrdering.bodyPrevented = event.defaultPrevented;
        }
      });
      document.addEventListener("click", (event) => {
        if (isPortalClick(event) && state.__portalEventOrdering) {
          state.__portalEventOrdering.documentPrevented =
            event.defaultPrevented;
        }
      });
    },
    {
      loader: devSourceModuleLoader(
        "/tests/browser/portal-delegate-fixture.ts",
      ),
      href,
    },
  );
  return {
    audio,
    paymentDialog,
    titleBefore,
    routeRequested: () => paymentRouteRequestSeen,
  };
}

test("a portal delegated preventDefault leaves payment, audio, and title in place", async ({
  page,
}) => {
  const { audio, paymentDialog, titleBefore, routeRequested } =
    await mountDelegatedPortalLink(page);
  const firstFrame = await recordFirstFrameAfter(page, "click");

  await page
    .getByRole("link", { name: "Cancel delegated portal navigation" })
    .evaluate((link: HTMLAnchorElement) => link.click());

  await expect(
    page.getByRole("link", { name: "Cancel delegated portal navigation" }),
  ).toHaveAttribute("data-portal-click-prevented", "true");
  expect(await firstFrame()).toMatchObject({ skeleton: false });
  await expect(page.getByTestId("zpage-loading")).toHaveCount(0);
  await expect(paymentDialog).toBeVisible();
  await expect(page).toHaveTitle(titleBefore);
  await expect
    .poll(() =>
      audio.evaluate((element) => (element as HTMLAudioElement).paused),
    )
    .toBe(false);
  await expect(page).toHaveURL(new RegExp(`${PAYMENT_PAGE_A}$`));
  expect(routeRequested()).toBe(false);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __portalEventOrdering?: {
              bodyPrevented?: boolean;
              documentPrevented?: boolean;
            };
          }
        ).__portalEventOrdering,
    ),
  ).toEqual({ documentPrevented: true });
});

test("a later click does not release a portal delegated cancellation", async ({
  page,
}) => {
  // The cancellation belongs to the click that was prevented, not to
  // whichever click came last: SvelteKit starts the routed navigation a frame
  // after the click, and an unrelated click in that frame must not let it out.
  const { paymentDialog, routeRequested } =
    await mountDelegatedPortalLink(page);

  await page
    .getByRole("link", { name: "Cancel delegated portal navigation" })
    .evaluate((link: HTMLAnchorElement) => {
      link.click();
      document.body.click();
    });

  await expect(
    page.getByRole("link", { name: "Cancel delegated portal navigation" }),
  ).toHaveAttribute("data-portal-click-prevented", "true");
  await severalFrames(page);
  await page.waitForTimeout(500);
  await expect(page.getByTestId("zpage-loading")).toHaveCount(0);
  await expect(paymentDialog).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${PAYMENT_PAGE_A}$`));
  expect(routeRequested()).toBe(false);
});

test("Support dialog closes during held zPage navigation", async ({ page }) => {
  const held = await preparePaymentNavigation(page);
  await navigateWithOpenPaymentDialog(page, held, "Support");
});

test("Subscribe dialog closes during held zPage navigation", async ({
  page,
}) => {
  const held = await preparePaymentNavigation(page);
  await navigateWithOpenPaymentDialog(page, held, "Subscribe");
});

test("a donation settling after navigation cannot populate the next page's dialog", async ({
  page,
}) => {
  const held = await preparePaymentNavigation(page);
  const donationResponse = gate();
  let requestSeen!: () => void;
  const donationRequest = new Promise<void>((resolve) => {
    requestSeen = resolve;
  });
  await page.route(
    "**/api/tuzis/donate-idempotent/hero-user",
    async (route) => {
      requestSeen();
      await donationResponse.opened;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ replayed: false }),
      });
    },
  );

  await openActions(page);
  await page.getByRole("button", { name: "Support", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Share 5 2Z", exact: true }).click();
  await donationRequest;

  // Close the modal before following the link. This keeps the click a real
  // browser navigation while the payment request remains in flight; the
  // existing dialog-navigation test covers the overlay interception path.
  // Wait for normal actionability while modal focus and scroll are restored;
  // forcing the click can use a position the moving link has already left.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("link", { name: "Continue to the navigation target" })
    .click();
  await expect(page.getByTestId("zpage-loading")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  held.data.open();
  await expect(
    page.getByRole("heading", { name: "Payment navigation target fixture" }),
  ).toBeVisible();
  donationResponse.open();
  await expect(
    page.getByText(/Shared 5 2Z usage credits with hero-user/),
  ).toBeVisible();

  await openActions(page);
  await page.getByRole("button", { name: "Support", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Usage credits sent" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Share 5 2Z", exact: true }),
  ).toBeVisible();
});

test("a subscription settling after navigation cannot subscribe the next page", async ({
  page,
}) => {
  const held = await preparePaymentNavigation(page);
  const subscriptionResponse = gate();
  let requestSeen!: () => void;
  const subscriptionRequest = new Promise<void>((resolve) => {
    requestSeen = resolve;
  });
  await page.route(
    "**/api/tuzis/subscribe-confirmed/hero-user",
    async (route) => {
      requestSeen();
      await subscriptionResponse.opened;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ replayed: false }),
      });
    },
  );

  await openActions(page);
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm Subscription", exact: true })
    .click();
  await subscriptionRequest;

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("link", { name: "Continue to the navigation target" })
    .click();
  await expect(page.getByTestId("zpage-loading")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  held.data.open();
  await expect(
    page.getByRole("heading", { name: "Payment navigation target fixture" }),
  ).toBeVisible();
  subscriptionResponse.open();
  await expect(page.getByText(/Subscribed to hero-user/)).toBeVisible();

  await openActions(page);
  await expect(
    page.getByRole("button", { name: "Subscribe", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Manage subscription", exact: true }),
  ).toHaveCount(0);
});

test("zPage navigation pauses audio and resets progress metadata", async ({
  page,
}) => {
  const held = await preparePaymentNavigation(page);
  const audio = await playFixtureAudio(page);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect
    .poll(() =>
      page
        .locator(".reading-progress")
        .evaluate((element) => element.style.transform),
    )
    .not.toBe("scaleX(0)");

  await page
    .getByRole("link", {
      name: "Continue to the navigation target",
    })
    .click();
  await expect(page.getByTestId("zpage-loading")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() =>
      audio.evaluate((element) => (element as HTMLAudioElement).paused),
    )
    .toBe(true);
  await expect(page).toHaveTitle("Loading story…");
  await expect
    .poll(() =>
      page
        .locator(".reading-progress")
        .evaluate((element) => element.classList.contains("invisible")),
    )
    .toBe(true);
  await expect(page.locator(".reading-progress")).toHaveAttribute(
    "aria-hidden",
    "true",
  );

  held.data.open();
  await expect(
    page.getByRole("heading", { name: "Payment navigation target fixture" }),
  ).toBeVisible();
});

test("Back returns the reader to where they left the previous zPage", async ({
  page,
}) => {
  // SvelteKit records the outgoing scroll position only AFTER the new page's
  // load has resolved. A loading state that shortens the document in the
  // meantime makes the browser clamp scrollY, and that clamped value is what
  // Back restores.
  const held = await holdPageB(page);
  held.images.open();

  await gotoHydrated(page, PAGE_A);
  const link = page.getByRole("link", {
    name: "Continue to the navigation target",
  });
  await link.scrollIntoViewIfNeeded();
  const leftAt = await page.evaluate(() => window.scrollY);
  // Far enough down that a skeleton-height document could not hold it.
  expect(leftAt).toBeGreaterThan(2000);

  await link.click();
  const skeleton = page.getByTestId("zpage-loading");
  await expect(skeleton).toBeVisible();
  // The loading state is where the reader is looking, not a screen above it.
  await expect(skeleton.getByTestId("zpage-loading-avatar")).toBeInViewport();
  for (const counts of await sample(page, 3)) {
    expect(counts.red).toBeLessThan(VISIBLE_PIXELS);
  }
  expect(await page.evaluate(() => window.scrollY)).toBe(leftAt);

  held.data.open();
  await expect(page.getByRole("heading", { name: TITLE_B })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.goBack();
  await expect(page.getByRole("heading", { name: TITLE_A })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(leftAt - 2);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(leftAt + 2);
});

test("a full load and a same-zPage navigation neither re-mount the hero nor show the skeleton", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const probe = { heroRemovals: 0, skeletons: 0 };
    (window as any).__f2zNavProbe = probe;
    const hero = '.hero-media__img, a[rel="author"] img';
    const skeleton = '[data-testid="zpage-loading"]';
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.removedNodes)) {
          if (
            node instanceof Element &&
            (node.matches(hero) || node.querySelector(hero))
          ) {
            probe.heroRemovals += 1;
          }
        }
        for (const node of Array.from(record.addedNodes)) {
          if (
            node instanceof Element &&
            (node.matches(skeleton) || node.querySelector(skeleton))
          ) {
            probe.skeletons += 1;
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });

  await gotoHydrated(page, PAGE_B);
  await expect.poll(() => imagesPainted(page)).toBe(true);
  const probe = () => page.evaluate(() => (window as any).__f2zNavProbe);
  expect(await probe()).toEqual({ heroRemovals: 0, skeletons: 0 });

  // Tag the live elements: a re-mount would replace them.
  await page.evaluate(() => {
    document
      .querySelector(".hero-media__img")
      ?.setAttribute("data-nav-probe", "hero");
    document
      .querySelector('a[rel="author"] img')
      ?.setAttribute("data-nav-probe", "avatar");
  });

  // Same zPage, different URL: the load re-runs and `data` is a new object.
  const reloaded = page.waitForResponse((response) =>
    response.url().includes("/hero-nav-b-fixture/__data.json"),
  );
  await page
    .getByRole("link", { name: "Reload this navigation target" })
    .click();
  await reloaded;
  await expect(page).toHaveURL(/\?lang=en$/);
  await expect(page.getByRole("heading", { name: TITLE_B })).toBeVisible();

  await expect(page.locator('[data-nav-probe="hero"]')).toHaveCount(1);
  await expect(page.locator('[data-nav-probe="avatar"]')).toHaveCount(1);
  expect(await probe()).toEqual({ heroRemovals: 0, skeletons: 0 });
});

// The loading state is entered INSIDE the click, on a prediction that
// SvelteKit is about to route it. A prediction can be wrong; none of
// the ways it can be wrong may leave the page covered.

const CANCEL_FIXTURE_LOADER = devSourceModuleLoader(
  "/tests/browser/zpage-nav-cancel-fixture.ts",
);

async function expectPageAStillShown(page: Page) {
  await expect(page).toHaveURL(new RegExp(`${PAGE_A}$`));
  await expect(page.getByTestId("zpage-loading")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: TITLE_A })).toBeVisible();
  expect((await colourCounts(page)).red).toBeGreaterThan(VISIBLE_PIXELS);
}

test("a zPage link navigation cancelled in beforeNavigate brings the page back", async ({
  page,
}) => {
  const held = await holdPageB(page);
  held.data.open();
  held.images.open();
  const dataRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/hero-nav-b-fixture/__data.json")) {
      dataRequests.push(request.url());
    }
  });

  await gotoHydrated(page, PAGE_A);
  await expect.poll(() => imagesPainted(page)).toBe(true);
  await page.evaluate(async (loader) => {
    const { install } = await new Function(loader)();
    install();
  }, CANCEL_FIXTURE_LOADER);

  await throttleCpu(page, 6);
  await page.getByRole("link", { name: "Go to the navigation target" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __f2zCancelledNavigations?: number })
            .__f2zCancelledNavigations,
      ),
    )
    .toBe(1);
  await severalFrames(page);
  await throttleCpu(page, 1);
  await expectPageAStillShown(page);
  // Stays that way: nothing is waiting to put the skeleton back.
  const skeletons = await countSkeletonInsertions(page);
  await severalFrames(page);
  expect(await skeletons()).toBe(0);
  await expectPageAStillShown(page);
  // Cancelled before any load: only a hover/tap PRELOAD may have asked for B.
  expect(dataRequests.length).toBeLessThanOrEqual(1);
});

test("a zPage link click another handler takes never shows the skeleton", async ({
  page,
}) => {
  await gotoHydrated(page, PAGE_A);
  await expect.poll(() => imagesPainted(page)).toBe(true);
  // A handler on the link itself claims the click (a confirm dialog, a
  // modal); SvelteKit then leaves it alone, and so must the page.
  await page
    .getByRole("link", { name: "Go to the navigation target" })
    .evaluate((link) =>
      link.addEventListener("click", (event) => event.preventDefault()),
    );
  const skeletons = await countSkeletonInsertions(page);
  const firstFrame = await recordFirstFrameAfter(page, "click");

  await throttleCpu(page, 6);
  await page.getByRole("link", { name: "Go to the navigation target" }).click();
  expect(await firstFrame()).toMatchObject({
    skeleton: false,
    plate: "#ff0000",
    avatar: "#ff0000",
    headings: [TITLE_A],
  });
  await severalFrames(page);
  await throttleCpu(page, 1);
  expect(await skeletons()).toBe(0);
  await expectPageAStillShown(page);
});

test("zPage links SvelteKit does not route never show the skeleton", async ({
  page,
  context,
}) => {
  await gotoHydrated(page, PAGE_A);
  await expect.poll(() => imagesPainted(page)).toBe(true);
  await page.evaluate((href) => {
    const links = document.createElement("p");
    links.id = "unrouted-links";
    for (const [label, attributes] of [
      ["new tab", { target: "_blank" }],
      ["download", { download: "" }],
      ["hash", {}],
    ] as const) {
      const link = document.createElement("a");
      link.textContent = `Unrouted ${label}`;
      link.href = label === "hash" ? "#unrouted-links" : href;
      for (const [name, value] of Object.entries(attributes)) {
        link.setAttribute(name, value);
      }
      links.append(link, " ");
    }
    // At the top, so no click has to scroll.
    document.querySelector("main")?.prepend(links);
  }, PAGE_B);
  const skeletons = await countSkeletonInsertions(page);
  const clickAndSettle = async (
    name: string,
    modifiers?: Array<"ControlOrMeta">,
  ) => {
    await page.getByRole("link", { name }).click({ modifiers });
    await severalFrames(page);
  };

  const popup = context.waitForEvent("page");
  await clickAndSettle("Unrouted new tab");
  await (await popup).close();

  const download = page.waitForEvent("download");
  await clickAndSettle("Unrouted download");
  await (await download).cancel();

  const modifiedTab = context.waitForEvent("page");
  await clickAndSettle("Go to the navigation target", ["ControlOrMeta"]);
  await (await modifiedTab).close();

  await clickAndSettle("Unrouted hash");

  expect(await skeletons()).toBe(0);
  await expect(page.getByTestId("zpage-loading")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: TITLE_A })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${PAGE_A}(#unrouted-links)?$`));
  const titleBeforeDownload = await page.title();

  // Force the browser's full-load path, then make that response a download.
  // Downloads do not unload the document, so the old page must remain settled.
  await page.route("**/hero-nav-b-fixture*", async (route) => {
    const request = route.request();
    if (
      request.isNavigationRequest() &&
      request.url().includes("full-load-download")
    ) {
      await route.fulfill({
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="navigation.txt"',
          "content-type": "text/plain",
        },
        body: "download without a document unload",
      });
      return;
    }
    await route.continue();
  });
  await page.evaluate((href) => {
    const reload = document.createElement("a");
    reload.textContent = "Full-load download";
    reload.href = `${href}?full-load-download`;
    reload.setAttribute("data-sveltekit-reload", "");
    document.querySelector("#unrouted-links")?.append(reload);
  }, PAGE_B);
  const fullLoadDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Full-load download" }).click();
  await (await fullLoadDownload).cancel();
  await severalFrames(page);
  await expect(page).toHaveURL(new RegExp(`${PAGE_A}(#unrouted-links)?$`));
  await expect(page).toHaveTitle(titleBeforeDownload);
  await expect(page.getByTestId("zpage-loading")).toHaveCount(0);

  // A full-page load (`data-sveltekit-reload`) unloads the page instead; the
  // skeleton must not be put up on its way out either.
  await page.evaluate(() => {
    const reload = document.createElement("a");
    reload.textContent = "Unrouted reload";
    reload.href = "/hero-user/hero-nav-b-fixture";
    reload.setAttribute("data-sveltekit-reload", "");
    document.querySelector("#unrouted-links")?.append(reload);
    window.addEventListener("pagehide", () => {
      sessionStorage.setItem(
        "f2z-skeletons-before-unload",
        String(
          (window as unknown as { __f2zSkeletons?: number }).__f2zSkeletons,
        ),
      );
    });
  });
  await page.getByRole("link", { name: "Unrouted reload" }).click();
  await expect(page.getByRole("heading", { name: TITLE_B })).toBeVisible();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("f2z-skeletons-before-unload"),
    ),
  ).toBe("0");
});

test("an intent-backed native download settles its zPage loading latch", async ({
  page,
}) => {
  const routedData = gate();
  const nativeResponse = gate();
  let dataRequestSeen!: () => void;
  let nativeRequestSeen!: () => void;
  const dataRequest = new Promise<void>((resolve) => {
    dataRequestSeen = resolve;
  });
  const nativeRequest = new Promise<void>((resolve) => {
    nativeRequestSeen = resolve;
  });
  await page.route("**/hero-nav-b-fixture/__data.json*", async (route) => {
    dataRequestSeen();
    await routedData.opened;
    await route.fulfill({ status: 500, body: "server load unavailable" });
  });
  await page.route("**/hero-nav-b-fixture", async (route) => {
    nativeRequestSeen();
    await nativeResponse.opened;
    await route.fulfill({
      status: 200,
      headers: {
        "content-disposition": 'attachment; filename="routed-download.txt"',
        "content-type": "text/plain",
      },
      body: "intent-backed native download",
    });
  });

  await gotoHydrated(page, PAGE_A);
  await expect(page).toHaveTitle(new RegExp(TITLE_A));
  await page.evaluate(() => {
    const state = window as unknown as { __navigationEvents?: string[] };
    state.__navigationEvents = [];
    window.addEventListener("beforeunload", () =>
      state.__navigationEvents?.push("beforeunload"),
    );
    window.addEventListener("pagehide", () =>
      state.__navigationEvents?.push("pagehide"),
    );
    window.addEventListener("pageshow", () =>
      state.__navigationEvents?.push("pageshow"),
    );
    const navigation = (window as unknown as { navigation?: EventTarget })
      .navigation;
    navigation?.addEventListener("navigate", () =>
      state.__navigationEvents?.push("navigate"),
    );
    navigation?.addEventListener("navigatesuccess", () =>
      state.__navigationEvents?.push("navigatesuccess"),
    );
    navigation?.addEventListener("navigateerror", () =>
      state.__navigationEvents?.push("navigateerror"),
    );
  });

  await page
    .getByRole("link", { name: "Go to the navigation target" })
    .click({ noWaitAfter: true });
  await dataRequest;
  await expect(page.getByTestId("zpage-loading")).toBeVisible();
  await expect(page).toHaveTitle("Loading story…");
  const download = page.waitForEvent("download");
  routedData.open();
  await nativeRequest;
  // Do not let a held normal document response produce a download.
  expect(
    await Promise.race([
      download.then(() => "downloaded"),
      page.waitForTimeout(1500).then(() => "still-pending"),
    ]),
  ).toBe("still-pending");
  nativeResponse.open();
  await (await download).cancel();
  // The old document gets no positive response-settled notification for an
  // attachment. The implementation waits three seconds after beforeunload,
  // then applies its bounded same-document fallback heuristic.
  await page.waitForTimeout(1600);
  await severalFrames(page);

  await expect(page).toHaveURL(new RegExp(`${PAGE_A}$`));
  await expect(page.getByTestId("zpage-loading")).toHaveCount(0);
  await expect(page).toHaveTitle(new RegExp(TITLE_A));
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __navigationEvents?: string[] })
          .__navigationEvents,
    ),
  ).toContain("beforeunload");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __navigationEvents?: string[] })
          .__navigationEvents,
    ),
  ).not.toContain("pagehide");
});
