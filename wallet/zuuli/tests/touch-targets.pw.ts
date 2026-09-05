import { expect, test, type Page } from "@playwright/test";

const TOUCH_WIDTHS = [320, 360] as const;
const ROUTES = [
  // #904 phase 4: the content routes (search, creator, profile, kyc, ai, live,
  // articles) no longer exist in this app, so this matrix is the vault's own
  // surface plus the NotFound the router now serves for everything else.
  "/",
  "/about",
  "/wallet",
  "/wallet/send",
  "/wallet/receive",
  "/wallet/history",
  "/wallet/fund",
  "/buy",
  "/does-not-exist",
  "/login",
] as const;

type TouchAudit = {
  failures: string[];
  exemptions: string[];
  targets: number;
};

async function setSession(page: Page, signedIn: boolean) {
  await page.addInitScript((authenticated) => {
    const key = "zuuli.knox.token";
    if (authenticated) localStorage.setItem(key, "mock-knox-token");
    else localStorage.removeItem(key);
  }, signedIn);
}

async function auditTouchTargets(page: Page): Promise<TouchAudit> {
  return page.evaluate(() => {
    const selector = [
      "a[href]",
      "button",
      "input:not([type='hidden'])",
      "textarea",
      "select",
      "summary",
      "[role='button']",
      "[role='link']",
      "[role='tab']",
    ].join(",");
    const minimum = 44;
    const tolerance = 0.5;
    const failures: string[] = [];
    const exemptions: string[] = [];

    function label(element: HTMLElement): string {
      const text = (
        element.getAttribute("aria-label") ??
        element.innerText ??
        element.getAttribute("placeholder") ??
        element.getAttribute("title") ??
        element.textContent ??
        ""
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 70);
      return `${element.tagName.toLowerCase()}${text ? ` “${text}”` : ""}`;
    }

    function accessibleName(element: HTMLElement): string {
      const labelledBy = element.getAttribute("aria-labelledby");
      const labelledText = labelledBy
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const controlLabels =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? [...element.labels].map((item) => item.textContent ?? "").join(" ")
          : "";
      return (
        [
          element.getAttribute("aria-label"),
          labelledText,
          controlLabels,
          element.innerText,
          element.getAttribute("title"),
        ].find((candidate) => candidate?.trim()) ?? ""
      ).trim();
    }

    function isRendered(element: HTMLElement): boolean {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        !element.closest("[hidden], [inert], [aria-hidden='true']") &&
        !element.classList.contains("sr-only")
      );
    }

    function effectiveRect(element: HTMLElement): DOMRect {
      if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
        const wrappingLabel = element.closest("label");
        const explicitLabel = element.id
          ? document.querySelector<HTMLLabelElement>(`label[for=${CSS.escape(element.id)}]`)
          : null;
        return (wrappingLabel ?? explicitLabel)?.getBoundingClientRect() ?? element.getBoundingClientRect();
      }
      return element.getBoundingClientRect();
    }

    const targets = [...document.querySelectorAll<HTMLElement>(selector)].filter(
      (element, index, all) => all.indexOf(element) === index && isRendered(element),
    );
    const auditedTargets: Array<{ element: HTMLElement; rect: DOMRect }> = [];

    for (const element of targets) {
      if (!accessibleName(element)) {
        failures.push(`${label(element)} has no accessible name`);
      }

      const exemption = element.dataset.touchTargetExempt;
      if (exemption) {
        const style = getComputedStyle(element);
        const validInlineText =
          exemption === "inline-text" &&
          element.tagName === "A" &&
          style.display === "inline" &&
          element.closest(".zuuli-markdown") !== null &&
          element.textContent?.trim() !== "" &&
          element.querySelector("img, svg, video, audio") === null;
        if (!validInlineText) {
          failures.push(`${label(element)} has invalid touch-target exemption “${exemption}”`);
        } else {
          exemptions.push(label(element));
        }
        continue;
      }

      // The contract measures the real layout box. ZUULI deliberately does
      // not use pseudo-elements to expand hit areas beyond those boxes.
      const rect = effectiveRect(element);
      auditedTargets.push({ element, rect });
      if (rect.width < minimum - tolerance || rect.height < minimum - tolerance) {
        failures.push(
          `${label(element)} is ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}px`,
        );
      }
    }

    for (let index = 0; index < auditedTargets.length; index += 1) {
      const first = auditedTargets[index];
      for (let otherIndex = index + 1; otherIndex < auditedTargets.length; otherIndex += 1) {
        const second = auditedTargets[otherIndex];
        if (
          !first.element.classList.contains("min-tap") ||
          !second.element.classList.contains("min-tap") ||
          first.element.parentElement !== second.element.parentElement ||
          first.element.contains(second.element) ||
          second.element.contains(first.element) ||
          [first.element, second.element].some((element) =>
            ["absolute", "fixed"].includes(getComputedStyle(element).position),
          )
        ) {
          // This assertion targets adjacent controls whose actual box was
          // expanded by `min-tap`. Nested controls and absolutely positioned
          // controls such as an input's clear button are deliberate compound
          // widgets rather than adjacent siblings.
          continue;
        }
        const overlapWidth =
          Math.min(first.rect.right, second.rect.right) -
          Math.max(first.rect.left, second.rect.left);
        const overlapHeight =
          Math.min(first.rect.bottom, second.rect.bottom) -
          Math.max(first.rect.top, second.rect.top);
        if (overlapWidth > tolerance && overlapHeight > tolerance) {
          failures.push(
            `${label(first.element)} overlaps ${label(second.element)} by ${overlapWidth.toFixed(1)}×${overlapHeight.toFixed(1)}px`,
          );
        }
      }
    }

    return {
      failures: [...new Set(failures)].slice(0, 50),
      exemptions: [...new Set(exemptions)],
      targets: targets.length,
    };
  });
}

for (const signedIn of [false, true]) {
  for (const width of TOUCH_WIDTHS) {
    test(`${signedIn ? "signed in" : "signed out"} touch targets fit at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 760 });
      await setSession(page, signedIn);
      const routeFailures: string[] = [];

      for (const route of ROUTES) {
        await page.goto(route);
        await page.locator("[data-app-frame]").waitFor();
        await page.waitForTimeout(500);

        const audit = await auditTouchTargets(page);
        expect(audit.targets, `${route} must expose audited controls`).toBeGreaterThan(0);
        routeFailures.push(...audit.failures.map((failure) => `${route}: ${failure}`));
      }

      await page.goto("/wallet/fund");
      for (const tab of ["Send & Tip", "Activity"]) {
        await page.getByRole("tab", { name: tab }).click();
        routeFailures.push(
          ...(await auditTouchTargets(page)).failures.map(
            (failure) =>
              `/wallet/fund?tab=${tab.toLowerCase().replaceAll(" ", "-")}: ${failure}`,
          ),
        );
      }

      // The article and creator/page search fields were this file's two
      // long-text-with-trailing-control subjects; both left with their routes
      // in #904 phase 4. Wallet Send's recipient field is the one that
      // remains, and it is the one that matters most: a clipped address is a
      // payment to the wrong place.
      await page.goto("/wallet/send");
      await page
        .getByLabel("Recipient address")
        .fill(
          "u1mockzookoq7wl9a8k4x0m5n6p7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2g3h4j5k6",
        );
      routeFailures.push(
        ...(await auditTouchTargets(page)).failures.map(
          (failure) => `/wallet/send?recipient=long: ${failure}`,
        ),
      );

      if (signedIn) {
        await page.goto("/");
        await page.getByRole("button", { name: "Account menu" }).click();
        routeFailures.push(
          ...(await auditTouchTargets(page)).failures.map(
            (failure) => `/?menu=account: ${failure}`,
          ),
        );
      }

      await page.goto("/");
      await page.getByRole("button", { name: "More navigation" }).click();
      routeFailures.push(
        ...(await auditTouchTargets(page)).failures.map(
          (failure) => `/?menu=more: ${failure}`,
        ),
      );
      await page.keyboard.press("Escape");

      await page.goto("/login");
      await page.getByRole("button", { name: "Zcash", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Zcash" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
      routeFailures.push(
        ...(await auditTouchTargets(page)).failures.map(
          (failure) => `/login?method=zcash: ${failure}`,
        ),
      );
      expect(routeFailures, "mobile routes have undersized touch targets").toEqual([]);
    });
  }
}
