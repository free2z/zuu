import { expect, test } from "@playwright/test";
import { browserAppOrigin, browserMockApiOrigin } from "./ports";
import { waitForProbeReadiness } from "./null-probe-policy";
import readinessSignals from "./null-probe-readiness.json" with { type: "json" };
import { NULL_URL_STATES } from "./null-url-fixture.mjs";
import {
  auditSnapshot,
  installNullUrlAudit,
  isDirectoryNullUrl,
  observeNullUrls,
} from "./null-url-audit";

// Controlled Googlebot Smartphone template, not an observed visitor. Chrome
// version is a fixed test input. Source: developers.google.com/crawling/docs/
// crawlers-fetchers/google-common-crawlers (read 2026-11-13).
const CRAWLER_UA =
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const VIEWS = [
  { name: "homepage", path: "/", text: "URL boundary article" },
  { name: "profile", path: "/null-url-fixture", text: "Public fixture bio" },
  {
    name: "article",
    path: "/null-url-fixture/null-url-article",
    text: "URL boundary content",
  },
  {
    name: "conversation",
    path: "/converse/null-url-conversation",
    text: "Public conversation fixture",
  },
];
test.describe.configure({ timeout: 90_000 });
test.use({
  userAgent: CRAWLER_UA,
  viewport: { width: 390, height: 844 },
  reducedMotion: "reduce",
});

// Compile each route once outside the individual assertion budget. Cold Vite
// compilation is substantial for these four real application routes.
test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  await request.post(`${browserMockApiOrigin()}/__null-url-fixture`, {
    data: { state: "missing" },
  });
  for (const view of VIEWS) {
    const response = await request.get(`${browserAppOrigin()}${view.path}`, {
      timeout: 180_000,
      headers: { cookie: "sessionid=null-url-fixture" },
    });
    expect(response.status()).toBe(200);
  }
});

test.afterEach(async ({ request }) => {
  await request.post(`${browserMockApiOrigin()}/__null-url-fixture`, {
    data: { state: "off" },
  });
});

for (const state of NULL_URL_STATES) {
  for (const view of VIEWS) {
    test(`${view.name}: ${state} optional data, SSR through delayed hydration`, async ({
      browser,
      request,
    }, testInfo) => {
      await request.post(`${browserMockApiOrigin()}/__null-url-fixture`, {
        data: { state },
      });
      const phases = [];
      for (const javaScriptEnabled of [false, true]) {
        const context = await browser.newContext({
          baseURL: browserAppOrigin(),
          javaScriptEnabled,
          userAgent: CRAWLER_UA,
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
          reducedMotion: "reduce",
        });
        try {
          // Synthetic expired session bypasses the anonymous homepage TTL;
          // user lookup remains anonymous. No production identity is used.
          await context.addCookies([
            {
              name: "sessionid",
              value: "null-url-fixture",
              url: browserAppOrigin(),
            },
          ]);
          const network = await observeNullUrls(context);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.name));
          page.on("console", (message) => {
            if (
              /hydration_(mismatch|attribute_changed|html_changed)/.test(
                message.text(),
              )
            )
              errors.push("hydration");
          });
          const response = await page.goto(view.path);
          expect(response?.status()).toBe(200);
          await expect(
            page
              .getByText(view.text, { exact: false })
              .filter({ visible: true })
              .first(),
          ).toBeVisible();
          if (!javaScriptEnabled) await page.evaluate(installNullUrlAudit);
          const initial = await auditSnapshot(page);
          const readinessSignal = readinessSignals[VIEWS.indexOf(view)];
          if (!javaScriptEnabled)
            expect(await page.locator(readinessSignal.selector).count()).toBe(
              0,
            );
          expect(initial.findings).toEqual([]);
          if (javaScriptEnabled) {
            await expect(page.getByTestId("navbar-auth-trigger")).toBeVisible({
              timeout: 30_000,
            });
            // A mounted enhancement, rather than elapsed time alone, proves
            // the article's hydration boundary actually ran.
            if (view.name === "article")
              await expect(page.locator("h2 > a.heading-anchor")).toHaveCount(
                1,
                { timeout: 30_000 },
              );
            if (view.name === "conversation") {
              await expect(
                page.getByText("Delayed reply fixture"),
              ).toBeVisible();
              await page.getByRole("button", { name: /Reply/ }).first().click();
            }
            if (view.name === "profile") {
              await page.getByRole("button", { name: /Share/ }).first().click();
              await page.keyboard.press("Escape");
            }
            // Exercise the same explicit readiness criterion used by the CLI.
            await waitForProbeReadiness(page, readinessSignal, 30_000);
            await page.keyboard.press("Escape");
            // Hover triggers SvelteKit preload; scrolling triggers lazy media
            // and the mobile-feed intersection observer, without crawling links.
            const link = page
              .locator('a[href="/null-url-fixture/null-url-article"]')
              .first();
            if (await link.isVisible()) await link.hover();
            await page.evaluate(() =>
              window.scrollTo(0, document.body.scrollHeight),
            );
            await page.waitForTimeout(1000);
          }
          const final = await auditSnapshot(page);
          expect(final.findings).toEqual([]);
          expect(network.badRequests).toEqual([]);
          expect(errors).toEqual([]);
          expect(final.inventory["a:href"]).toBeGreaterThan(0);
          expect(final.inventory["jsonld:@id"]).toBeGreaterThan(0);
          phases.push({
            phase: javaScriptEnabled ? "hydrated-interacted" : "ssr-no-js",
            initial,
            final,
            ...network,
          });
        } finally {
          await context.close();
        }
      }
      await testInfo.attach("null-url-aggregate", {
        body: JSON.stringify({ state, view: view.name, phases }),
        contentType: "application/json",
      });
    });
  }
}

test("detector controls: resolved boundary, transient attributes and actual network", async ({
  page,
  context,
}) => {
  const base = "https://fixture.example/creator/article";
  for (const value of ["null", "./null", "/creator/null", "%6eull?x=1#ignored"])
    expect(isDirectoryNullUrl(value, base)).toBe(true);
  for (const value of [
    "/search?q=null",
    "#null",
    "/nullification",
    "/creator/article?src=null",
    "https://other.example/creator/null",
    "/assets/null.png",
  ])
    expect(isDirectoryNullUrl(value, base)).toBe(false);
  const network = await observeNullUrls(context);
  await page.route("**/audit-control/**", (route) =>
    route.fulfill({
      body: "<!doctype html><body>control</body>",
      contentType: "text/html",
    }),
  );
  await page.route("**/audit-control/worker.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: 'fetch("./null").then(() => postMessage("done"))',
    }),
  );
  await page.goto("/audit-control/article");
  await page.evaluate(() => {
    document.body.innerHTML =
      '<a href="/search?q=null">null</a><div class="ordinary" data="null"></div><style>.ordinary::before { content: "url(null)"; } /* url(null) is a comment */</style><script type="application/json">{"url":null,"content":"null"}</script>';
  });
  expect((await auditSnapshot(page)).findings).toEqual([]);
  await page.evaluate(() => {
    const a = document.createElement("a");
    document.body.append(a);
    a.href = "null";
    a.href = "/search?q=null"; // oldValue must retain the transient URL.
    const img = document.createElement("img");
    img.src = "null";
    document.body.append(img);
    const box = document.createElement("div");
    box.innerHTML =
      '<source srcset="/favicon.png 1x, null 2x"><video poster="null"></video><form action="null"></form><object data="null"></object><link rel="preload" as="image" href="null"><style>.audit-bad { background-image: url(null) }</style><script type="application/ld+json">{"url":"null","description":"null"}</script>';
    document.body.append(box);
    void fetch("null");
  });
  await expect.poll(() => network.badRequests).toContain("image");
  expect((await auditSnapshot(page)).findings).toEqual(
    expect.arrayContaining([
      "a:href",
      "img:src",
      "source:srcset",
      "video:poster",
      "form:action",
      "object:data",
      "link:href",
      "style:sheet",
      "jsonld:url",
    ]),
  );
  expect(network.badRequests).toContain("fetch");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const worker = new Worker("/audit-control/worker.js");
        worker.onmessage = () => {
          worker.terminate();
          resolve();
        };
      }),
  );
  expect(network.workers.dedicated).toBe(1);
  expect(
    network.badRequests.filter((kind) => kind === "fetch").length,
  ).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "null";
    a.textContent = "Control navigation";
    document.body.append(a);
  });
  await page.getByRole("link", { name: "Control navigation" }).click();
  await expect(page).toHaveURL(/\/audit-control\/null$/);
  expect(network.badRequests).toContain("document");
});
