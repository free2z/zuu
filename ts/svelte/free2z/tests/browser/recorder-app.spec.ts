import { expect, test } from "@playwright/test";
// The invalid-config path must work without contacting a provider or embedding
// a frame. Deployment integration may supply its actual response policy.
const csp =
  process.env.RECORDER_TEST_CSP ??
  "default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; worker-src 'self' blob:; frame-src 'none'; frame-ancestors 'none';";

test("standalone recorder strips bearer query before SDK startup and needs no site session", async ({
  page,
}) => {
  await page.route("**/tools/recording/index.html?*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "content-security-policy": csp,
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      },
    });
  });
  const otherRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname !== "/tools/recording/index.html")
      otherRequests.push(request.url());
  });
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().includes("violates the following Content Security Policy"))
      violations.push(msg.text());
  });
  const response = await page.goto(
    "/tools/recording/index.html?authToken=FAKE-TEST-TOKEN&config=bad",
  );
  expect(response?.headers()["cache-control"]).toBe("no-store");
  await expect(page.locator("#status")).toHaveText(
    "Unable to initialize recording.",
  );
  await expect(page).toHaveURL(/\/tools\/recording\/index\.html$/);
  expect(
    otherRequests.every((url) => !url.includes("FAKE-TEST-TOKEN")),
  ).toBeTruthy();
  expect(
    otherRequests.every((url) =>
      new URL(url).pathname.startsWith("/_app/immutable/recorder/"),
    ),
  ).toBeTruthy();
  expect(violations).toEqual([]);
  expect(await page.context().cookies()).toEqual([]);
  await expect(page.locator("iframe")).toHaveCount(0);
});
