import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadBuildIdentity } from "../scripts/build-identity.mjs";

import { expect, test } from "@playwright/test";
import { PSEUDO_ABOUT_MESSAGES } from "../src/lib/about-copy";

// The identity the About card must display is the canonical one, so read it
// from release.json rather than restating it. A literal here is only ever
// right by coincidence of the current build: `release-bump.mjs` regenerates
// the four generated identity surfaces on every bump but cannot reach into a
// test, so a pinned number turns each release into a gate failure while
// proving nothing about the binding (#822). Reading the canonical file is
// also the stronger assertion — it fails if the UI and release.json ever
// disagree, which a literal cannot detect. Same source as
// `src/lib/build-info.test.ts`, and the same file-reading convention as
// `tests/realtimekit-csp.pw.ts`.
const RELEASE = JSON.parse(
  readFileSync(new URL("../release.json", import.meta.url), "utf8"),
) as { version: string; build: number };

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto("/about");
  await page.locator("[data-about-page]").waitFor();
});

test("About is keyboard and screen-reader usable at 320px", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "About & Feedback" })).toBeVisible();
  const card = page.locator("[data-about-build-card]");
  await expect(card.getByText(RELEASE.version, { exact: true })).toBeVisible();
  await expect(
    card.getByText(String(RELEASE.build), { exact: true }),
  ).toBeVisible();
  await expect(card.getByText("Internal", { exact: true })).toBeVisible();
  await expect(card.getByText("Web", { exact: true })).toBeVisible();

  const copy = page.getByRole("button", { name: "Copy build info" });
  await copy.focus();
  await expect(copy).toBeFocused();
  const copyBox = await copy.boundingBox();
  expect(copyBox?.height).toBeGreaterThanOrEqual(44);

  await page.keyboard.press("Tab");
  const provenance = page.getByText("Build provenance", { exact: true });
  await expect(provenance).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Full source commit", { exact: true })).toBeVisible();

  const geometry = await page.locator("[data-app-frame]").evaluate((frame) => ({
    clientWidth: frame.clientWidth,
    scrollWidth: frame.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
});

test("copy uses the complete stable minimal block and announces completion", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await page.getByRole("button", { name: "Copy build info" }).click();
  await expect(page.getByRole("status")).toHaveText("Build info copied.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // Middle, tail-weighted truncation (see #829) — reuses truncateAddress's
  // default 8-head/10-tail split rather than a head-only prefix.
  const identity = loadBuildIdentity({ root: fileURLToPath(new URL("..", import.meta.url)) });
  const expectedCommit = identity.sourceCommit
    ? `${identity.sourceCommit.slice(0, 8)}…${identity.sourceCommit.slice(-10)}`
    : "Unavailable in this build";
  expect(copied).toMatch(
    new RegExp(
      `^ZUULI\\nVersion: ${RELEASE.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` +
        `\\nBuild: ${RELEASE.build}` +
        "\\nRelease channel: Internal\\nPlatform: Web" +
        `\\nSource commit: ${expectedCommit}$`,
    ),
  );
  expect(copied).not.toMatch(/wallet|balance|device|address|\/Users\//i);
});

test.describe("pseudo-expanded shipping locale", () => {
  test.use({ locale: "en-XA" });

  test("flows through navigation, page, formatter, and live status at 200%", async ({
    page,
  }) => {
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await expect(
      page.getByRole("heading", { name: PSEUDO_ABOUT_MESSAGES.pageTitle }),
    ).toBeVisible();
    await expect(page.getByText(PSEUDO_ABOUT_MESSAGES.pageDescription)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: PSEUDO_ABOUT_MESSAGES.buildHeading }),
    ).toBeVisible();

    const copy = page.getByRole("button", {
      name: PSEUDO_ABOUT_MESSAGES.copyAction,
    });
    await expect(copy).toBeVisible();
    expect((await copy.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await copy.focus();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText(
      PSEUDO_ABOUT_MESSAGES.copySuccess,
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      PSEUDO_ABOUT_MESSAGES.versionLabel,
    );

    // The app-shell navigation is driven by the i18n kernel (#797), which
    // only ships en/fr/es catalogs — it has no en-XA pseudo-locale entry, so
    // it falls back to the plain en-US navigation copy even while the About
    // page's own (still en-XA-aware) message block above is expanded.
    await page.locator('[data-navigation-id="more"]').click();
    await expect(
      page.getByRole("link", {
        name: "About and feedback",
      }),
    ).toBeVisible();

    const geometry = await page.evaluate(() => {
      const roots = [
        document.querySelector<HTMLElement>("[data-about-page]"),
        document.querySelector<HTMLElement>('[data-navigation-id="about"]'),
      ].filter((element): element is HTMLElement => element !== null);
      const surfaces = roots.flatMap((root) => [
        root,
        ...root.querySelectorAll<HTMLElement>("*"),
      ]);
      const overflowing = surfaces
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({
          tag: element.tagName,
          text: element.textContent?.trim().slice(0, 80),
        }));
      const frame = document.querySelector<HTMLElement>("[data-app-frame]");
      if (!frame) throw new Error("app frame unavailable");
      return {
        clientWidth: frame.clientWidth,
        scrollWidth: frame.scrollWidth,
        overflowing,
      };
    });
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    expect(geometry.overflowing).toEqual([]);
  });
});

test("About diagnostics separates full reports from opt-in feedback summaries", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Diagnostics", exact: true })).toBeVisible();
  await expect(page.locator("[data-native-diagnostics-state]")).toContainText("unavailable");
  await page.evaluate(() => { void Promise.reject(new Error("Failed /Users/alice/private.txt https://private.invalid")); });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("free2z.diagnostics.v1"))).toContain("unhandled-rejection");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const report = page.locator("[data-diagnostics-report]");
  await expect(report).toContainText("unhandled-rejection");
  await expect(report).not.toContainText("alice");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy report", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Diagnostics report");
  const toggle = page.getByRole("switch", { name: "Include reduced diagnostics" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.getByRole("radio", { name: /Private email/ }).check();
  await page.locator("#feedback-description").fill("The app stopped responding.");
  await page.getByRole("button", { name: "Review report", exact: true }).click();
  await expect(page.locator("#feedback-body")).toHaveValue(/Diagnostics summary/);
  await expect(page.locator("#feedback-body")).not.toHaveValue(/private|alice|\.txt/);
  const outgoingBody = await page.locator("#feedback-body").inputValue();
  const summary = outgoingBody.slice(outgoingBody.indexOf("Diagnostics summary"), outgoingBody.indexOf("\n\n---"));
  expect(summary).toContain("Recorded failures");
  // Exact copies in the editable preview must not defeat the removal action.
  await page.locator("#feedback-body").fill(`${summary}\n\n${outgoingBody}`);
  await page.getByRole("button", { name: "Remove diagnostics", exact: true }).click();
  await expect(page.locator("#feedback-body")).not.toHaveValue(/Diagnostics summary/);
});

test.describe("Spanish diagnostics locale", () => {
  test.use({ locale: "es-ES" });
  test("uses kernel diagnostics copy", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Diagnóstico", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copiar informe", exact: true })).toBeVisible();
  });
});
