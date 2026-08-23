import { expect, test } from "@playwright/test";

const ARTICLE = "/articles/remote-media-consent-audit";
const PROVIDER_HOSTS = new Set([
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "www.youtube.com",
  "vimeo.com",
]);

test("a native article externalizes provider videos without creating iframes", async ({
  page,
}) => {
  const providerRequests: string[] = [];
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (PROVIDER_HOSTS.has(target.hostname)) providerRequests.push(target.href);
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: false,
      value: {},
    });
  });

  await page.goto(ARTICLE);
  await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();

  const externalEmbeds = page.locator("[data-native-external-embed]");
  await expect(externalEmbeds).toHaveCount(2);
  await expect(
    externalEmbeds.filter({ hasText: "Open YouTube video outside ZUULI" }),
  ).toHaveAttribute("data-native-external-embed", "youtube");
  await expect(
    externalEmbeds.filter({ hasText: "Open Vimeo video outside ZUULI" }),
  ).toHaveAttribute("data-native-external-embed", "vimeo");

  await expect(
    page.getByRole("link", { name: "Open YouTube video outside ZUULI" }),
  ).toHaveAttribute(
    "href",
    "https://www.youtube.com/watch?v=PrivacyAudit01",
  );
  await expect(
    page.getByRole("link", { name: "Open Vimeo video outside ZUULI" }),
  ).toHaveAttribute("href", "https://vimeo.com/123456789");
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: /Load video from (www\.youtube|player\.vimeo)/,
    }),
  ).toHaveCount(0);

  // The synthetic browser has no native opener implementation. A native
  // opener failure must fail closed instead of navigating this privileged
  // document or falling back to an in-process window.
  const articleUrl = page.url();
  await page
    .getByRole("link", { name: "Open YouTube video outside ZUULI" })
    .click();
  expect(page.url()).toBe(articleUrl);
  await expect(page.locator("iframe")).toHaveCount(0);

  await page.waitForTimeout(200);
  expect(providerRequests).toEqual([]);
});
