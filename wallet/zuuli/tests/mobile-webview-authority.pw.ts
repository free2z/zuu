import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * #367: on Android, Wry injects Tauri's IPC bridge into *every* frame and its
 * IPC reports the top-level URL as the origin, so a remote subframe resolves
 * as the trusted main window. The packaged CSP answers that with
 * `frame-src 'none'` — but a CSP that has never been exercised is a claim, not
 * a control.
 *
 * This file used to prove the narrower version of the property: that an
 * article's YouTube/Vimeo embeds were externalized to the OS browser instead
 * of becoming iframes. #904 phase 4 deleted the article renderer, and with it
 * the only surface that could have created one. So the assertion widens rather
 * than disappears: **no route this app still mounts creates a frame, and none
 * contacts an embed provider** — checked in a document that has been told it is
 * running under Tauri, which is where the defect lives.
 */

const ROUTES = [
  "/",
  "/about",
  "/login",
  "/wallet",
  "/wallet/send",
  "/wallet/receive",
  "/wallet/history",
  "/wallet/fund",
  "/does-not-exist",
] as const;

/** The `frame-src` clause of the packaged policy, read from the shipped config. */
const FRAME_POLICY = (() => {
  const config = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  ) as { app?: { security?: { csp?: string } } };
  const csp = config.app?.security?.csp ?? "";
  const directive = csp
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("frame-src "));
  if (!directive) throw new Error("packaged CSP declares no frame-src");
  return directive;
})();

const PROVIDER_HOSTS = new Set([
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "www.youtube.com",
  "vimeo.com",
]);

test("no route in the wallet authority creates a frame or reaches an embed provider", async ({
  page,
}) => {
  const providerRequests: string[] = [];
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (PROVIDER_HOSTS.has(target.hostname)) providerRequests.push(target.href);
  });
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: false,
      value: {},
    });
  });

  for (const route of ROUTES) {
    await page.goto(route);
    await page.locator("[data-app-frame]").waitFor();
    await page.waitForTimeout(300);

    await expect(page.locator("iframe"), `${route} must create no iframe`).toHaveCount(0);
    await expect(page.locator("frame"), `${route} must create no frame`).toHaveCount(0);
    await expect(page.locator("object"), `${route} must embed no object`).toHaveCount(0);
    await expect(page.locator("embed"), `${route} must embed nothing`).toHaveCount(0);

    // The positive control: the sweep is only meaningful if the route actually
    // rendered something. A blank document trivially has no frames.
    expect(
      await page.locator("[data-app-frame] *").count(),
      `${route} rendered no content, so its frame audit proves nothing`,
    ).toBeGreaterThan(10);
  }

  expect(providerRequests).toEqual([]);
});

test("a frame injected at runtime is refused by the shipped frame-src", async ({
  page,
}) => {
  // The negative control for the sweep above. `frame-src 'none'` is what makes
  // "no route creates a frame" load-bearing rather than incidental, so prove
  // the directive actually refuses one. The policy has to be present when the
  // document is parsed — a meta element appended later is ignored — so this
  // uses a document that declares it, exactly as the packaged app does.
  await page.goto("/");
  await page.setContent(
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}"></head><body></body></html>`,
  );
  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(event.violatedDirective);
    });
    const frame = document.createElement("iframe");
    frame.src = "https://www.youtube-nocookie.com/embed/PrivacyAudit01";
    document.body.append(frame);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return violations;
  });

  expect(result).toContain("frame-src");
});
