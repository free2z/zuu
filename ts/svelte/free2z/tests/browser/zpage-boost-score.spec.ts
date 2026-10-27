import { expect, test, type Page, type Route } from "@playwright/test";
import { browserMockApiOrigin } from "./ports";

const MOCK_API_ORIGIN = browserMockApiOrigin();
const BOOST_A = "/boost-author/boost-a";

type BoostResponse = {
  status: number;
  body: unknown;
  delayMs?: number;
  heldUntil?: Promise<void>;
};

async function installBoostApi(page: Page) {
  let fundCalls = 0;
  let completedCalls = 0;
  const responses: BoostResponse[] = [];

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/auth/user/") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: 861,
          username: "boost-tester",
          full_name: "Boost Tester",
          tuzis: "1000",
        }),
      });
      return;
    }

    if (pathname === "/api/zpage/fund/" && request.method() === "POST") {
      fundCalls += 1;
      const payload = request.postDataJSON();
      expect(payload).toMatchObject({ amount: 2 });
      expect(payload.id).toMatch(/^00000000-0000-4000-8000-00000000086[12]$/);

      const response = responses.shift();
      if (!response) throw new Error("Unexpected boost request");
      if (response.heldUntil) await response.heldUntil;
      if (response.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, response.delayMs));
      }
      completedCalls += 1;
      // Production returns the boosted f2z_score as a bare decimal STRING
      // ("17.50000000"), same shape as every other f2z_score serialization.
      // Mirror the server-side write into the mock API's fixture so a
      // subsequent SSR load/refetch observes the boosted score.
      if (response.status === 200 && typeof response.body === "string") {
        const writeBack = await fetch(
          `${MOCK_API_ORIGIN}/__boost-score` +
            `?vanity=${encodeURIComponent(payload.id)}` +
            `&score=${encodeURIComponent(response.body)}`,
          { method: "POST" },
        );
        expect(writeBack.ok).toBe(true);
      }
      await route.fulfill({
        status: response.status,
        contentType: "application/json",
        body: JSON.stringify(response.body),
      });
      return;
    }

    await route.continue();
  });

  return {
    respondWith(response: BoostResponse) {
      responses.push(response);
    },
    get fundCalls() {
      return fundCalls;
    },
    get completedCalls() {
      return completedCalls;
    },
  };
}

async function openActions(page: Page) {
  const trigger = page.locator(".page-action-trigger");
  // The SSR button exists before the Svelte handler is hydrated; network idle
  // follows the root layout's client-side auth check and makes activation real.
  await page.waitForLoadState("networkidle");
  // Do not let a no-request outcome pass as boost safety: first prove that
  // the mocked session was accepted by the real auth store for this owner.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        let state: any;
        (await import(module)).authStore.subscribe((value: any) => {
          state = value;
        })();
        return {
          status: state.status,
          username: state.creator?.username ?? null,
        };
      }),
    )
    .toEqual({ status: "authenticated", username: "boost-tester" });
  // A page fixture can render under the mouse position left by an earlier
  // interaction, firing the rail's desktop hover-open handler during setup.
  await page.mouse.move(0, 0);
  // Wait for that pointer-leave close to settle before deciding whether to
  // open it; reading too early can see the transient hover-open state.
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  // Use the keyboard activation path so Playwright does not hover the trigger
  // first; a mouse click would open on pointerenter and then toggle it closed.
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

test.beforeEach(async ({ page, request }) => {
  for (const [vanity, score] of [
    ["boost-a", "0.00000000"],
    ["boost-b", "3.00000000"],
  ]) {
    const reset = await request.post(
      `${MOCK_API_ORIGIN}/__boost-score?vanity=${vanity}&score=${score}`,
    );
    expect(reset.ok()).toBe(true);
  }

  await page.context().addCookies([
    {
      name: "sessionid",
      value: "boost-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
});

test("boost reconciles every score surface and stays consistent on failure", async ({
  page,
}) => {
  const api = await installBoostApi(page);
  await page.goto(BOOST_A);
  await expect(
    page.getByRole("heading", { name: "Boost fixture A" }),
  ).toBeVisible();
  await openActions(page);

  const boost = page.getByTestId("boost-score").locator("xpath=..");
  // Every score surface renders through the compact formatter: the fixture
  // ships "0.00000000" and both surfaces must read "0", not the raw string.
  await expect(page.getByTestId("boost-score")).toHaveText("0");
  await expect(page.getByTestId("zpage-hero-score")).toHaveText("0 score");
  await expect(page.getByTestId("score-announcement")).toBeEmpty();
  await expect(page.getByTestId("boost-score")).not.toHaveAttribute(
    "aria-live",
  );

  api.respondWith({
    status: 200,
    // Exactly what production sends after a boost: a decimal STRING. Above
    // the compact-notation boundary (>= 1000) on purpose: this is the case
    // where storing display text instead of raw decimals breaks surfaces.
    body: "1234.50000000",
    delayMs: 250,
  });
  // Dispatch twice in one task: the synchronous submitting guard permits one
  // request only.
  await boost.evaluate((element: HTMLElement) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect.poll(() => api.fundCalls).toBe(1);
  // The score is weighted server-side, so do not invent a +1 while the
  // money-moving request is still in flight.
  await expect(page.getByTestId("boost-score")).toHaveText("0");
  await expect(page.getByTestId("boost-score")).toHaveText("1.2K");
  await expect(page.getByTestId("zpage-hero-score")).toHaveText("1.2K score");
  await expect(page.getByTestId("score-announcement")).toHaveText(
    "Score updated to 1.2K",
  );
  await expect(
    page.getByText("Thanks for the boost!", { exact: true }),
  ).toHaveCount(1);
  await expect(boost).toBeEnabled();

  api.respondWith({
    status: 400,
    body: { detail: "Insufficient funds" },
  });
  await boost.click();
  await expect(
    page
      .getByTestId("payment-outcome-error")
      .getByText("Insufficient funds", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("boost-score")).toHaveText("1.2K");
  await expect(page.getByTestId("zpage-hero-score")).toHaveText("1.2K score");
  await expect(page.getByTestId("score-announcement")).toBeEmpty();
  expect(api.fundCalls).toBe(2);

  // Reload coherence: the fund write-back updated the mock API's fixture, so
  // a fresh SSR load must show the boosted score on every surface — not just
  // the client-side state that the optimistic update touched.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Boost fixture A" }),
  ).toBeVisible();
  await openActions(page);
  await expect(page.getByTestId("boost-score")).toHaveText("1.2K");
  await expect(page.getByTestId("zpage-hero-score")).toHaveText("1.2K score");
});

test("a late boost response cannot leak across zPage navigation", async ({
  page,
}) => {
  const api = await installBoostApi(page);
  await page.goto(BOOST_A);
  await expect(
    page.getByRole("heading", { name: "Boost fixture A" }),
  ).toBeVisible();
  await openActions(page);

  api.respondWith({
    status: 200,
    body: "99.00000000",
    delayMs: 250,
  });
  await page.getByTestId("boost-score").locator("xpath=..").click();
  await expect.poll(() => api.fundCalls).toBe(1);

  await page.getByRole("link", { name: /Next part.*Boost fixture B/s }).click();
  await expect(
    page.getByRole("heading", { name: "Boost fixture B" }),
  ).toBeVisible();
  await openActions(page);
  await expect(page.getByTestId("boost-score")).toHaveText("3");
  await expect(page.getByTestId("zpage-hero-score")).toHaveText("3 score");
  await expect(page.getByTestId("score-announcement")).toBeEmpty();

  await expect.poll(() => api.completedCalls).toBe(1);
  await expect(page.getByTestId("boost-score")).toHaveText("3");
  await expect(page.getByTestId("zpage-hero-score")).toHaveText("3 score");
});

for (const refusal of ["uncertain", "funds"] as const) {
  test(`collapsed actual boost rail retains ${refusal} guidance under full congestion and clears it across actors`, async ({
    page,
  }) => {
    const api = await installBoostApi(page);
    await page.goto(BOOST_A);
    await expect(
      page.getByRole("heading", { name: "Boost fixture A" }),
    ).toBeVisible();
    await openActions(page);
    await page.evaluate(async () => {
      const module = "/src/lib/toast.ts";
      const { toast } = await import(module);
      for (let index = 0; index < 52; index++)
        toast.error(`Unrelated failure ${index}`);
    });
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(2);
    const failure =
      refusal === "funds"
        ? {
            status: 402,
            body: {
              code: "insufficient_funds",
              cost: "2",
              balance: "1",
              shortfall: "1",
              action: "page_fund",
            },
          }
        : {
            status: 500,
            body: {
              detail: "Private boost outcome uncertain. Check before retrying.",
            },
          };
    api.respondWith(failure);
    await page.getByRole("button", { name: "Boost this page with 2Z" }).click();
    await expect.poll(() => api.completedCalls).toBe(1);
    await page.mouse.move(0, 0);
    await expect(page.locator(".page-action-trigger")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    const fallback = page.getByTestId("boost-payment-outcome");
    await expect(fallback).toBeVisible();
    if (refusal === "funds")
      await expect(fallback.getByTestId("insufficient-funds")).toBeVisible();
    else
      await expect(fallback.getByTestId("payment-outcome-error")).toHaveText(
        "Private boost outcome uncertain. Check before retrying.",
      );
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Private boost outcome" }),
    ).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(2);
    await fallback
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect(fallback).toHaveCount(0);

    await openActions(page);
    let release!: () => void;
    const heldUntil = new Promise<void>((resolve) => (release = resolve));
    api.respondWith({ ...failure, heldUntil });
    await page.getByRole("button", { name: "Boost this page with 2Z" }).click();
    await expect.poll(() => api.fundCalls).toBe(2);
    for (const actor of [
      {
        id: 6868,
        username: "other-boost-viewer",
        full_name: "Other Viewer",
        tuzis: "500",
      },
      {
        id: 861,
        username: "boost-tester",
        full_name: "Boost Tester",
        tuzis: "1000",
      },
    ]) {
      await page.route("**/api/auth/user/", (route) =>
        route.fulfill({ json: actor }),
      );
      await page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        await (
          await import(module)
        ).authStore.checkAuth({ force: true, fresh: true, silent: true });
      });
      await expect(fallback).toHaveCount(0);
      await expect(page.getByTestId("insufficient-funds")).toHaveCount(0);
    }
    release();
    await expect.poll(() => api.completedCalls).toBe(2);
    await expect(fallback).toHaveCount(0);
    await expect(page.getByTestId("payment-outcome-error")).toHaveCount(0);
    await expect(page.getByTestId("insufficient-funds")).toHaveCount(0);
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "Private boost outcome" }),
    ).toHaveCount(0);
    await page.goto("/");
    await expect(fallback).toHaveCount(0);
  });
}
