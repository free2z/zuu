import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseURL = process.env.AUDIT_BASE_URL ?? "http://127.0.0.1:1423";
const outRoot = process.env.AUDIT_OUT ?? path.resolve("audit-artifacts/ios-current-main");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const devices = [
  { name: "iphone-se-3", width: 375, height: 667, scale: 2 },
  { name: "iphone-16-pro", width: 393, height: 852, scale: 3 },
];

const signedOutRoutes = [
  ["discover", "/"],
  ["search-empty", "/search"],
  ["search-results", "/search?q=zcash"],
  ["creator-zooko", "/creator/zooko"],
  ["creator-missing", "/creator/does-not-exist"],
  ["profile-gate", "/profile"],
  ["kyc-gate", "/kyc"],
  ["wallet-overview", "/wallet"],
  ["wallet-send", "/wallet/send"],
  ["wallet-receive", "/wallet/receive"],
  ["wallet-history", "/wallet/history"],
  ["ai", "/ai"],
  ["live-discovery", "/live"],
  ["live-broadcast", "/live/nine"],
  ["live-subscriber", "/live/zooko"],
  ["live-ppv", "/live/mining_maya"],
  ["live-offline", "/live/f2z"],
  ["articles-feed", "/articles"],
  ["article-reader", "/articles/why-shielded-by-default"],
  ["article-missing", "/articles/not-a-real-article"],
  ["article-author-gate", "/articles/new"],
  ["buy", "/buy"],
  ["not-found", "/this-route-does-not-exist"],
  ["login-chooser", "/login"],
];

function clean(s) {
  return s.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function waitForSettled(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(950);
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
}

async function resetRouteScroll(page) {
  await page.evaluate(() => {
    const candidates = [
      document.querySelector("[data-route-scroll] [data-radix-scroll-area-viewport]"),
      document.querySelector("[data-route-scroll]"),
      document.scrollingElement,
    ].filter(Boolean);
    for (const el of candidates) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
  });
}

async function inspect(page, name, route, authState, device) {
  return await page.evaluate(({ name, route, authState, device }) => {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const visible = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
    };
    const describe = (el) => {
      const r = el.getBoundingClientRect();
      const role = el.getAttribute("role") || el.tagName.toLowerCase();
      const label = el.getAttribute("aria-label") || el.textContent?.replace(/\s+/g, " ").trim() || "";
      return {
        role,
        label: label.slice(0, 160),
        x: Math.round(r.x * 10) / 10,
        y: Math.round(r.y * 10) / 10,
        width: Math.round(r.width * 10) / 10,
        height: Math.round(r.height * 10) / 10,
      };
    };
    const all = [...document.querySelectorAll("body *")].filter(visible);
    const outside = all
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.right > vw + 1 || r.left < -1;
      })
      .slice(0, 50)
      .map(describe);
    const clippedText = all
      .filter((el) => {
        if (!el.textContent?.trim() || el.children.length) return false;
        const cs = getComputedStyle(el);
        return el.scrollWidth > el.clientWidth + 1 && ["hidden", "clip"].includes(cs.overflowX);
      })
      .slice(0, 50)
      .map((el) => ({ ...describe(el), text: el.textContent.trim().slice(0, 180) }));
    const controls = [...document.querySelectorAll("button, a[href], input, textarea, select, [role=button], [role=tab]")]
      .filter(visible);
    const smallTargets = controls
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width < 44 || r.height < 44;
      })
      .slice(0, 80)
      .map(describe);
    const unlabeled = controls
      .filter((el) => {
        if (["input", "textarea", "select"].includes(el.tagName.toLowerCase())) return false;
        const text = el.textContent?.trim();
        return !text && !el.getAttribute("aria-label") && !el.getAttribute("title");
      })
      .map(describe);
    const scrollers = all
      .filter((el) => {
        const cs = getComputedStyle(el);
        return el.scrollHeight > el.clientHeight + 2 && ["auto", "scroll"].includes(cs.overflowY);
      })
      .map((el) => ({ ...describe(el), clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }));
    const top = document.querySelector("[data-app-top-bar]")?.getBoundingClientRect();
    const bottom = document.querySelector("[data-app-bottom-nav]")?.getBoundingClientRect();
    return {
      name,
      route,
      authState,
      device,
      title: document.title,
      viewport: { width: vw, height: vh, dpr: device.scale },
      body: {
        clientWidth: document.body.clientWidth,
        scrollWidth: document.body.scrollWidth,
        clientHeight: document.body.clientHeight,
        scrollHeight: document.body.scrollHeight,
      },
      root: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
      },
      topBar: top ? { top: top.top, bottom: top.bottom, width: top.width, height: top.height } : null,
      bottomBar: bottom ? { top: bottom.top, bottom: bottom.bottom, width: bottom.width, height: bottom.height } : null,
      outside,
      clippedText,
      smallTargets,
      unlabeled,
      scrollers,
      visibleText: document.body.innerText.replace(/\n{3,}/g, "\n\n").slice(0, 8000),
    };
  }, { name, route, authState, device });
}

async function capture(page, device, authState, name, route, records) {
  await page.goto(baseURL + route, { waitUntil: "domcontentloaded" });
  await waitForSettled(page);
  await resetRouteScroll(page);
  const record = await inspect(page, name, route, authState, device);
  records.push(record);
  const folder = path.join(outRoot, device.name, authState);
  await mkdir(folder, { recursive: true });
  await page.screenshot({ path: path.join(folder, `${clean(name)}.png`) });

  const scroll = record.scrollers.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
  if (scroll && scroll.scrollHeight > scroll.clientHeight * 1.45) {
    await page.evaluate(() => {
      const els = [...document.querySelectorAll("body *")].filter((el) => {
        const cs = getComputedStyle(el);
        return el.scrollHeight > el.clientHeight + 2 && ["auto", "scroll"].includes(cs.overflowY);
      });
      els.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      if (els[0]) els[0].scrollTop = els[0].scrollHeight;
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(folder, `${clean(name)}--bottom.png`) });
  }
}

async function login(page) {
  await page.goto(baseURL + "/login", { waitUntil: "domcontentloaded" });
  await waitForSettled(page);
  await page.getByLabel("Email or username").fill("skyl");
  await page.getByLabel("Password").fill("audit-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });
  await waitForSettled(page);
}

async function runDevice(browser, device) {
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.scale,
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark",
    locale: "en-US",
    userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 ZUULI-Audit/${device.name}`,
  });
  const page = await context.newPage();
  const records = [];
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push({ url: page.url(), text: msg.text() });
  });
  page.on("pageerror", (error) => consoleErrors.push({ url: page.url(), text: error.message }));

  for (const [name, route] of signedOutRoutes) {
    await capture(page, device, "signed-out", name, route, records);
    if (name === "login-chooser") {
      await page.getByRole("button", { name: "Continue with Zcash" }).click();
      await page.waitForTimeout(250);
      const subName = "login-zcash-idle";
      const subRecord = await inspect(page, subName, "/login", "signed-out", device);
      records.push(subRecord);
      await page.screenshot({ path: path.join(outRoot, device.name, "signed-out", `${subName}.png`) });
    }
  }

  await login(page);
  const signedInRoutes = [
    ["discover", "/"],
    ["profile-editor", "/profile"],
    ["kyc-basic-info", "/kyc"],
    ["article-author", "/articles/new"],
    ["creator-zooko", "/creator/zooko"],
    ["live-discovery", "/live"],
    ["live-subscriber", "/live/zooko"],
    ["live-ppv", "/live/mining_maya"],
    ["ai", "/ai"],
    ["buy", "/buy"],
  ];
  for (const [name, route] of signedInRoutes) {
    await capture(page, device, "signed-in", name, route, records);
  }

  // Stateful panes/dialogs with unique layouts.
  await page.goto(baseURL + "/buy", { waitUntil: "domcontentloaded" });
  await waitForSettled(page);
  for (const label of ["Send", "Activity"]) {
    const tab = page.getByRole("tab", { name: label, exact: true });
    if (await tab.count()) {
      await tab.click();
      await page.waitForTimeout(300);
      const name = `buy-${label.toLowerCase()}`;
      records.push(await inspect(page, name, "/buy", "signed-in", device));
      await page.screenshot({ path: path.join(outRoot, device.name, "signed-in", `${name}.png`) });
    }
  }

  await page.goto(baseURL + "/profile", { waitUntil: "domcontentloaded" });
  await waitForSettled(page);
  const accountButton = page.getByRole("button", { name: "Account menu" });
  if (await accountButton.count()) {
    await accountButton.click();
    await page.waitForTimeout(200);
    const name = "account-menu";
    records.push(await inspect(page, name, "/profile", "signed-in", device));
    await page.screenshot({ path: path.join(outRoot, device.name, "signed-in", `${name}.png`) });
  }

  await writeFile(path.join(outRoot, `${device.name}.json`), JSON.stringify({ records, consoleErrors }, null, 2));
  await context.close();
  return { records, consoleErrors };
}

await mkdir(outRoot, { recursive: true });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const summaries = [];
try {
  for (const device of devices) {
    const result = await runDevice(browser, device);
    summaries.push({
      device: device.name,
      screens: result.records.length,
      screensWithOutsideElements: result.records.filter((r) => r.outside.length).map((r) => r.name),
      screensWithClippedText: result.records.filter((r) => r.clippedText.length).map((r) => r.name),
      screensWithSmallTargets: result.records.filter((r) => r.smallTargets.length).map((r) => r.name),
      consoleErrors: result.consoleErrors,
    });
  }
} finally {
  await browser.close();
}
await writeFile(path.join(outRoot, "summary.json"), JSON.stringify(summaries, null, 2));
console.log(JSON.stringify(summaries, null, 2));
