import { expect, test, type Page } from "@playwright/test";

import { SONNER_LOADER } from "./dev-source-module";

const DOCK_HEIGHTS = [0, 96] as const;
const VIEWPORTS = [
  { name: "mobile", width: 390, height: 700, toastGap: 16 },
  // Sonner changes from mobileOffset to offset above 600px.
  { name: "desktop offset", width: 640, height: 700, toastGap: 24 },
  { name: "short landscape", width: 640, height: 320, toastGap: 24 },
] as const;
const GEOMETRY_TOLERANCE = 1;

async function triggerToast(page: Page) {
  // The local Sonner facade is a reliable hydration marker for this layout.
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) =>
        entry.name.endsWith("/src/lib/components/ui/sonner/index.ts"),
      ),
  );
  await page.evaluate(async (loader) => {
    // The loader waits for Vite's dev-time define globals before importing a
    // source module -- see tests/browser/dev-source-module.ts.
    const { toast } = await new Function(loader)();
    toast.success("Dock regression toast", { duration: 60_000 });
  }, SONNER_LOADER);

  const toast = page.locator("[data-sonner-toast]").first();
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Dock regression toast");
  return toast;
}

for (const viewport of VIEWPORTS) {
  for (const dockHeight of DOCK_HEIGHTS) {
    test(`${viewport.name} toast clears a ${dockHeight}px bottom dock`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const clientAuthCheck = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/auth/user/" &&
          response.request().resourceType() === "fetch",
      );
      await page.route("**/api/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (!pathname.startsWith("/api/")) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: pathname === "/api/auth/user/" ? 401 : 200,
          contentType: "application/json",
          body: JSON.stringify({ count: 0, results: [] }),
        });
      });
      await page.goto("/toaster-fixture-user/toaster-fixture");
      // The auth check starts from the root layout's client effect, after the
      // component tree (including Toaster and PageActions) has hydrated.
      await clientAuthCheck;

      await page.evaluate((height) => {
        document.documentElement.style.setProperty(
          "--f2z-bottom-dock-height",
          `${height}px`,
        );
        if (!height) return;

        const dock = document.createElement("div");
        dock.dataset.testid = "simulated-bottom-dock";
        Object.assign(dock.style, {
          position: "fixed",
          zIndex: "40",
          inset: "auto 0 0",
          height: `${height}px`,
          pointerEvents: "none",
        });
        document.body.append(dock);
      }, dockHeight);

      const toast = await triggerToast(page);
      const toaster = page.locator("[data-sonner-toaster]");
      const notificationRegion = toaster.locator("..");
      const actions = page.locator(".page-action-dock");
      const maxToastBottom =
        viewport.height - dockHeight - viewport.toastGap + GEOMETRY_TOLERANCE;

      // `toBeVisible` succeeds during Sonner's 400ms slide-in, while the toast
      // is still translated below its final anchor. Wait for settled geometry.
      await expect
        .poll(() =>
          toast.evaluate((element) => element.getBoundingClientRect().bottom),
        )
        .toBeLessThanOrEqual(maxToastBottom);

      const geometry = await page.evaluate(() => {
        const toastElement = document.querySelector<HTMLElement>(
          "[data-sonner-toast]",
        );
        const toasterElement = document.querySelector<HTMLElement>(
          "[data-sonner-toaster]",
        );
        const actionsElement =
          document.querySelector<HTMLElement>(".page-action-dock");
        const trigger = document.querySelector<HTMLElement>(
          ".page-action-trigger",
        );
        if (!toastElement || !toasterElement || !actionsElement || !trigger) {
          throw new Error("Expected toast and page action geometry");
        }

        const toastRect = toastElement.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        const topmostAtTrigger = document
          .elementFromPoint(
            triggerRect.left + triggerRect.width / 2,
            triggerRect.top + triggerRect.height / 2,
          )
          ?.closest(".page-action-trigger");

        return {
          viewportHeight: window.innerHeight,
          toastBottom: toastRect.bottom,
          toastTop: toastRect.top,
          toastLayer: getComputedStyle(toasterElement).zIndex,
          actionsBottom: actionsElement.getBoundingClientRect().bottom,
          actionsLayer: getComputedStyle(actionsElement).zIndex,
          actionsOwnTheirHitTarget: topmostAtTrigger === trigger,
          toastOverlapsTrigger:
            toastRect.left < triggerRect.right &&
            toastRect.right > triggerRect.left &&
            toastRect.top < triggerRect.bottom &&
            toastRect.bottom > triggerRect.top,
        };
      });

      // The visible toast and persistent actions both clear the measured dock.
      const dockTop = geometry.viewportHeight - dockHeight;
      expect(geometry.toastBottom).toBeLessThanOrEqual(maxToastBottom);
      expect(geometry.toastTop).toBeGreaterThanOrEqual(0);
      expect(geometry.actionsBottom).toBeLessThanOrEqual(
        dockTop + GEOMETRY_TOLERANCE,
      );

      // A transient toast must never steal the persistent action hit target.
      expect(geometry.toastLayer).toBe("60");
      expect(geometry.actionsLayer).toBe("70");
      expect(geometry.actionsOwnTheirHitTarget).toBe(true);
      if (viewport.name === "mobile") {
        expect(geometry.toastOverlapsTrigger).toBe(true);
      }

      await expect(toast).toBeVisible();
      await expect(notificationRegion).toHaveAttribute("aria-live", "polite");
      await expect(actions).toHaveAttribute("aria-label", "Page actions");

      await page.evaluate(() => {
        const spoof = document.createElement("div");
        spoof.dataset.slot = "article-overlay";
        spoof.dataset.state = "open";
        document.querySelector("article")?.append(spoof);
      });
      await expect(actions).toHaveCSS("z-index", "70");

      // The Share menu is portaled out of the z-70 rail. It must remain above
      // both the rail and toast when collision handling flips it upward.
      // Dispatch directly so Playwright's synthetic mouse movement cannot fire
      // the rail's pointer-leave auto-close between these two interactions.
      await actions
        .locator(".page-action-trigger")
        .evaluate((element: HTMLElement) => element.click());
      await expect(actions.locator(".page-action-tree")).toHaveClass(/is-open/);
      const chromeClearance = await page.evaluate(() => {
        const navbar = document.querySelector<HTMLElement>("nav.sticky");
        const actions =
          document.querySelector<HTMLElement>(".page-action-dock");
        if (!navbar || !actions) throw new Error("Expected navbar and actions");
        return {
          navbarBottom: navbar.getBoundingClientRect().bottom,
          actionsTop: actions.getBoundingClientRect().top,
        };
      });
      expect(chromeClearance.actionsTop).toBeGreaterThanOrEqual(
        chromeClearance.navbarBottom,
      );
      await page
        .getByRole("button", { name: "Share this page", exact: true })
        .click();
      const shareMenu = page.locator('[data-slot="dropdown-menu-content"]');
      await expect(shareMenu).toBeVisible();
      expect(
        await shareMenu.evaluate((element) => getComputedStyle(element).zIndex),
      ).toBe("80");
      const shareItems = shareMenu.getByRole("menuitem");
      for (const item of [shareItems.first(), shareItems.last()]) {
        await item.scrollIntoViewIfNeeded();
        const ownsHitTarget = await item.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return (
            document
              .elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              )
              ?.closest('[role="menuitem"]') === element
          );
        });
        expect(ownsHitTarget).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(shareMenu).toBeHidden();

      // Opening any z-50 modal reverses the page-chrome ordering: the overlay
      // covers/blocks its underlying actions, while the payment/error toast
      // remains visible and topmost above the modal.
      await page.evaluate(() => {
        const overlay = document.createElement("div");
        overlay.dataset.slot = "dialog-overlay";
        overlay.dataset.state = "open";
        Object.assign(overlay.style, {
          position: "fixed",
          zIndex: "50",
          inset: "0",
        });
        document.body.append(overlay);
      });
      await expect
        .poll(() =>
          actions.evaluate((element) => getComputedStyle(element).zIndex),
        )
        .toBe("40");

      // Retry the hit-test probe for a bounded window. The toast has
      // already settled (geometry poll above), so this is not waiting on
      // Sonner's slide-in: the one reported failure was a local run from
      // before per-worktree Playwright ports, and it has not been
      // reproduced since. Both conditions must hold in the SAME sample, and a
      // persistent layering regression (e.g. the overlay raised above z-60)
      // still fails at the timeout. It does not prove the toast was topmost
      // for the whole window -- only that it ends up there.
      await expect(async () => {
        const modalLayers = await page.evaluate(() => {
          const toastElement = document.querySelector<HTMLElement>(
            "[data-sonner-toast]",
          );
          const trigger = document.querySelector<HTMLElement>(
            ".page-action-trigger",
          );
          if (!toastElement || !trigger) {
            throw new Error("Expected modal-state toast/action geometry");
          }
          const toastRect = toastElement.getBoundingClientRect();
          const triggerRect = trigger.getBoundingClientRect();
          const topmostAtTrigger = document.elementFromPoint(
            triggerRect.left + triggerRect.width / 2,
            triggerRect.top + triggerRect.height / 2,
          );
          return {
            toastIsTopmost: Boolean(
              document
                .elementFromPoint(
                  toastRect.left + toastRect.width / 2,
                  toastRect.top + toastRect.height / 2,
                )
                ?.closest("[data-sonner-toast]"),
            ),
            actionsAreUnavailable: !topmostAtTrigger?.closest(
              ".page-action-trigger",
            ),
          };
        });
        expect(modalLayers.toastIsTopmost).toBe(true);
        expect(modalLayers.actionsAreUnavailable).toBe(true);
      }).toPass({ timeout: 5_000, intervals: [100, 250, 500, 1_000] });
      await page
        .locator('[data-slot="dialog-overlay"]')
        .evaluate((element) => element.remove());
      await expect(actions).toHaveCSS("z-index", "70");
    });
  }
}
