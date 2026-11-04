import { expect, test, type Request } from "@playwright/test";

import { PRIVACY_STORE_LOADER } from "./dev-source-module";

const ARTICLE = "/tweet-embed-user/tweet-embed-fixture";
const TWEET_FRAME =
  "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true";
const DARK_TWEET_FRAME = `${TWEET_FRAME}&theme=dark`;

// Mirrors the production policy's relevant contract: X is absent from
// script-src while frame-src permits the consent-gated iframe.
const ENFORCED_CSP = [
  "default-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src * data: blob:",
  "frame-src *",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

test("tweet iframe stays CSP-safe, resizes safely, and unmounts on revocation", async ({
  page,
}) => {
  const tweetRequests: string[] = [];
  const widgetScriptRequests: string[] = [];
  page.on("request", (request: Request) => {
    if (request.url().startsWith(TWEET_FRAME))
      tweetRequests.push(request.url());
    if (request.url().includes("platform.twitter.com/widgets.js")) {
      widgetScriptRequests.push(request.url());
    }
  });

  // Apply an enforced page policy to the rendered app response. The routed
  // frame uses the real platform origin, but a local document that behaves
  // like the X embed and emits its documented JSON-RPC resize messages.
  await page.route(
    "**/tweet-embed-user/tweet-embed-fixture*",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy": ENFORCED_CSP,
        },
      });
    },
  );
  await page.route(`${TWEET_FRAME}*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <article>Tweet fixture body</article>
        <button id="old-format" onclick="parent.postMessage({JSONRPC:{method:'twttr.private.resize',params:{width:550,height:1800}}}, '*')">Old format</button>
        <button id="short-height" onclick="parent.postMessage({'twttr.embed':{jsonrpc:'2.0',method:'twttr.private.resize',params:[{width:550,height:209}]}}, '*')">Short height</button>
        <button id="oversize" onclick="parent.postMessage({'twttr.embed':{jsonrpc:'2.0',method:'twttr.private.resize',params:[{width:550,height:9000}]}}, '*')">Oversize</button>
        <script>setTimeout(() => parent.postMessage({'twttr.embed':{jsonrpc:'2.0',method:'twttr.private.resize',params:[{width:550,height:1100}]}}, '*'), 0)</script>
      </body></html>`,
    });
  });

  const response = await page.goto(ARTICLE);
  const csp = response?.headers()["content-security-policy"] || "";
  expect(csp).toContain("frame-src *");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("platform.twitter.com");
  await expect(page.locator("iframe.tweet-embed-frame")).toHaveCount(0);
  expect(tweetRequests).toEqual([]);

  await page.getByRole("button", { name: "Always allow this site" }).click();

  const tweetFrame = page.locator("iframe.tweet-embed-frame");
  await expect(tweetFrame).toHaveAttribute("src", TWEET_FRAME);
  await expect(tweetFrame).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox",
  );
  await expect(
    tweetFrame.contentFrame().getByText("Tweet fixture body"),
  ).toBeVisible();
  await expect
    .poll(() =>
      tweetFrame.evaluate((frame: HTMLIFrameElement) => frame.style.height),
    )
    .toBe("1100px");
  expect(tweetRequests).toEqual([TWEET_FRAME]);
  expect(widgetScriptRequests).toEqual([]);
  // The direct link stays available while the frame renders (X down or
  // blocked by an extension never sends a message at all).
  await expect(
    page.locator(".tweet-embed-fallback", { hasText: "View post on X" }),
  ).toHaveAttribute(
    "href",
    "https://x.com/tweetfixture/status/1234567890123456789",
  );

  // X's Tweet.html renders a 550px card inside its iframe. Keep the iframe
  // viewport at that width on desktop so it does not expose a blank white
  // gutter, and center it in the article. On a narrow viewport it must shrink
  // to the available article width.
  const layout = () =>
    tweetFrame.evaluate((frame: HTMLIFrameElement) => {
      const shell = frame.parentElement!;
      const article = frame.closest(".markdown-content")!;
      const shellRect = shell.getBoundingClientRect();
      const articleRect = article.getBoundingClientRect();
      return {
        frameWidth: frame.getBoundingClientRect().width,
        shellWidth: shellRect.width,
        overlayContent: getComputedStyle(shell, "::after").content,
        shellCenter: shellRect.left + shellRect.width / 2,
        articleCenter: articleRect.left + articleRect.width / 2,
      };
    });
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect
    .poll(async () => (await layout()).frameWidth)
    .toBeLessThanOrEqual(550);
  const desktopLayout = await layout();
  expect(desktopLayout.frameWidth).toBe(550);
  expect(desktopLayout.shellWidth).toBe(550);
  expect(desktopLayout.overlayContent).toBe("none");
  expect(
    Math.abs(desktopLayout.shellCenter - desktopLayout.articleCenter),
  ).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await layout();
  expect(mobileLayout.frameWidth).toBeLessThan(550);
  expect(mobileLayout.frameWidth).toBe(mobileLayout.shellWidth);
  expect(
    Math.abs(mobileLayout.shellCenter - mobileLayout.articleCenter),
  ).toBeLessThanOrEqual(1);

  // A same-page message cannot resize the cross-origin frame. X's own resize
  // message can, but the provider-supplied height is capped and the wrapper
  // remains scrollable so content past the visible viewport stays reachable.
  await page.evaluate(() => {
    window.postMessage(
      {
        "twttr.embed": {
          jsonrpc: "2.0",
          method: "twttr.private.resize",
          params: [{ height: 1800 }],
        },
      },
      "*",
    );
  });
  await expect
    .poll(() =>
      tweetFrame.evaluate((frame: HTMLIFrameElement) => frame.style.height),
    )
    .toBe("1100px");

  // A same-origin iframe message using the obsolete wrapper is ignored too.
  await tweetFrame.contentFrame().locator("#old-format").click();
  await expect
    .poll(() =>
      tweetFrame.evaluate((frame: HTMLIFrameElement) => frame.style.height),
    )
    .toBe("1100px");

  // Keep the provider's theme in sync when the app theme changes after mount.
  await page.locator("html").evaluate((node) => node.classList.add("dark"));
  await expect(tweetFrame).toHaveAttribute("src", DARK_TWEET_FRAME);
  await expect
    .poll(() =>
      tweetFrame.evaluate((frame: HTMLIFrameElement) => frame.style.height),
    )
    .toBe("1100px");
  expect(tweetRequests).toEqual([TWEET_FRAME, DARK_TWEET_FRAME]);

  // The provider's valid 209px height must be the rendered iframe and shell
  // height too; a larger CSS minimum leaves a visible strip below the card.
  await tweetFrame.contentFrame().locator("#short-height").click();
  await expect
    .poll(() =>
      tweetFrame.evaluate((frame) => ({
        frame: frame.getBoundingClientRect().height,
        shell: frame.parentElement!.getBoundingClientRect().height,
      })),
    )
    .toEqual({ frame: 209, shell: 209 });

  await tweetFrame.contentFrame().locator("#oversize").click();
  await expect
    .poll(() =>
      tweetFrame.evaluate((frame: HTMLIFrameElement) => frame.style.height),
    )
    .toBe("2400px");
  await expect
    .poll(() =>
      tweetFrame.evaluate(
        (frame) => getComputedStyle(frame.parentElement!).overflowY,
      ),
    )
    .toBe("auto");

  await page.evaluate(async (loader) => {
    const { privacyStore } = await new Function(loader)();
    privacyStore.revokeDomain("x.com");
  }, PRIVACY_STORE_LOADER);
  await expect(tweetFrame).toHaveCount(0);
  expect(tweetRequests).toEqual([TWEET_FRAME, DARK_TWEET_FRAME]);
});

test("a missing tweet collapses to the direct link instead of a blank frame", async ({
  page,
}) => {
  // Real X (Tweet.html, 2026-10) answers a deleted/unknown id with exactly
  // this envelope and never sends a resize, leaving the frame empty.
  await page.route(`${TWEET_FRAME}*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <script>
          parent.postMessage({'twttr.embed':{jsonrpc:'2.0',method:'twttr.private.initialized',id:'embed-0',params:[{data:{tweet_id:'1234567890123456789'}}]}}, '*');
          setTimeout(() => parent.postMessage({'twttr.embed':{jsonrpc:'2.0',method:'twttr.private.no_results',id:'embed-0',params:[{data:{tweet_id:'1234567890123456789'}}]}}, '*'), 0);
        </script>
      </body></html>`,
    });
  });

  await page.goto(ARTICLE);
  await page.getByRole("button", { name: "Always allow this site" }).click();
  await expect(page.locator("iframe.tweet-embed-frame")).toHaveCount(0);
  await expect(
    page.locator(".tweet-embed-fallback", { hasText: "View post on X" }),
  ).toHaveAttribute(
    "href",
    "https://x.com/tweetfixture/status/1234567890123456789",
  );
});

test("a no_results message from outside the frame does not hide the tweet", async ({
  page,
}) => {
  await page.route(`${TWEET_FRAME}*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><article>Tweet fixture body</article>",
    });
  });

  await page.goto(ARTICLE);
  await page.getByRole("button", { name: "Always allow this site" }).click();
  const tweetFrame = page.locator("iframe.tweet-embed-frame");
  await expect(
    tweetFrame.contentFrame().getByText("Tweet fixture body"),
  ).toBeVisible();
  await page.evaluate(() => {
    window.postMessage(
      {
        "twttr.embed": {
          jsonrpc: "2.0",
          method: "twttr.private.no_results",
          params: [{}],
        },
      },
      "*",
    );
  });
  // Rejected by both the origin and the exact-frame source checks (removing
  // either alone still passes; removing both fails this test). Give the
  // forged message a chance to be (wrongly) handled.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
  await expect(tweetFrame).toHaveCount(1);
});
