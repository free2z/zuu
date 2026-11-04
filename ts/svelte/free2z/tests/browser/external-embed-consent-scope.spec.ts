import { expect, test, type Page } from "@playwright/test";

// A cold vite dev server compiles this route on first request, which alone can
// approach the default per-test budget.
test.describe.configure({ timeout: 90_000 });

const ARTICLE = "/embed-consent-user/embed-consent-fixture";
// This legacy route 301s to ARTICLE, so the router lands on exactly the scope
// a one-time grant would have been made under.
const LEGACY_ARTICLE = "/embed-consent-user/zpage/embed-consent-fixture";

/**
 * Assert on the rendered gate rather than on store internals: what matters is
 * whether the visitor is asked before youtube.com is contacted.
 */
function consentPrompt(page: Page) {
  return page.getByRole("heading", { name: "External content blocked" });
}

function embedFrame(page: Page) {
  return page.locator('iframe[src^="https://www.youtube.com/embed/"]');
}

async function loadOnce(page: Page) {
  await expect(consentPrompt(page)).toBeVisible();
  await page.getByRole("button", { name: "Load once" }).click();
  await expect(embedFrame(page)).toBeVisible();
}

/**
 * Click a real link so SvelteKit's router handles the navigation and the root
 * layout's hooks run against the router's own state.
 */
async function clickThrough(page: Page, target: string) {
  const before = await page.evaluate(() => location.href);
  await page.evaluate((href) => {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = "spa-nav";
    link.dataset.spaNav = "";
    document.body.append(link);
  }, target);
  await page.click("[data-spa-nav]");
  await page.waitForFunction((from) => location.href !== from, before);
  await page.evaluate(() => {
    document
      .querySelectorAll("[data-spa-nav]")
      .forEach((node) => node.remove());
  });
}

test("leaving a page spends its one-time embed consent, redirects included", async ({
  page,
}) => {
  await page.goto(ARTICLE);
  await loadOnce(page);

  // Leave without reloading the tab, then return through the legacy route.
  // beforeNavigate only ever sees /…/zpage/…, so the redirect would otherwise
  // deposit the visitor back onto a grant that was already spent.
  await clickThrough(page, "/");
  await clickThrough(page, LEGACY_ARTICLE);

  await expect(page).toHaveURL(new RegExp(`${ARTICLE}$`));
  await expect(consentPrompt(page)).toBeVisible();
  await expect(embedFrame(page)).toHaveCount(0);
});

test("one-time embed consent does not follow an SPA change of query string", async ({
  page,
}) => {
  await page.goto(`${ARTICLE}?page=1`);
  await loadOnce(page);

  await clickThrough(page, `${ARTICLE}?page=2`);

  await expect(consentPrompt(page)).toBeVisible();
  await expect(embedFrame(page)).toHaveCount(0);
});

test("an in-page anchor keeps a one-time embed loaded", async ({ page }) => {
  await page.goto(ARTICLE);
  await loadOnce(page);

  await clickThrough(page, `${ARTICLE}#comments`);

  await expect(embedFrame(page)).toBeVisible();
  await expect(consentPrompt(page)).toHaveCount(0);
});
