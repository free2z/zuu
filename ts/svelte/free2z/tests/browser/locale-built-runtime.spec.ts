import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  bytes,
  enforceBytes,
  enforceTiming,
  HTML_LIMITS,
  INITIAL_ASSET_LIMITS,
  TIMING_LIMITS,
} from "../../scripts/locale-budget.mjs";

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
    enforceBytes(
      `${locale} HTML`,
      bytes(html),
      HTML_LIMITS[locale as "en" | "fr"],
    );
    const catalogRequests: string[] = [];
    const assets = new Map<string, Buffer>();
    const pending: Promise<void>[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/_app/immutable/")) {
        pending.push(
          response
            .body()
            .then((body) => {
              assets.set(url.pathname, body);
            })
            .catch(() => {}),
        );
      }
    });
    const paths = ["en", "es", "fr", "pt-BR"].map(
      (x) => manifest[`src/lib/locales/${x}.json`].file,
    );
    const capture = (url: string) => {
      if (paths.some((path) => url.endsWith(path))) catalogRequests.push(url);
    };
    page.on("request", (req) => capture(req.url()));
    await page.goto(`/trending?lang=${locale}`, { waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await Promise.all(pending);
    const assetBytes = [...assets.values()].map(bytes);
    const totals = {
      raw: assetBytes.reduce((sum, value) => sum + value.raw, 0),
      gzip: assetBytes.reduce((sum, value) => sum + value.gzip, 0),
    };
    enforceBytes(`${locale} initial assets`, totals, INITIAL_ASSET_LIMITS);
    expect(catalogRequests).toEqual([]);
    console.log(
      `locale-assets ${locale} raw=${totals.raw} gzip=${totals.gzip} count=${assets.size}`,
    );
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

test("controlled cold and warm locale switches stay within smoke budgets", async ({
  page,
}) => {
  await page.route(chunk("es"), async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });
  await page.goto("/trending?lang=en");
  let start = performance.now();
  await choose(page, "Español");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  const cold = Math.max(0, performance.now() - start - 150);
  await choose(page, "English");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  start = performance.now();
  await choose(page, "Español");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  const warm = performance.now() - start;
  enforceTiming(
    "cold switch excluding injected network delay",
    cold,
    TIMING_LIMITS.coldSwitchMs,
  );
  enforceTiming("warm switch", warm, TIMING_LIMITS.warmSwitchMs);
  console.log(
    `locale-switch cold-minus-150ms=${cold.toFixed(1)} warm=${warm.toFixed(1)}`,
  );
});

test("concurrent locale SSR is private and stays within a smoke budget", async ({
  request,
}) => {
  const samples = await Promise.all(
    Array.from({ length: 12 }, async (_, index) => {
      const locale = index % 2 ? "fr" : "en";
      const start = performance.now();
      const response = await request.get("/trending", {
        headers: {
          Cookie: `free2z-locale=${locale}${index % 3 === 0 ? "; sessionid=billing-fixture-session" : ""}`,
          "Accept-Language": locale,
        },
      });
      const html = await response.text();
      expect(response.ok()).toBeTruthy();
      expect(response.headers()["cache-control"]).toMatch(/\bprivate\b/);
      expect(response.headers().vary).toMatch(/\bCookie\b/i);
      expect(response.headers().vary).toMatch(/\bAccept-Language\b/i);
      expect(html).toContain(`<html lang="${locale}"`);
      return performance.now() - start;
    }),
  );
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  enforceTiming("SSR p95", p95, TIMING_LIMITS.ssrP95Ms);
  console.log(`locale-ssr concurrent=12 p95=${p95.toFixed(1)}ms`);
});

test("authenticated and anonymous billing responses remain isolated", async ({
  request,
}) => {
  const [member, anonymous] = await Promise.all([
    request.get("/fixtureowner/dashboard/billing", {
      headers: {
        Cookie: "sessionid=billing-fixture-session; free2z-locale=fr",
      },
      maxRedirects: 0,
    }),
    request.get("/fixtureowner/dashboard/billing", {
      headers: { Cookie: "free2z-locale=en" },
      maxRedirects: 0,
    }),
  ]);
  expect(member.status()).toBe(200);
  const memberHtml = await member.text();
  expect(memberHtml).toContain('<html lang="fr"');
  expect(memberHtml).toContain('data-testid="billing-stats"');
  expect(member.headers()["cache-control"]).toMatch(/\bprivate\b/);
  expect(member.headers().vary).toMatch(/\bCookie\b/i);
  expect(anonymous.status()).not.toBe(200);
  expect(await anonymous.text()).not.toContain('data-testid="billing-stats"');
});

test("RTK pack failure keeps French and offers localized recovery", async ({
  page,
}) => {
  const rtk = manifest["src/lib/locales/rtk/es.json"];
  expect(rtk).toBeTruthy();
  await page.route(`**/${rtk.file}`, (route) => route.abort("failed"));
  await page.goto("/trending?lang=fr");
  await page.getByRole("button", { name: /^Langue:/ }).click();
  await expect(page.getByText("Version bêta").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await choose(page, "Español");
  await expect(page.getByRole("alert")).toContainText(
    "Impossible de charger cette langue.",
  );
  await expect(page.getByRole("button", { name: "Réessayer" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await page.unroute(`**/${rtk.file}`);
  await page.getByRole("button", { name: "Réessayer" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
});

test("KYC page retains route no-store with locale and session", async ({
  page,
}) => {
  await page.goto("/trending?lang=en");
  const origin = new URL(page.url());
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      url: origin.origin,
    },
  ]);
  const response = await page.request.get(
    "/fixtureowner/dashboard/kyc?lang=fr",
  );
  expect(response.headers()["cache-control"]).toMatch(/no-store/i);
  expect(response.headers()["vary"]).toMatch(/cookie/i);
});
