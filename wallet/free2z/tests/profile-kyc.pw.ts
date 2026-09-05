/**
 * The two account surfaces ported out of ZUULI, asserted against the running
 * app.
 *
 * ZUULI has no `profile.pw.ts` or `kyc.pw.ts`. What it has instead is five
 * cross-cutting specs that each carry a slice of these two routes' contract,
 * and this file ports those slices rather than the whole harnesses (which would
 * drag in ZUULI's wallet routes):
 *
 *   * `viewport.pw.ts` / `touch-targets.pw.ts` list `/profile` and `/kyc` in
 *     their route tables — no horizontal overflow, and every interactive target
 *     at least 44px with an accessible name, at 320px and 360px.
 *   * `scroll-restoration.pw.ts` deep-links `/profile#profile-p2paddr` and
 *     asserts the fresh load starts at the top rather than jumping to the hash.
 *   * `social-providers.pw.ts` signs in, opens `/profile`, and asserts the
 *     "Linked identities" card renders exactly the configured providers.
 *   * `navigation.pw.ts` opens `/kyc` and asserts the "Revenue share" heading.
 *
 * The last test is new, because the behaviour is new: `LinkedAccounts` here
 * cannot run ZUULI's challenge → sign → verify stepper, and the omission has to
 * be visible rather than silent.
 */
import { expect, test, type Page } from "@playwright/test";

const PHONES = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
] as const;

const ACCOUNT_ROUTES = ["/profile", "/kyc"] as const;

async function setSession(page: Page, signedIn: boolean) {
  await page.addInitScript((authenticated) => {
    const key = "zuuli.knox.token";
    if (authenticated) localStorage.setItem(key, "mock-knox-token");
    else localStorage.removeItem(key);
  }, signedIn);
}

async function setSocialProviders(page: Page, scenario: "all-off" | "x") {
  await page.addInitScript((next) => {
    sessionStorage.setItem("zuuli.mock.social-providers", next);
  }, scenario);
}

async function expectNoHorizontalOverflow(page: Page, route: string) {
  const metrics = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(metrics.scroll, `${route} must not scroll sideways`).toBeLessThanOrEqual(
    metrics.client,
  );
}

/**
 * The touch contract `touch-targets.pw.ts` applies to every route in its table,
 * reduced to the two properties that fail on real bugs: a rendered interactive
 * element is at least 44×44 and has an accessible name. Measured on the real
 * layout box — this app expands no hit area with pseudo-elements either.
 */
async function auditTouchTargets(page: Page): Promise<string[]> {
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

    function label(element: HTMLElement): string {
      const text = (element.getAttribute("aria-label") ?? element.innerText ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 70);
      return `${element.tagName.toLowerCase()}${text ? ` "${text}"` : ""}`;
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
          element.getAttribute("placeholder"),
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

    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (!isRendered(element)) continue;
      if (!accessibleName(element)) {
        failures.push(`${label(element)} has no accessible name`);
      }
      const rect = element.getBoundingClientRect();
      if (rect.width < minimum - tolerance || rect.height < minimum - tolerance) {
        failures.push(
          `${label(element)} is ${rect.width.toFixed(1)}x${rect.height.toFixed(1)}px`,
        );
      }
    }
    return failures;
  });
}

for (const phone of PHONES) {
  test(`the account routes fit and stay tappable at ${phone.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(phone);
    await setSession(page, true);

    for (const route of ACCOUNT_ROUTES) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page, route);
      expect(await auditTouchTargets(page), `${route} touch targets`).toEqual([]);
    }
  });
}

test("both account routes gate on a session rather than 404ing", async ({
  page,
}) => {
  await setSession(page, false);

  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Edit profile" })).toBeVisible();
  await expect(page.getByText("Log in to edit your profile")).toBeVisible();
  await expect(page.getByText("Page not found")).toHaveCount(0);

  await page.goto("/kyc");
  await expect(page.getByRole("heading", { name: "Revenue share" })).toBeVisible();
  await expect(page.getByText("Log in to apply")).toBeVisible();
  await expect(page.getByText("Page not found")).toHaveCount(0);
});

test("a fresh deep link with a hash starts the profile at the top", async ({
  page,
}) => {
  await page.setViewportSize(PHONES[0]);
  await setSession(page, true);
  await page.goto("/profile#profile-p2paddr");

  await expect(page.getByRole("heading", { name: "Edit profile" })).toBeVisible();
  const offset = () => page.evaluate(() => window.scrollY);
  expect(await offset()).toBe(0);
  await page.waitForTimeout(500);
  expect(await offset()).toBe(0);
});

test("the profile form edits the fields the API accepts", async ({ page }) => {
  await setSession(page, true);
  await page.goto("/profile");

  await expect(page.getByLabel("Username")).toBeDisabled();
  const displayName = page.getByLabel("Display name");
  await displayName.fill("Skylar of free2z");
  // The sticky preview card mirrors the field as you type.
  await expect(page.getByText("Skylar of free2z")).toBeVisible();

  // The 2Z membership price is validated in the browser before it is sent.
  const memberPrice = page.getByLabel("Membership price (2Z / 30 days)");
  await memberPrice.fill("999999999");
  await expect(page.getByText(/Max 999,999 2Z per membership\./)).toBeVisible();
  await memberPrice.fill("3000");
  await expect(page.getByText(/Max 999,999 2Z per membership\./)).toHaveCount(0);

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Profile updated")).toBeVisible();
});

test("the revenue-share application opens on its first step", async ({
  page,
}) => {
  await setSession(page, true);
  await page.goto("/kyc");

  await expect(page.getByRole("heading", { name: "Revenue share" })).toBeVisible();
  await expect(page.getByText("Basic information")).toBeVisible();
  await expect(page.getByText("Are you a US taxpayer?")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeVisible();
});

test("the profile links to the revenue-share application, not to a wallet", async ({
  page,
}) => {
  await setSession(page, true);
  await page.goto("/profile");

  await page
    .getByRole("link", { name: "Apply for revenue share" })
    .click();
  await expect(page).toHaveURL(/\/kyc$/);

  await expect(page.locator("a[href^='/wallet']")).toHaveCount(0);
});

test("linked identities state the Zcash omission instead of offering it", async ({
  page,
}) => {
  await setSession(page, true);
  await setSocialProviders(page, "x");
  await page.goto("/profile");

  await expect(
    page.getByRole("heading", { name: "Linked identities" }),
  ).toBeVisible();

  // ZUULI renders a "Link Zcash key" button that opens the signing stepper.
  // Nothing in this process can sign, so the button is absent and the reason
  // is on screen — the same shape as the login page's Zcash callout.
  await expect(page.getByRole("button", { name: "Link Zcash key" })).toHaveCount(0);
  const pending = page.locator("[data-profile-zcash-link-pending]");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("Linking a Zcash key happens in ZUULI");

  // Social linking is an OAuth round trip and does ship here.
  const linkX = page.getByRole("button", { name: "Link X" });
  await expect(linkX).toBeVisible();
  await expect(page.getByRole("button", { name: "Link Google" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Link GitHub" })).toHaveCount(0);
});
