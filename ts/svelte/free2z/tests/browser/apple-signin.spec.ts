import { expect, test } from "@playwright/test";

// Local browser fixtures only. Apple pages and the account API never receive
// real credentials. Django tests separately exercise signatures/claims/CSRF.
for (const result of [
  "success",
  "cancel",
  "state",
  "duplicate",
  "query",
] as const) {
  test(`Apple web callback ${result} preserves correlation and keeps proofs out of HTTP URLs`, async ({
    page,
    context,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    let signedIn = false;
    let exchanges = 0;
    const proof = "fixture-apple-proof";
    const state = "fixture-apple-state-abcdefghijklmnop";
    const redirect = `${baseURL}/oauth/reauth-callback`;
    // This fixture exercises no third-party scripts or live provider pages.
    await context.route("https://**/*", async (route) => {
      if (new URL(route.request().url()).hostname === "appleid.apple.com")
        await route.continue();
      else await route.abort();
    });
    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      // Vite serves source modules under /src/lib/api/ in dev mode. Only
      // mock the HTTP API, never replace JavaScript modules with JSON.
      if (!path.startsWith("/api/")) {
        await route.continue();
        return;
      }
      if (path === "/api/auth/user/") {
        await route.fulfill({
          status: signedIn ? 200 : 401,
          json: signedIn
            ? { id: 1301, username: "applefixture", full_name: "Apple Fixture" }
            : {},
        });
      } else if (path === "/api/auth/social/providers/") {
        await route.fulfill({
          json: {
            providers: [
              { provider: "apple", configured: true, web_only: true },
            ],
          },
        });
      } else if (path === "/api/auth/social/apple/start") {
        await route.fulfill({
          json: {
            state,
            authorize_url: `https://appleid.apple.com/auth/authorize?response_type=code&response_mode=fragment&state=${state}&redirect_uri=${encodeURIComponent(redirect)}`,
          },
        });
      } else if (path === "/api/auth/social/apple/") {
        exchanges++;
        expect(request.method()).toBe("POST");
        expect(request.postDataJSON()).toMatchObject({
          code: proof,
          state,
          redirect_uri: redirect,
        });
        expect(request.headers()["x-csrftoken"]).toBeTruthy();
        signedIn = true;
        await route.fulfill({
          json: {
            token: "discard-this-native-token",
            username: "applefixture",
          },
        });
      } else {
        await route.fulfill({ json: { count: 0, results: [] } });
      }
    });
    await context.route("https://appleid.apple.com/**", async (route) => {
      const params = new URLSearchParams({ state, code: proof });
      if (result === "cancel") {
        params.delete("code");
        params.set("error", "user_cancelled_authorize");
      }
      if (result === "state")
        params.set("state", "wrong-state-abcdefghijklmnop");
      if (result === "duplicate") params.append("state", state);
      const target = `${redirect}${result === "query" ? "?" : "#"}${params}`;
      await route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(target)})</script>`,
      });
    });
    const requests: string[] = [];
    context.on("request", (request) => requests.push(request.url()));
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    const button = page.getByRole("button", { name: "Continue with Apple" });
    await expect(button).toBeVisible({ timeout: 90_000 });
    expect(
      await button.evaluate((element) => getComputedStyle(element).cursor),
    ).toBe("pointer");
    const opened = page.waitForEvent("popup");
    await button.click();
    const popup = await opened;
    await popup.waitForURL("**/oauth/reauth-callback**");
    if (result === "success") {
      await expect(
        popup.getByRole("button", { name: "Finish signing in" }),
      ).toBeVisible({ timeout: 30_000 });
      expect(popup.url()).toBe(redirect);
      expect(requests.some((url) => url.includes(proof))).toBe(false);
      await popup.getByRole("button", { name: "Finish signing in" }).click();
      await expect.poll(() => exchanges).toBe(1);
      await expect(page.getByTestId("navbar-profile-trigger")).toBeVisible();
      expect(
        await page.evaluate(() =>
          JSON.stringify({ ...localStorage, ...sessionStorage }),
        ),
      ).not.toContain("discard-this-native-token");
    } else {
      await expect(popup.getByTestId("reauth-callback-status")).toContainText(
        "invalid or expired",
        { timeout: 30_000 },
      );
      await expect(
        popup.getByRole("button", { name: "Finish signing in" }),
      ).toHaveCount(0);
      expect(exchanges).toBe(0);
    }
    if (!popup.isClosed()) await popup.close();
  });
}
