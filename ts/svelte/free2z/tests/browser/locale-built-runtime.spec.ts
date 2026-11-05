import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Run with PLAYWRIGHT_PRODUCTION=1 after npm run build.
const production = process.env.PLAYWRIGHT_PRODUCTION === "1";
test.skip(!production, "requires the production build and hashed chunks");
const manifest = production
  ? JSON.parse(
      readFileSync(".svelte-kit/output/client/.vite/manifest.json", "utf8"),
    )
  : {};
const chunk = (locale: string) =>
  `**/${manifest[`src/lib/locales/${locale}.json`].file}`;
async function choose(page: Page, locale: string) {
  const button = page.getByRole("button", {
    name: /^(Language|Idioma|Langue):/,
  });
  await expect
    .poll(async () => {
      await button.click();
      return page.getByText(locale, { exact: true }).isVisible();
    })
    .toBe(true);
  await page.getByText(locale, { exact: true }).click();
}

test("failed hashed chunk offers reload recovery", async ({ page }) => {
  let requests = 0;
  await page.route(chunk("es"), async (route) => {
    requests++;
    await route.abort("failed");
  });
  await page.goto("/trending?lang=en");
  await choose(page, "Español");
  await expect(page.getByRole("alert")).toContainText(
    "Could not load that language",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(requests).toBe(1);
  await page.unroute(chunk("es"));
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.getByText("Centro de ayuda").first()).toBeVisible();
});

test("pending and out-of-order loads retain latest selection", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(chunk("es"), async (route) => {
    started();
    await gate;
    await route.continue();
  });
  await page.goto("/trending?lang=en");
  await choose(page, "Español");
  await requested;
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("status").filter({ hasText: "Loading language" }),
  ).toBeVisible();
  await choose(page, "Français");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  release();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByText("Centre d’aide").first()).toBeVisible();
});

test("measure initial HTML and catalog network", async ({ page, request }) => {
  const { gzipSync } = await import("node:zlib");
  const seen = new Set<string>();
  function visit(key: string) {
    if (seen.has(key) || !manifest[key]) return;
    seen.add(key);
    for (const dependency of manifest[key].imports ?? []) visit(dependency);
  }
  for (const [key, value] of Object.entries(manifest))
    if ((value as { isEntry?: boolean }).isEntry) visit(key);
  for (const locale of ["en", "es", "fr", "pt-BR"])
    expect(seen.has(`src/lib/locales/${locale}.json`)).toBe(false);
  for (const locale of ["en", "fr"]) {
    const response = await request.get(`/trending?lang=${locale}`);
    expect(response.ok()).toBeTruthy();
    const html = await response.body();
    const catalogRequests: string[] = [];
    const paths = ["en", "es", "fr", "pt-BR"].map(
      (x) => manifest[`src/lib/locales/${x}.json`].file,
    );
    const capture = (url: string) => {
      if (paths.some((path) => url.endsWith(path))) catalogRequests.push(url);
    };
    page.on("request", (req) => capture(req.url()));
    await page.goto(`/trending?lang=${locale}`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    expect(catalogRequests).toEqual([]);
    console.log(
      `locale-measure ${locale} html=${html.length} gzip=${gzipSync(html).length} catalog-chunk-requests=${catalogRequests.length}`,
    );
  }
});

test("same-document retry after a failed chunk fetch", async ({ page }) => {
  let requests = 0;
  await page.route(chunk("es"), async (route) => {
    requests++;
    if (requests === 1) await route.abort("failed");
    else await route.continue();
  });
  await page.goto("/trending?lang=en");
  await choose(page, "Español");
  await expect(page.getByRole("alert")).toContainText(
    "Could not load that language",
  );
  await choose(page, "Español");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  expect(requests).toBe(2);
});
