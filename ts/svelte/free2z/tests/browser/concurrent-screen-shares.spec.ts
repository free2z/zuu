import { expect, test } from "@playwright/test";

test("renders concurrent remote/self shares and cleans up late owned subscriptions", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("requestfailed", (request) =>
    browserErrors.push(
      `REQUEST FAILED ${request.url()}: ${request.failure()?.errorText}`,
    ),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      browserErrors.push(`HTTP ${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) =>
    browserErrors.push(error.stack ?? error.message),
  );
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const target = document.createElement("div");
    target.dataset.testid = "mounted-share-fixture";
    document.body.append(target);
    // Vite serves these source modules to the browser; TypeScript cannot resolve absolute dev-server URLs.
    const runtimeUrl = "/tests/browser/svelte-runtime.ts";
    const fixtureUrl = "/tests/browser/concurrent-screen-shares-fixture.svelte";
    const runtime = import(runtimeUrl);
    const fixture = import(fixtureUrl);
    const [{ mount }, { default: Fixture }] = await Promise.all([
      runtime,
      fixture,
    ]);
    (window as any).__mountedShares = mount(Fixture, { target });
  });
  await expect(page.getByTestId("share-fixture-ready")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await expect(page.getByTestId("concurrent-screen-shares")).toBeVisible();
  await expect(
    page.getByTestId("screen-share-grid").getByText("Ada", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId("screen-share-grid").getByText("Bea", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId("screen-share-grid").getByText("You", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/loading/i)).toHaveCount(0);
  const firstCalls = await page.evaluate(() => window.__shareFixture.calls);
  expect(firstCalls).toContain("subscribe:remote-a");
  expect(firstCalls).toContain("subscribe:remote-b");
  expect(firstCalls.some((call) => call.includes("self"))).toBe(false);
  await page.evaluate(() => window.__shareFixture.resolve("remote-a"));
  await page.evaluate(() => window.__shareFixture.reject("remote-b"));
  await expect(page.getByRole("status")).toContainText(/could not subscribe/i);

  await page.getByRole("button", { name: "Bea" }).click();
  await expect(page.getByRole("button", { name: "Bea" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.evaluate(() => window.__shareFixture.stop("remote-a"));
  await page.evaluate(() => window.__shareFixture.resolve("remote-a"));
  await expect
    .poll(() => page.evaluate(() => window.__shareFixture.calls))
    .toContain("unsubscribe:remote-a");
  await expect(
    page.getByTestId("screen-share-grid").getByText("Ada", { exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__shareFixture.calls))
    .toContain("unsubscribe:remote-a");

  await page.evaluate(() => window.__shareFixture.leave("remote-b"));
  await expect(
    page.getByTestId("screen-share-grid").getByText("Bea", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.__shareFixture.dispose());
  expect(browserErrors).toEqual([]);
});

declare global {
  interface Window {
    __shareFixture: {
      calls: string[];
      pending: Array<{
        ids: string[];
        resolve: () => void;
        reject: () => void;
      }>;
      stop: (id: string) => void;
      leave: (id: string) => void;
      track: (id: string) => void;
      resolve: (id: string) => void;
      reject: (id: string) => void;
      dispose: () => Promise<void>;
    };
  }
}
