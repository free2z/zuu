#!/usr/bin/env node
// Bounded, explicit read-only probe. Does not discover or follow page links.
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import {
  assertProbePolicyReady,
  installReadOnlyProbePolicy,
  waitForProbeReadiness,
} from "../tests/browser/null-probe-policy.ts";
import {
  auditSnapshot,
  installNullUrlAudit,
  observeNullUrls,
} from "../tests/browser/null-url-audit.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      origin: { type: "string" },
      path: { type: "string", multiple: true },
      "public-read-only": { type: "boolean" },
      "readiness-file": { type: "string" },
      "readiness-timeout-ms": { type: "string" },
    },
  });
  if (values.help) {
    console.log(`Usage: FREE2Z_PROBE_USER_AGENT='<controlled or operator UA>' node scripts/probe-null-urls.mjs
  --origin http://127.0.0.1:PORT --path / --path /PROFILE
  --path /PROFILE/ARTICLE --path /converse/THREAD --readiness-file signals.json
  [--readiness-timeout-ms 15000] [--public-read-only]

Exactly four explicit public paths, in the order above. Two renders per path:
SSR (JS disabled), client-ready (390x844, touch, reduced motion, 3 seconds + scroll).
Readiness JSON: four {"selector":"CLIENT-INTRODUCED-VISIBLE-SELECTOR", "trigger":"OPTIONAL-BUTTON-SELECTOR"}
entries in path order. The signal must be absent in SSR; optional triggers must
be native non-submit buttons. A missing/stalled signal fails within 100–15000ms.
External origins require HTTPS and --public-read-only. GET/HEAD only, 200
requests per render (1000 on loopback for Vite), 45 seconds per render maximum,
no link clicks or persisted state.
Output is aggregate JSON only; paths, UA, URLs, page text and errors are omitted.
WebSockets are routed without connecting; WebTransport, WebRTC, workers,
EventSource and beacons are denied before page scripts. Any denied attempt,
unsupported guard, blocked request or unresolved readiness makes the run
incomplete/nonzero. This is not a hostile-code sandbox or an operator window.`);
    process.exit(0);
  }

  const ua = process.env.FREE2Z_PROBE_USER_AGENT;
  const origin = new URL(values.origin || "http://invalid.invalid");
  const paths = values.path || [];
  const readinessTimeout = Number(values["readiness-timeout-ms"] || 15000);
  const signals = values["readiness-file"]
    ? JSON.parse(await readFile(values["readiness-file"], "utf8"))
    : null;
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
  if (
    !ua ||
    !values.origin ||
    paths.length !== 4 ||
    !Number.isInteger(readinessTimeout) ||
    readinessTimeout < 100 ||
    readinessTimeout > 15000 ||
    !Array.isArray(signals) ||
    signals.length !== 4 ||
    signals.some(
      (signal) =>
        !signal ||
        typeof signal.selector !== "string" ||
        !signal.selector.trim() ||
        signal.selector.length > 500 ||
        (signal.trigger !== undefined &&
          (typeof signal.trigger !== "string" ||
            !signal.trigger.trim() ||
            signal.trigger.length > 500)),
    ) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (!local && (!values["public-read-only"] || origin.protocol !== "https:")) ||
    !["https:", "http:"].includes(origin.protocol) ||
    paths.some(
      (path) =>
        !path.startsWith("/") ||
        path.startsWith("//") ||
        new URL(path, origin).origin !== origin.origin,
    )
  ) {
    console.error("Invalid probe configuration; use --help. No requests sent.");
    process.exit(2);
  }

  const report = {
    started: new Date().toISOString(),
    finished: "",
    playwright: createRequire(import.meta.url)("@playwright/test/package.json")
      .version,
    chromium: "",
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
    renders: [],
  };
  const browser = await chromium.launch();
  try {
    report.chromium = browser.version();
    for (const [index, path] of paths.entries()) {
      let ssrSignalAbsent = false;
      for (const javaScriptEnabled of [false, true]) {
        const context = await browser.newContext({
          userAgent: ua,
          viewport: report.viewport,
          reducedMotion: "reduce",
          isMobile: true,
          hasTouch: true,
          javaScriptEnabled,
          serviceWorkers: "block",
          acceptDownloads: false,
        });
        let count = 0;
        let blocked = 0;
        let pageErrors = 0;
        let blockedTransports = {};
        let initial;
        let status;
        const readiness = {
          kind: signals[index].trigger
            ? "button-reaction"
            : "client-introduced-selector",
          status: javaScriptEnabled ? "pending" : "ssr-independent",
          timeoutMs: readinessTimeout,
        };
        const deadline = setTimeout(() => {
          void context.close().catch(() => {});
        }, 45_000);
        try {
          blockedTransports = await installReadOnlyProbePolicy(context);
          await context.route("**/*", async (route) => {
            if (
              ++count > (local ? 1000 : 200) ||
              !["GET", "HEAD"].includes(route.request().method())
            ) {
              blocked++;
              await route.abort();
            } else await route.continue();
          });
          const network = await observeNullUrls(context);
          const page = await context.newPage();
          if (javaScriptEnabled) await assertProbePolicyReady(page);
          page.on("popup", (popup) => {
            blocked++;
            void popup.close();
          });
          page.setDefaultTimeout(15_000);
          page.on("pageerror", () => pageErrors++);
          const response = await page.goto(new URL(path, origin).href, {
            waitUntil: "load",
            timeout: 30_000,
          });
          status = response?.status();
          if (javaScriptEnabled) await assertProbePolicyReady(page);
          if (!javaScriptEnabled) await page.evaluate(installNullUrlAudit);
          initial = await auditSnapshot(page);
          if (!javaScriptEnabled)
            ssrSignalAbsent =
              (await page.locator(signals[index].selector).count()) === 0;
          if (javaScriptEnabled) {
            if (!ssrSignalAbsent) {
              readiness.status = "invalid-present-in-ssr";
              throw new Error(
                "Static SSR signal cannot prove client readiness",
              );
            }
            await waitForProbeReadiness(page, signals[index], readinessTimeout);
            readiness.status = "observed";
            if (blocked || pageErrors || Object.keys(blockedTransports).length)
              throw new Error("Incomplete probe policy coverage");
            await page.evaluate(() =>
              window.scrollTo(0, document.body.scrollHeight),
            );
            await page.waitForTimeout(3000);
          }
          const final = await auditSnapshot(page);
          const version = response?.headers()["x-f2z-ui-version"] || "";
          const incomplete =
            blocked > 0 ||
            pageErrors > 0 ||
            Object.keys(blockedTransports).length > 0 ||
            status !== 200;
          report.renders.push({
            view: ["homepage", "profile", "article", "conversation"][index],
            javaScriptEnabled,
            phase: incomplete
              ? javaScriptEnabled
                ? "client-incomplete"
                : "ssr-incomplete"
              : javaScriptEnabled
                ? "client-ready-scrolled"
                : "ssr-no-js",
            status,
            incomplete,
            readiness: { ...readiness, ssrSignalAbsent },
            blockedTransports,
            version: /^[a-f0-9]{7,40}$/.test(version) ? version : "unavailable",
            initial,
            final,
            ...network,
            blocked,
            pageErrors,
          });
        } catch {
          // No stack/message: browser errors may contain private request URLs.
          report.renders.push({
            view: index,
            javaScriptEnabled,
            incomplete: true,
            phase: javaScriptEnabled ? "client-incomplete" : "ssr-incomplete",
            status,
            initial,
            blocked,
            blockedTransports,
            readiness: {
              ...readiness,
              status:
                readiness.status === "pending"
                  ? "unresolved"
                  : readiness.status,
              ssrSignalAbsent,
            },
          });
          process.exitCode = 1;
        } finally {
          clearTimeout(deadline);
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  report.finished = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
  if (
    report.renders.some(
      (render) =>
        render.badRequests?.length ||
        render.incomplete ||
        render.final?.findings.length ||
        render.blocked ||
        render.pageErrors ||
        render.status !== 200,
    )
  )
    process.exitCode = 1;
}

await main().catch(() => {
  console.error(
    "Probe failed; details suppressed to avoid exposing request data.",
  );
  process.exitCode = 1;
});
