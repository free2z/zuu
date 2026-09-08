#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { CAPTURE_PUBLIC_REQUESTS } from './store-screenshot-capture.mjs';
import { CAPTURE_NPM_CI_ARGUMENTS, CAPTURE_NPM_ENVIRONMENT, readCanonicalJson, validateCaptureConfig } from './store-screenshot-contract.mjs';
import { walletRoot, BROWSER, SHOTS, FORBIDDEN_TEXT, canonical, sha256, captureDigests, assertSourceCommit, assertCaptureEnvironment, validateSurfaceCaptureConfig, validateSurfaceCaptureRecord, validateRecordMatrix } from './surface-store-capture-contract.mjs';

async function command(executable, args, cwd = walletRoot) {
  await new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? accept() : reject(new Error(`${executable} exited ${code}`)));
  });
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
async function serverFor(root) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const file = resolve(root, `.${extname(pathname) ? pathname : '/index.html'}`);
      assert(file.startsWith(`${root}${sep}`));
      response.setHeader('content-type', mime[extname(file)] ?? 'application/octet-stream');
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((accept) => server.close(accept)) };
}
export function allowedPublicRequest(app, action, request) {
  return app === 'free2z' && (CAPTURE_PUBLIC_REQUESTS[action] ?? []).includes(request);
}
export const NATIVE_CALLS = ['plugin:f2zmsg|get_engine_status', 'plugin:f2zmsg|get_device_info', 'plugin:event|listen', 'plugin:event|unlisten'];
async function preparePage(context, { app, origin, config, target, shot, fixture }) {
  const page = await context.newPage();
  const requests = [], refused = [], failures = [];
  page.on('pageerror', () => failures.push('pageerror'));
  page.on('console', (msg) => { if (msg.type() === 'error') failures.push('console error'); });
  await page.routeWebSocket('**/*', (socket) => { refused.push('websocket'); socket.close(); });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const query = new URLSearchParams([...url.searchParams.entries()].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)));
    const key = `${request.method()} ${url.origin}${url.pathname}${query.size ? `?${query}` : ''}`;
    if (url.origin === origin && request.method() === 'GET' && !url.pathname.startsWith('/api/')) { await route.continue(); return; }
    if (!allowedPublicRequest(app, shot.action, key)) { refused.push(key); await route.abort(); return; }
    requests.push(key);
    let body;
    if (url.pathname === '/api/zpage/') body = { count: fixture.articles.length, next: null, previous: null, results: fixture.articles };
    else if (url.pathname === '/api/zpage/why-shielded-defaults-matter/') body = fixture.articles[0];
    else if (url.pathname === '/api/comments/zpage/editorial-shielded-defaults/') body = { count: 0, next: null, previous: null, results: [] };
    else throw new Error('missing public fixture response');
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': origin }, body: JSON.stringify(body) });
  });
  await page.addInitScript(({ app, fixedTime, safeArea }) => {
    localStorage.clear(); sessionStorage.clear();
    const NativeDate = Date;
    class FixedDate extends NativeDate { constructor(...args) { super(...(args.length ? args : [Date.parse(fixedTime)])); } static now() { return NativeDate.parse(fixedTime); } }
    window.Date = FixedDate;
    for (const [edge, value] of Object.entries(safeArea)) document.documentElement.style.setProperty(`--safe-area-${edge}`, `${value}px`);
    if (app !== 'e2e2z') return;
    // Faithful unenrolled production contract, also exercised by enrollment-gap.pw.ts.
    // No mock build flag, device identity, credential, conversation or network transport.
    window.__STORE_NATIVE_CALLS__ = [];
    let callbackId = 1;
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback, once) { const id = callbackId++; Object.defineProperty(window, `_${id}`, { configurable: true, value: (...args) => { if (once) Reflect.deleteProperty(window, `_${id}`); return callback(...args); } }); return id; },
      unregisterCallback(id) { Reflect.deleteProperty(window, `_${id}`); },
      async invoke(cmd) {
        window.__STORE_NATIVE_CALLS__.push(cmd);
        if (cmd === 'plugin:f2zmsg|get_engine_status') return { state: 'stopped', enrolled: false, handle: null, relaysConnected: 0, relaysConfigured: 1, witnessThresholdMet: false, independentWitnesses: 1, pendingInbound: 0, unacknowledgedAlarms: 0, lastError: null };
        if (cmd === 'plugin:f2zmsg|get_device_info') throw 'not-enrolled';
        if (cmd === 'plugin:event|listen') return callbackId++;
        if (cmd === 'plugin:event|unlisten') return null;
        throw new Error(`Unexpected native command: ${cmd}`);
      },
    };
  }, { app, fixedTime: config.fixedTime, safeArea: target.safeArea });
  await page.goto(`${origin}${shot.route}`, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}' });
  if (app === 'free2z') {
    const heading = shot.action === 'fresh' ? 'Articles' : 'Why Shielded Defaults Matter';
    await page.getByRole('heading', { name: heading, exact: true }).first().waitFor();
    await page.getByText('Why Shielded Defaults Matter', { exact: true }).first().waitFor();
  } else {
    await page.getByText('Enrollment happens in the wallet app', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-messages-loading], [data-messages-failure]').count(), 0, 'incomplete messaging surface');
    assert.equal(await page.getByRole('navigation', { name: 'Conversations' }).count(), 0, 'fabricated conversations');
    assert.equal(await page.getByRole('heading', { name: 'Claim your handle' }).count(), 0, 'fabricated enrollment');
    if (shot.action === 'local-diagnostics') {
      await page.getByRole('button', { name: /^Diagnostics/ }).click();
      await page.locator('[data-diagnostics-empty]').waitFor();
      await page.getByRole('heading', { name: 'Diagnostics', exact: true }).scrollIntoViewIfNeeded();
    }
    const calls = await page.evaluate(() => window.__STORE_NATIVE_CALLS__);
    assert(calls.includes('plugin:f2zmsg|get_device_info') && calls.includes('plugin:f2zmsg|get_engine_status'));
    assert(calls.every((cmd) => NATIVE_CALLS.includes(cmd)), 'undeclared native call');
  }
  await page.evaluate(() => document.fonts.ready);
  assert.deepEqual(refused, [], 'unexpected network request');
  assert.deepEqual(failures, [], 'capture runtime error');
  assert.deepEqual(requests.sort(), [...(app === 'free2z' ? CAPTURE_PUBLIC_REQUESTS[shot.action] : [])].sort(), 'public request contract not exercised');
  const evidence = await page.evaluate(() => ({ text: document.body.innerText.replace(/\s+/g, ' ').trim(), overflow: document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('[data-scroll-area-viewport], .app-viewport')].some((element) => element.scrollWidth > element.clientWidth + 1) }));
  assert(!evidence.overflow, 'capture overflows');
  assert(!FORBIDDEN_TEXT.test(evidence.text), 'forbidden disclosure or identity in rendered text');
  return { page, renderedTextSha256: sha256(evidence.text) };
}
async function capturePass(app, config, digests, output, dist) {
  const server = await serverFor(dist);
  const browser = await chromium.launch({ headless: true });
  const legacyManifest = await readCanonicalJson(resolve(walletRoot, 'zuuli/store/manifest.json'), 'legacy store manifest');
  const { fixture } = await validateCaptureConfig({ root: resolve(walletRoot, 'zuuli'), screenshotSets: legacyManifest.screenshotSets, computeSource: false });
  const entries = [];
  try {
    for (const target of config.targets) for (const shot of config.shots) {
      const context = await browser.newContext({ viewport: { width: target.cssWidth, height: target.cssHeight }, deviceScaleFactor: target.deviceScaleFactor, locale: config.locale, timezoneId: config.timezone, colorScheme: config.colorScheme, reducedMotion: 'reduce', serviceWorkers: 'block' });
      try {
        const { page, renderedTextSha256 } = await preparePage(context, { app, config, target, shot, fixture, origin: server.origin });
        const raw = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'device' });
        const pixels = PNG.sync.read(raw, { checkCRC: true });
        assert.equal(pixels.width, target.cssWidth * target.deviceScaleFactor); assert.equal(pixels.height, target.cssHeight * target.deviceScaleFactor);
        const bytes = PNG.sync.write(pixels, { colorType: 2, inputColorType: 6 });
        const path = `store/media/${config.locale}/${target.setId}/${shot.id}.png`;
        await mkdir(dirname(resolve(output, path)), { recursive: true });
        await writeFile(resolve(output, path), bytes);
        entries.push({ setId: target.setId, ...shot, path, sha256: sha256(bytes), renderedTextSha256, sourceSha: config.sourceSha, sourceDigest: digests.sourceDigest, cssWidth: target.cssWidth, cssHeight: target.cssHeight, deviceScaleFactor: target.deviceScaleFactor, width: pixels.width, height: pixels.height, safeArea: target.safeArea, disclosureScan: 'passed' });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await server.close(); }
  return entries;
}
export function proveIdenticalPasses(first, second) {
  assert.deepEqual(first, second, 'two fresh capture passes differ');
  assert.equal(new Set(first.map((entry) => entry.sha256)).size, first.length, 'duplicate capture pixels');
  return { passes: 2, firstPassSha256: sha256(canonical(first)), secondPassSha256: sha256(canonical(second)) };
}
async function writeCapture(app, config, record, output, originalManifest) {
  const root = resolve(walletRoot, app);
  const temp = await mkdtemp(resolve(root, '.store-capture-'));
  try {
    const staged = resolve(temp, 'store'), backup = resolve(temp, 'backup');
    await cp(resolve(root, 'store'), staged, { recursive: true });
    await rm(resolve(staged, 'media'), { recursive: true, force: true });
    await cp(resolve(output, 'store/media'), resolve(staged, 'media'), { recursive: true });
    const manifest = JSON.parse(originalManifest);
    manifest.phase = 'captured';
    manifest.capturePolicy.status = 'captured-owner-review-required';
    manifest.capturePolicy.sourceSha = config.sourceSha;
    manifest.capturePolicy.sourceDigest = record.sourceDigest;
    manifest.capturePolicy.contractDigest = record.contractDigest;
    manifest.capturePolicy.captureConfig = 'store/capture.json';
    manifest.capturePolicy.captureRecord = 'store/capture-record.json';
    for (const set of manifest.screenshotSets) set.files = record.entries.filter((entry) => entry.setId === set.id).map(({ id, path, sha256, sourceSha }) => ({ id, path, sha256, sourceSha, reviewIssue: 989 }));
    await writeFile(resolve(staged, 'manifest.json'), canonical(manifest));
    await writeFile(resolve(staged, 'capture-record.json'), canonical(record));
    assert.equal(await readFile(resolve(root, 'store/manifest.json'), 'utf8'), originalManifest, 'manifest changed during capture');
    // A single directory transaction keeps manifest, record and pixels together.
    renameSync(resolve(root, 'store'), backup);
    try { renameSync(staged, resolve(root, 'store')); } catch (error) { renameSync(backup, resolve(root, 'store')); throw error; }
  } finally { await rm(temp, { recursive: true, force: true }); }
}
export async function main(argv = process.argv.slice(2)) {
  const [app, mode] = argv;
  assert(argv.length === 2 && Object.hasOwn(SHOTS, app) && ['--write', '--verify-reproducible'].includes(mode), 'usage: surface-store-capture.mjs free2z|e2e2z --write|--verify-reproducible');
  const config = await validateSurfaceCaptureConfig(app);
  const manifestPath = resolve(walletRoot, app, 'store/manifest.json');
  const originalManifest = await readFile(manifestPath, 'utf8');
  const digests = await captureDigests(app);
  await assertCaptureEnvironment(app);
  if (process.env.SURFACE_STORE_CAPTURE_WORKER !== '1') {
    await assertSourceCommit(app, config.sourceSha);
    assert(typeof process.getuid === 'function', 'capture requires Docker on macOS or Linux');
    const install = `node -e 'require("fs").writeFileSync(process.env.NPM_CONFIG_USERCONFIG, "");require("fs").writeFileSync(process.env.NPM_CONFIG_GLOBALCONFIG, "")' && npm ${CAPTURE_NPM_CI_ARGUMENTS.join(' ')} --prefix /work/zuuli && npm ${CAPTURE_NPM_CI_ARGUMENTS.join(' ')} --prefix /work/${app} && node /work/zuuli/scripts/surface-store-capture.mjs ${app} ${mode}`;
    await command('docker', ['run', '--rm', '--platform', BROWSER.platform, '--ipc=host', '--env', 'CI=1', '--env', 'SURFACE_STORE_CAPTURE_WORKER=1', '--env', `SURFACE_STORE_EXPECTED_DIGESTS=${JSON.stringify(digests)}`, ...Object.entries(CAPTURE_NPM_ENVIRONMENT).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--volume', `${walletRoot}:/work`, '--volume', '/work/zuuli/node_modules', '--volume', `/work/${app}/node_modules`, '--workdir', '/work', BROWSER.containerImage, 'bash', '-c', install]);
    assert.deepEqual(await captureDigests(app), digests, 'capture inputs changed');
    await assertSourceCommit(app, config.sourceSha);
    await assertCaptureEnvironment(app);
    await validateSurfaceCaptureRecord(app, { enforceCurrentSource: true });
    return;
  }
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); await access('/.dockerenv');
  assert(chromium.executablePath().startsWith('/ms-playwright/'), 'browser must come from pinned image');
  assert.deepEqual(digests, JSON.parse(process.env.SURFACE_STORE_EXPECTED_DIGESTS ?? 'null'), 'host/worker digest mismatch');
  for (const key of Object.keys(process.env)) if (key.startsWith('VITE_')) delete process.env[key];
  await command('npm', ['run', 'build'], resolve(walletRoot, app));
  assert.deepEqual(await captureDigests(app), digests, 'build changed inputs');
  const temp = await mkdtemp(resolve(tmpdir(), 'surface-capture-'));
  try {
    const first = await capturePass(app, config, digests, resolve(temp, 'first'), resolve(walletRoot, app, 'dist'));
    const second = await capturePass(app, config, digests, resolve(temp, 'second'), resolve(walletRoot, app, 'dist'));
    const record = { schemaVersion: 1, app, sourceSha: config.sourceSha, ...digests, fixtureProfile: config.fixtureProfile, locale: config.locale, fixedTime: config.fixedTime, browser: config.browser, entries: first, reproducibility: proveIdenticalPasses(first, second) };
    validateRecordMatrix(config, record, digests);
    assert.deepEqual(await captureDigests(app), digests, 'capture changed inputs');
    await assertCaptureEnvironment(app);
    if (mode === '--write') await writeCapture(app, config, record, resolve(temp, 'first'), originalManifest);
    else {
      const committed = await readCanonicalJson(resolve(walletRoot, app, 'store/capture-record.json'), 'capture record');
      assert.deepEqual(committed, record, 'committed capture differs from two fresh passes');
      for (const entry of first) assert.equal(sha256(await readFile(resolve(walletRoot, app, entry.path))), entry.sha256);
    }
    process.stdout.write(`${app}: ${first.length} screenshots, two identical passes\n`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
