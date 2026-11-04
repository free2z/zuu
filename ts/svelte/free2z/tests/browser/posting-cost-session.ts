import type { Page } from "@playwright/test";

export async function installSession(
  page: Page,
  tuzis: string | undefined,
  zpages?: number,
  welcome_grant?: string | null,
  options: {
    cachedWelcomeGrant?: string;
    authStatus?: number;
    beforeAuthResponse?: () => Promise<void>;
  } = {},
) {
  const creator = {
    id: 1460,
    welcome_grant,
    username: "penny-test-user",
    full_name: "Penny Test User",
    ...(tuzis === undefined ? {} : { tuzis }),
    ...(zpages === undefined ? {} : { zpages }),
  };
  const posts: unknown[] = [];

  await page.addInitScript(
    (c) => {
      localStorage.setItem(
        "auth",
        JSON.stringify({ isAuthenticated: true, creator: c, loading: false }),
      );
    },
    { ...creator, welcome_grant: options.cachedWelcomeGrant ?? welcome_grant },
  );

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (pathname === "/api/auth/user/") {
      await options.beforeAuthResponse?.();
      await route.fulfill({
        status: options.authStatus ?? 200,
        contentType: "application/json",
        body: JSON.stringify(creator),
      });
      return;
    }
    if (pathname === "/api/comments/" && request.method() === "POST") {
      posts.push(JSON.parse(request.postData() || "{}"));
      // The server's contract: 402 with a machine-readable shortfall.
      await route.fulfill({
        status: 402,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Not enough tuzis",
          code: "insufficient_funds",
          action: "comment",
          cost: "1",
          balance: tuzis ?? "0",
          shortfall: "1",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, next: null, results: [] }),
    });
  });

  return { posts };
}
