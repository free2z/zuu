import { expect, test, type Page } from "@playwright/test";

const ADVISORY_TRIGGER = "xychart\n  x-axis 1 --> 1\n  line [1, 2]";

async function openFixtureArticle(page: Page, diagram: string) {
  await page.goto("/articles");
  await page.getByRole("link", { name: /Read “Why Shielded-by-Default Matters”/ }).waitFor();
  await page.evaluate(async (content) => {
    const { mockArticles } = (await import(
      "/src/lib/api/mock-data.ts"
    )) as typeof import("../src/lib/api/mock-data");
    mockArticles[0].content = `# Isolated diagram\n\n\`\`\`mermaid\n${content}\n\`\`\``;
  }, diagram);
  await page
    .getByRole("link", { name: /Read “Why Shielded-by-Default Matters”/ })
    .click();
  await expect(page).toHaveURL(/\/articles\/why-shielded-by-default$/);
  await expect(page.locator('[data-mermaid-status="rendering"]')).toBeVisible();
}

test("normal creator diagram renders as isolated, sanitized SVG", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openFixtureArticle(page, "flowchart LR\n  Reader --> Wallet");

  const rendered = page.locator('[data-mermaid-status="rendered"]');
  await expect(rendered).toBeVisible({ timeout: 5_500 });
  const boundary = await rendered.locator("[data-mermaid-shadow-host]").evaluate((host) => {
    const shadow = host.shadowRoot;
    const svg = shadow?.querySelector("svg");
    return {
      hasSvg: Boolean(svg),
      hasExecutableContent: Boolean(
        shadow?.querySelector(
          "script, iframe, image, object, embed, foreignObject, [onload], [onclick]",
        ),
      ),
      rootChildren: shadow?.childElementCount ?? 0,
      text: svg?.textContent ?? "",
      viewBox: svg?.getAttribute("viewBox") ?? "",
      width: svg?.getBoundingClientRect().width ?? 0,
      height: svg?.getBoundingClientRect().height ?? 0,
    };
  });
  expect(boundary.hasSvg).toBe(true);
  expect(boundary.hasExecutableContent).toBe(false);
  expect(boundary.rootChildren).toBe(1);
  expect(boundary.text).toContain("Reader");
  expect(boundary.text).toContain("Wallet");
  expect(boundary.viewBox).toMatch(/^-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? \d/);
  expect(boundary.width).toBeGreaterThanOrEqual(100);
  expect(boundary.height).toBeGreaterThanOrEqual(40);
  await expect(page.locator("body > svg, body > style")).toHaveCount(0);
});

test("normal sequence diagram remains supported off-thread", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 800 });
  await openFixtureArticle(
    page,
    "sequenceDiagram\n  participant Reader\n  participant Wallet\n  Reader->>Wallet: Open\n  Wallet-->>Reader: Ready",
  );
  const rendered = page.locator('[data-mermaid-status="rendered"]');
  await expect(rendered).toBeVisible({ timeout: 5_500 });
  const text = await rendered.locator("[data-mermaid-shadow-host]").evaluate(
    (host) => host.shadowRoot?.querySelector("svg")?.textContent ?? "",
  );
  expect(text).toContain("Reader");
  expect(text).toContain("Wallet");
  expect(text).toContain("Ready");
});

test("strict output sanitization rejects executable labels and external loads", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("attacker.invalid")) externalRequests.push(request.url());
  });
  await page.addInitScript(() => {
    (window as Window & { __mermaidExecuted?: boolean }).__mermaidExecuted = false;
  });
  await page.setViewportSize({ width: 768, height: 800 });
  await openFixtureArticle(
    page,
    'flowchart LR\n  A["<img src=x onerror=window.__mermaidExecuted=true>"] --> B\n  style A fill:url(https://attacker.invalid/diagram)',
  );
  const terminal = page.locator(
    '[data-mermaid-status="rendered"], [data-mermaid-status="rejected"]',
  );
  await expect(terminal).toBeVisible({ timeout: 5_500 });
  expect(
    await page.evaluate(
      () => (window as Window & { __mermaidExecuted?: boolean }).__mermaidExecuted,
    ),
  ).toBe(false);
  await expect(page.locator("script[src='x'], img[src='x'], image[href='x']")).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});

// ZUULI proves the worker cannot block navigation by leaving for the wallet.
// There is no wallet on this surface, so the departure is to Log in — the other
// destination the narrow tab bar carries for a signed-out reader. What is being
// measured is unchanged: a creator diagram must never hold the UI thread.
test("advisory trigger is bounded and cannot block shell navigation", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openFixtureArticle(page, ADVISORY_TRIGGER);

  const startedAt = Date.now();
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "Log in" })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  expect(Date.now() - startedAt).toBeLessThan(2_000);

  // A fresh visit exercises the exact advisory input through the real worker.
  // Patched Mermaid may reject or render it, but it must reach a hard terminal
  // result before the worker's five-second termination boundary.
  await openFixtureArticle(page, ADVISORY_TRIGGER);
  const renderStartedAt = Date.now();
  const terminal = page.locator(
    '[data-mermaid-status="rendered"], [data-mermaid-status="rejected"]',
  );
  await expect(terminal).toBeVisible({ timeout: 5_500 });
  expect(Date.now() - renderStartedAt).toBeLessThan(5_500);
  expect(await terminal.getAttribute("data-mermaid-status")).toMatch(/rendered|rejected/);
});
