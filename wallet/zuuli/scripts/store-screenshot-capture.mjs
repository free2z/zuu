#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { installVaultNativeFixture } from "./store-vault-fixture.mjs";
import {
  captureInputFiles,
  CAPTURE_NPM_CI_ARGUMENTS,
  CAPTURE_NPM_ENVIRONMENT,
  CAPTURE_CONFIG_PATH,
  CAPTURE_RECORD_PATH,
  assertCaptureSourceCommit,
  assertNoLocalCaptureOverrides,
  computeCaptureContractDigest,
  computeCaptureSourceDigest,
  readCanonicalJson,
  validateCaptureConfig,
  validateCaptureRecord,
} from "./store-screenshot-contract.mjs";

import { captureTlsDockerArguments, CAPTURE_TLS_BOOTSTRAP, assertCaptureTlsRuntime } from "./capture-tls.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(projectRoot, "store/manifest.json");
const disclosurePattern = /\b(?:mock|fixture|debug|localhost|playwright|seed phrase|private key|secret key)\b|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/iu;
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
  [".wasm", "application/wasm"],
]);
export const CAPTURE_PUBLIC_REQUESTS = Object.freeze({
  fresh: Object.freeze(["GET https://free2z.cash/api/zpage/?homeSort=popular&page=1&page_size=24"]),
  "search-privacy": Object.freeze([
    "GET https://free2z.cash/api/zpage/?homeSort=popular&page=1&page_size=24",
    "GET https://free2z.cash/api/zpage/?homeSort=popular&page=1&page_size=24&search=privacy",
  ]),
  "article-reader": Object.freeze([
    "GET https://free2z.cash/api/comments/zpage/editorial-shielded-defaults/?page=1&parent__isnull=True",
    "GET https://free2z.cash/api/zpage/why-shielded-defaults-matter/",
  ]),
  "creator-profile": Object.freeze([
    "GET https://free2z.cash/api/creator/example_editorial/",
    "GET https://free2z.cash/api/zpage/?ordering=-created_at&page=1&page_size=12&username=example_editorial",
  ]),
});

export function capturePublicRequestAllowed(action, key) {
  return CAPTURE_PUBLIC_REQUESTS[action]?.includes(key) ?? false;
}

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function captureInputDigests(root = projectRoot) {
  return {
    sourceDigest: await computeCaptureSourceDigest(root),
    contractDigest: await computeCaptureContractDigest(root),
  };
}

export async function assertCaptureManifestStable(expectedDigest, root = projectRoot) {
  const currentDigest = sha256(await readFile(resolve(root, "store/manifest.json")));
  if (currentDigest !== expectedDigest) fail("store manifest changed while screenshots were being produced");
}

export async function assertCaptureInputsStable(expected, root = projectRoot) {
  const current = await captureInputDigests(root);
  if (current.sourceDigest !== expected.sourceDigest || current.contractDigest !== expected.contractDigest) {
    fail("capture inputs changed while the production bundle or screenshots were being produced");
  }
}

function requestKey(request) {
  const url = new URL(request.url());
  const query = new URLSearchParams([...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)));
  return `${request.method()} ${url.origin}${url.pathname}${query.size ? `?${query}` : ""}`;
}

async function command(executable, args, options = {}) {
  await new Promise((accept, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? projectRoot,
      env: options.env ?? process.env,
      stdio: options.quiet ? "ignore" : "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) accept();
      else reject(new Error(`${executable} ${args.join(" ")} failed (${signal ?? code})`));
    });
  });
}

export async function assertReleaseSource(config, root = projectRoot) {
  await assertCaptureSourceCommit(config.sourceSha, root);
}

async function runInCaptureContainer(argv, config, expectedDigests) {
  if (process.platform === "win32" || typeof process.getuid !== "function" || typeof process.getgid !== "function") fail("deterministic capture requires Docker on Linux or macOS");
  const npmEnvironment = Object.entries(CAPTURE_NPM_ENVIRONMENT).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  const npmCommand = ["npm", ...CAPTURE_NPM_CI_ARGUMENTS].join(" ");
  await command("docker", [
    "run", "--rm", "--label", "cash.free2z.capture=zuuli-956", "--platform", config.browser.platform, "--ipc=host",
    "--env", "CI=1", "--env", "ZUULI_STORE_CAPTURE_CONTAINER=1",
    ...npmEnvironment,
    ...await captureTlsDockerArguments(),
    "--env", `ZUULI_STORE_EXPECTED_SOURCE_DIGEST=${expectedDigests.sourceDigest}`,
    "--env", `ZUULI_STORE_EXPECTED_CONTRACT_DIGEST=${expectedDigests.contractDigest}`,
    "--env", `ZUULI_STORE_EXPECTED_MANIFEST_DIGEST=${expectedDigests.manifestDigest}`,
    "--env", `HOST_UID=${process.getuid()}`, "--env", `HOST_GID=${process.getgid()}`,
    "--volume", `${resolve(projectRoot, "..")}:/work`, "--volume", "/work/zuuli/node_modules", "--workdir", "/work/zuuli",
    config.browser.containerImage,
    "bash", "-lc", `${CAPTURE_TLS_BOOTSTRAP} && /usr/local/bin/verify-zuuli-store-capture-image && node scripts/capture-tls.mjs --verify-runtime && : > "$NPM_CONFIG_USERCONFIG" && : > "$NPM_CONFIG_GLOBALCONFIG" && node scripts/store-screenshot-preflight.mjs && ${npmCommand} && node scripts/store-screenshot-preflight.mjs && node scripts/store-screenshot-capture.mjs ${argv[0]} && chown -R "$HOST_UID:$HOST_GID" store/media store/capture-record.json store/manifest.json dist`,
  ]);
}

async function assertCaptureRuntime(config) {
  await assertCaptureTlsRuntime();
  await command("/usr/local/bin/verify-zuuli-store-capture-image", []);
  if (process.platform !== "linux" || process.arch !== "x64") fail("capture worker is not the declared Linux/amd64 runtime");
  try {
    await access("/.dockerenv");
  } catch {
    fail("capture worker is not running inside Docker");
  }
  const executable = chromium.executablePath();
  if (!executable.startsWith("/ms-playwright/")) fail("capture browser is not supplied by the pinned Playwright image");
  try {
    await access(executable);
  } catch {
    fail("capture browser from the pinned Playwright image is unavailable");
  }
  for (const packageName of ["@playwright/test", "playwright", "playwright-core"]) {
    const packageJson = JSON.parse(await readFile(resolve(projectRoot, "node_modules", packageName, "package.json"), "utf8"));
    if (packageJson.version !== config.browser.playwrightVersion) fail(`installed ${packageName} version differs from the capture contract`);
  }
  if (config.browser.platform !== "linux/amd64") fail("capture configuration and runtime platform disagree");
}

async function startStaticServer(distRoot) {
  const canonicalDist = resolve(distRoot);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      let path = decodeURIComponent(url.pathname);
      if (path === "/" || !extname(path)) path = "/index.html";
      const candidate = resolve(canonicalDist, `.${path}`);
      if (!candidate.startsWith(`${canonicalDist}${sep}`)) {
        response.writeHead(400).end();
        return;
      }
      const bytes = await readFile(candidate);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": mimeTypes.get(extname(candidate)) ?? "application/octet-stream",
      });
      response.end(bytes);
    } catch {
      try {
        const bytes = await readFile(resolve(canonicalDist, "index.html"));
        response.writeHead(200, { "cache-control": "no-store", "content-type": mimeTypes.get(".html") });
        response.end(bytes);
      } catch {
        response.writeHead(404).end();
      }
    }
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") fail("capture server did not obtain a loopback port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())),
  };
}

export function computeFeedCaptureScroll({
  currentScroll,
  visibleTop,
  visibleBottom,
  controlTop,
  contentBottom,
  requireControl,
}) {
  for (const [name, value] of Object.entries({ currentScroll, visibleTop, visibleBottom, controlTop, contentBottom })) {
    if (!Number.isFinite(value)) fail(`capture geometry has no finite ${name}`);
  }
  if (visibleBottom <= visibleTop) fail("capture geometry has no unobscured vertical space");
  const contentDelta = Math.max(0, contentBottom - visibleBottom);
  const controlDelta = requireControl ? Math.max(0, controlTop - visibleTop) : Number.POSITIVE_INFINITY;
  return currentScroll + Math.min(contentDelta, controlDelta);
}

export function vaultStaticRequestAllowed(origin, rawUrl, method, shotRoute, staticPaths = new Set()) {
  const url = new URL(rawUrl);
  return url.origin === origin && method === "GET" && (!url.search || (url.pathname.endsWith(".wasm") && url.search === "?init")) &&
    (url.pathname === shotRoute || staticPaths.has(url.pathname));
}

// About authors this public support contact. It is neither a tester nor an
// account identity; no other email, suffix or route inherits the exception.
export function vaultDisclosureScanPassed(text, action) {
  const scanned = action === "about" ? text.replace(/(?<![a-z0-9._%+-])help@free2z\.com(?![a-z0-9-]|\.[a-z0-9-])/giu, "") : text;
  return !disclosurePattern.test(scanned) && !/\b(?:u1|utest1|zs1|t1|t3)[a-zA-Z0-9]{20,}\b/.test(text);
}

export async function preparePage(context, { origin, fixture, target, shot, fixedTime, staticPaths }) {
  const page = await context.newPage();
  const refused = [], errors = [];
  page.on("pageerror", () => errors.push("page error"));
  page.on("console", (message) => { if (message.type() === "error") errors.push("console error"); });
  await page.routeWebSocket("**/*", (socket) => { refused.push("websocket"); socket.close(); });
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (vaultStaticRequestAllowed(origin, request.url(), request.method(), shot.route, staticPaths)) {
      await route.continue();
    } else {
      refused.push("request");
      await route.abort("blockedbyclient");
    }
  });
  await page.addInitScript(({ safeArea, fixedTime }) => {
    localStorage.clear(); sessionStorage.clear();
    const NativeDate = Date, fixed = Date.parse(fixedTime);
    class FixedDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixed])); }
      static now() { return fixed; }
    }
    window.Date = FixedDate;
    const apply = () => {
      for (const [edge, value] of Object.entries(safeArea)) document.documentElement.style.setProperty(`--safe-area-${edge}`, `${value}px`);
    };
    if (document.documentElement) apply();
    else document.addEventListener("DOMContentLoaded", apply, { once: true });
  }, { safeArea: target.safeArea, fixedTime });
  await page.addInitScript(installVaultNativeFixture, { fixture, action: shot.action });
  await page.goto(`${origin}${shot.route}`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}" });
  const focus = shot.action === "vault-home" ? page.getByRole("heading", { name: "Welcome to ZUULI", exact: true })
    : shot.action === "wallet-send" ? page.getByText("Send ZEC", { exact: true })
    : shot.action === "wallet-history" ? page.getByText("No transactions yet", { exact: true })
    : page.getByRole("heading", { name: "About ZUULI", exact: true });
  await focus.waitFor();
  try {
    await page.waitForFunction(() => document.documentElement.dataset.wasmSpike === "42");
    await page.waitForFunction(() => window.__STORE_VAULT_AUDIT__.calls.filter((c) => c === "plugin:zcash|get_wallet_status").length >= 2);
  } catch {
    fail(`capture bootstrap incomplete: ${JSON.stringify({ errors, refused, audit: await page.evaluate(() => window.__STORE_VAULT_AUDIT__) })}`);
  }
  await page.evaluate(() => document.fonts.ready);
  // Wait for the coherent snapshot and both identity reads, not an arbitrary delay.
  if (shot.action === "wallet-send") {
    await page.waitForFunction(() => !document.body.innerText.includes("Checking for an earlier payment"));
    if (await page.locator("input, textarea").evaluateAll((nodes) => nodes.some((node) => node.value !== ""))) fail("Send capture must remain blank");
    if (await page.getByRole("button", { name: /Review/ }).isEnabled()) fail("blank Send must not be payable");
  }
  // Scroll only the real route viewport. Browser scrollIntoView can also
  // move overflow:hidden ancestors, which hides the persistent app chrome.
  await focus.evaluate((node, action) => {
    const viewport = document.querySelector("[data-scroll-area-viewport]");
    const top = Math.max(viewport.getBoundingClientRect().top, document.querySelector("[data-app-top-bar]").getBoundingClientRect().bottom);
    const bottomNav = document.querySelector("[data-app-bottom-nav]");
    const bottom = Math.min(viewport.getBoundingClientRect().bottom, bottomNav?.getBoundingClientRect().top || innerHeight);
    const region = action === "wallet-history" ? node.parentElement : node;
    const rect = region.getBoundingClientRect();
    if (action === "wallet-send") viewport.scrollTop += Math.max(0, rect.top - top - 24);
    else viewport.scrollTop += Math.max(0, rect.bottom - bottom + 8);
  }, shot.action);
  const visible = await focus.evaluate((node) => {
    const rect = node.getBoundingClientRect(), viewport = document.querySelector("[data-scroll-area-viewport]").getBoundingClientRect();
    const topBar = document.querySelector("[data-app-top-bar]").getBoundingClientRect();
    const bottomNav = document.querySelector("[data-app-bottom-nav]");
    const bottom = Math.min(viewport.bottom, bottomNav?.getBoundingClientRect().top || innerHeight);
    return topBar.top >= -1 && topBar.bottom <= innerHeight && rect.top >= Math.max(viewport.top, topBar.bottom) - 1 && rect.bottom <= bottom + 1 && rect.left >= 0 && rect.right <= innerWidth;
  });
  if (!visible) fail(`capture focus is clipped: ${target.setId}/${shot.id}`);
  const evidence = await page.evaluate(() => ({
    text: [document.body.innerText, ...[...document.querySelectorAll("input,textarea")].map((n) => n.value)].join(" ").replace(/\s+/g, " ").trim(),
    overflow: document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll("[data-scroll-area-viewport]")].some((n) => n.scrollWidth > n.clientWidth + 1),
    frames: document.querySelectorAll("iframe,frame,object,embed").length,
    audit: window.__STORE_VAULT_AUDIT__,
  }));
  if (refused.length || errors.length || evidence.audit.refused.length) fail(`capture refused network/native operation or runtime error: ${JSON.stringify({ refused, errors, native: evidence.audit.refused })}`);
  const required = ["free2z_session_sync", "oauth_callback_transport", "plugin:zcash|get_wallet_status", "plugin:zcash|list_wallets", "plugin:zcash|get_account_balance", "plugin:zcash|get_unified_address", "plugin:zcash|get_sync_status", "plugin:zcash|start_sync"];
  if (shot.action === "wallet-send") required.push("plugin:zcash|get_pending_send");
  if (shot.action === "wallet-history") required.push("plugin:zcash|get_transaction_history");
  if (required.some((call) => !evidence.audit.calls.includes(call))) fail("capture did not exercise its native read contract");
  if (evidence.overflow || evidence.frames || !vaultDisclosureScanPassed(evidence.text, shot.action) || evidence.text.includes(fixture.unifiedAddress)) fail(`capture contains overflow, frames, private data or a forbidden disclosure: ${target.setId}/${shot.id}`);
  return { page, renderedTextSha256: sha256(Buffer.from(evidence.text, "utf8")) };
}

async function capturePass({ outputRoot, config, fixture, sourceDigest, contractDigest, distRoot }) {
  const staticPaths = new Set((await captureInputFiles(distRoot, ["."])).map((path) => `/${path.replace(/^\.\//, "")}`));
  const server = await startStaticServer(distRoot);
  let browser;
  const entries = [];
  try {
    browser = await chromium.launch({ headless: true });
    for (const target of config.targets) {
      const context = await browser.newContext({
        viewport: { width: target.cssWidth, height: target.cssHeight },
        deviceScaleFactor: target.deviceScaleFactor,
        locale: config.locale,
        timezoneId: config.timezone,
        colorScheme: config.colorScheme,
        reducedMotion: "reduce",
        serviceWorkers: "block",
      });
      try {
        for (const shot of config.shots) {
          const { page, renderedTextSha256 } = await preparePage(context, { origin: server.origin, fixture, target, shot, fixedTime: config.fixedTime, staticPaths });
          const relativePath = `store/media/${config.locale}/${target.setId}/${shot.id}.png`;
          const destination = resolve(outputRoot, relativePath);
          await mkdir(dirname(destination), { recursive: true });
          const raw = await page.screenshot({ type: "png", animations: "disabled", caret: "hide", scale: "device" });
          const decoded = PNG.sync.read(raw, { checkCRC: true });
          if (decoded.width !== target.cssWidth * target.deviceScaleFactor || decoded.height !== target.cssHeight * target.deviceScaleFactor) fail(`browser produced the wrong dimensions for ${target.setId}/${shot.id}`);
          const bytes = PNG.sync.write(decoded, { colorType: 2, inputColorType: 6, inputHasAlpha: true });
          await writeFile(destination, bytes);
          entries.push({
            setId: target.setId,
            id: shot.id,
            path: relativePath,
            sha256: sha256(bytes),
            renderedTextSha256,
            sourceSha: config.sourceSha,
            sourceDigest,
            route: shot.route,
            action: shot.action,
            cssWidth: target.cssWidth,
            cssHeight: target.cssHeight,
            deviceScaleFactor: target.deviceScaleFactor,
            width: decoded.width,
            height: decoded.height,
            safeArea: target.safeArea,
            disclosureScan: "passed",
          });
          await page.close();
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
  return {
    schemaVersion: 1,
    sourceSha: config.sourceSha,
    sourceDigest,
    contractDigest,
    fixtureProfile: config.fixtureProfile,
    locale: config.locale,
    fixedTime: config.fixedTime,
    browser: config.browser,
    entries,
  };
}

function assertSameCapture(first, second) {
  for (const capture of [first, second]) {
    const hashes = capture.entries.map(({ sha256 }) => sha256);
    if (new Set(hashes).size !== hashes.length) fail("a capture pass produced duplicate screenshot pixels");
  }
  const left = first.entries.map(({ setId, id, sha256, renderedTextSha256 }) => ({ setId, id, sha256, renderedTextSha256 }));
  const right = second.entries.map(({ setId, id, sha256, renderedTextSha256 }) => ({ setId, id, sha256, renderedTextSha256 }));
  if (JSON.stringify(left) !== JSON.stringify(right)) fail("two clean capture passes produced different pixels or rendered text");
}

export function markCaptureOwnerReviewRequired(manifest, first) {
  manifest.phase = "captured";
  manifest.publicationReady = false;
  for (const locale of manifest.locales) locale.copyStatus = "proposed-owner-legal-review-required";
  manifest.classification.reviewStatus = "proposed-owner-store-review-required";
  manifest.capturePolicy.status = "captured-owner-review-required";
  manifest.capturePolicy.blockedByIssues = [371, 373];
  manifest.capturePolicy.sourceSha = first.sourceSha;
  manifest.capturePolicy.sourceDigest = first.sourceDigest;
  manifest.capturePolicy.contractDigest = first.contractDigest;
  manifest.capturePolicy.captureConfig = CAPTURE_CONFIG_PATH;
  manifest.capturePolicy.captureRecord = CAPTURE_RECORD_PATH;
  for (const set of manifest.screenshotSets) {
    set.files = first.entries.filter(({ setId }) => setId === set.id).map(({ id, path, sha256, sourceSha }) => ({ id, path, sha256, sourceSha, reviewIssue: 387 }));
  }
  return manifest;
}

const CAPTURE_ARTIFACT_PATHS = ["store/media", CAPTURE_RECORD_PATH, "store/manifest.json"];

export async function commitCaptureArtifactSet({ root = projectRoot, stagedRoot, expectedManifestDigest, afterStep = async () => {} }) {
  const backupRoot = resolve(stagedRoot, "backup");
  const states = [];
  let interruptedSignal = null;
  const interrupt = (signal) => {
    interruptedSignal ??= signal;
  };
  const assertNotInterrupted = () => {
    if (interruptedSignal) throw new Error(`capture artifact commit interrupted by ${interruptedSignal}`);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    for (const relativePath of CAPTURE_ARTIFACT_PATHS) {
      assertNotInterrupted();
      const destination = resolve(root, relativePath);
      const staged = resolve(stagedRoot, relativePath);
      const backup = resolve(backupRoot, relativePath);
      await mkdir(dirname(backup), { recursive: true });
      const state = { relativePath, destination, staged, backup, backedUp: false, installed: false };
      states.push(state);
      await rename(destination, backup);
      state.backedUp = true;
      if (relativePath === "store/manifest.json" && expectedManifestDigest) {
        const backedUpDigest = sha256(await readFile(backup));
        if (backedUpDigest !== expectedManifestDigest) fail("store manifest changed before capture artifacts could be committed");
      }
      await afterStep(`backed-up:${relativePath}`);
      assertNotInterrupted();
      await mkdir(dirname(destination), { recursive: true });
      await rename(staged, destination);
      state.installed = true;
      await afterStep(`installed:${relativePath}`);
    }
    assertNotInterrupted();
  } catch (error) {
    for (const state of states.reverse()) {
      if (state.installed) await rm(state.destination, { recursive: true, force: true });
      if (state.backedUp) {
        await mkdir(dirname(state.destination), { recursive: true });
        await rename(state.backup, state.destination);
      }
    }
    throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

async function writeCapture(first, manifest, expectedManifestDigest) {
  const transactionRoot = await mkdtemp(resolve(projectRoot, ".store-capture-write-"));
  const stagedMedia = resolve(transactionRoot, "store/media");
  await mkdir(stagedMedia, { recursive: true });
  for (const entry of first.entries) {
    const source = resolve(first.outputRoot, entry.path);
    const destination = resolve(transactionRoot, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    const bytes = await readFile(source);
    if (sha256(bytes) !== entry.sha256) fail(`staged screenshot differs from its capture record: ${entry.setId}/${entry.id}`);
    await writeFile(destination, bytes);
  }
  markCaptureOwnerReviewRequired(manifest, first);
  await mkdir(dirname(resolve(transactionRoot, CAPTURE_RECORD_PATH)), { recursive: true });
  await writeFile(resolve(transactionRoot, CAPTURE_RECORD_PATH), canonical({ ...first, outputRoot: undefined }));
  await writeFile(resolve(transactionRoot, "store/manifest.json"), canonical(manifest));
  try {
    await commitCaptureArtifactSet({ root: projectRoot, stagedRoot: transactionRoot, expectedManifestDigest });
  } finally {
    await rm(transactionRoot, { recursive: true, force: true });
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !new Set(["--write", "--verify-reproducible"]).has(argv[0])) fail("usage: store-screenshot-capture.mjs --write|--verify-reproducible");
  const manifest = await readCanonicalJson(manifestPath, "store manifest");
  if (process.env.ZUULI_STORE_CAPTURE_CONTAINER !== "1") {
    const { config, sourceDigest } = await validateCaptureConfig({ root: projectRoot, screenshotSets: manifest.screenshotSets });
    const expectedDigests = {
      sourceDigest,
      contractDigest: await computeCaptureContractDigest(projectRoot),
      manifestDigest: sha256(await readFile(manifestPath)),
    };
    await assertReleaseSource(config);
    await assertCaptureInputsStable(expectedDigests, projectRoot);
    await assertCaptureManifestStable(expectedDigests.manifestDigest, projectRoot);
    await assertNoLocalCaptureOverrides(projectRoot);
    await runInCaptureContainer(argv, config, expectedDigests);
    const committedManifest = await readCanonicalJson(manifestPath, "store manifest");
    await validateCaptureRecord({ root: projectRoot, screenshotSets: committedManifest.screenshotSets, enforceCurrentSource: true });
    await assertCaptureInputsStable(expectedDigests, projectRoot);
    await assertNoLocalCaptureOverrides(projectRoot);
    return;
  }
  const expectedDigests = {
    sourceDigest: process.env.ZUULI_STORE_EXPECTED_SOURCE_DIGEST,
    contractDigest: process.env.ZUULI_STORE_EXPECTED_CONTRACT_DIGEST,
    manifestDigest: process.env.ZUULI_STORE_EXPECTED_MANIFEST_DIGEST,
  };
  if (!/^[0-9a-f]{64}$/.test(expectedDigests.sourceDigest ?? "") || !/^[0-9a-f]{64}$/.test(expectedDigests.contractDigest ?? "") || !/^[0-9a-f]{64}$/.test(expectedDigests.manifestDigest ?? "")) fail("capture worker requires exact host input digests");
  await assertCaptureInputsStable(expectedDigests, projectRoot);
  await assertCaptureManifestStable(expectedDigests.manifestDigest, projectRoot);
  await assertNoLocalCaptureOverrides(projectRoot);
  const { config, fixture } = await validateCaptureConfig({ root: projectRoot, screenshotSets: manifest.screenshotSets });
  await assertCaptureInputsStable(expectedDigests, projectRoot);
  await assertCaptureRuntime(config);
  await assertNoLocalCaptureOverrides(projectRoot);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("VITE_")) delete env[key];
  await command("npm", ["run", "build"], { env });
  await assertCaptureInputsStable(expectedDigests, projectRoot);
  await assertNoLocalCaptureOverrides(projectRoot);
  const { sourceDigest, contractDigest } = expectedDigests;
  const temp = await mkdtemp(resolve(tmpdir(), "zuuli-store-capture-"));
  try {
    const firstRoot = resolve(temp, "first");
    const secondRoot = resolve(temp, "second");
    const first = await capturePass({ outputRoot: firstRoot, config, fixture, sourceDigest, contractDigest, distRoot: resolve(projectRoot, "dist") });
    const second = await capturePass({ outputRoot: secondRoot, config, fixture, sourceDigest, contractDigest, distRoot: resolve(projectRoot, "dist") });
    assertSameCapture(first, second);
    await assertCaptureInputsStable(expectedDigests, projectRoot);
    await assertCaptureManifestStable(expectedDigests.manifestDigest, projectRoot);
    await assertNoLocalCaptureOverrides(projectRoot);
    if (argv[0] === "--write") {
      first.outputRoot = firstRoot;
      await writeCapture(first, manifest, expectedDigests.manifestDigest);
    } else {
      const committed = await readCanonicalJson(resolve(projectRoot, CAPTURE_RECORD_PATH), "capture record");
      assertSameCapture(first, committed);
      for (const entry of first.entries) {
        const current = await readFile(resolve(projectRoot, entry.path));
        if (sha256(current) !== entry.sha256) fail(`committed screenshot differs from deterministic capture: ${entry.setId}/${entry.id}`);
      }
      // Git metadata is deliberately not mounted into the capture worker. The
      // host proves the exact source commit before and after this container.
      await validateCaptureRecord({ root: projectRoot, screenshotSets: manifest.screenshotSets });
    }
    await assertCaptureInputsStable(expectedDigests, projectRoot);
    await assertNoLocalCaptureOverrides(projectRoot);
    process.stdout.write(`deterministic store capture passed (${first.entries.length} screenshots, two identical passes)\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`STORE_CAPTURE_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}
