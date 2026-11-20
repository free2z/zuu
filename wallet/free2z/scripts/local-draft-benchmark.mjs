// Explicit, synthetic-only local evaluation. No provider calls or policy writes.
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

if (!process.argv.includes('--run')) throw new Error('Use --run to consent to the pinned 202.59 MiB model download. Optional --software-adapter is VM validation only.');
const base = process.env.LOCAL_DRAFT_URL ?? 'http://127.0.0.1:1445';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Benchmark only accepts a localhost evaluation server');
const outputFile = process.env.LOCAL_DRAFT_REPORT ?? '/tmp/free2z-local-draft-benchmark.json';
const software = process.argv.includes('--software-adapter');
const browser = await chromium.launch({ headless: true, args: software
  ? ['--enable-unsafe-webgpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'] : [] });
const context = await browser.newContext();
const page = await context.newPage();
const result = { date: new Date().toISOString(), browser: browser.version(), softwareAdapterFlags: software,
  physicalGPU: 'NOT ESTABLISHED', runs: [], requests: [], memory: [], statuses: [], errors: [] };
const cacheName = 'free2z-local-draft-smollm2-360m-v1';
const session = await browser.newBrowserCDPSession();
async function memory(label) {
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  let sum = 0;
  for (const process of processInfo) {
    try { const text = await readFile(`/proc/${process.id}/status`, 'utf8'); sum += Number(/VmRSS:\s+(\d+)/.exec(text)?.[1] ?? 0); } catch { /* exited */ }
  }
  result.memory.push({ label, summedProcessRssKiB: sum, limitation: 'Linux snapshots, shared pages double-counted; not a peak or GPU allocation measure' });
}
page.on('request', (request) => {
  const url = new URL(request.url());
  result.requests.push({ url: url.origin + url.pathname, method: request.method(), body: request.postData() });
});
page.on('pageerror', (error) => result.errors.push({ name: error.name, message: error.message }));
// Only policy is locally enabled. No artifact/runtime/adapter/generation mocks.
await page.route('**/local-draft-policy.json', (route) => route.fulfill({ json: { version: 1, enabled: true } }));
// Never contact a live API, even if a regression unexpectedly enters server code.
await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { detail: 'Synthetic benchmark: live API blocked' } }));
const status = () => page.getByRole('status').textContent();
const waitStatus = async (pattern, timeout = 120_000) => {
  await page.waitForFunction((source) => new RegExp(source).test(document.querySelector('[role=status]')?.textContent ?? ''), pattern, { timeout, polling: 100 });
  return status();
};
try {
  await page.goto(`${base}/local-draft.html`);
  await memory('page before probe');
  await page.getByRole('button', { name: 'Check WebGPU support' }).click();
  result.capability = await waitStatus('Device creation succeeded|No WebGPU|WebGPU unavailable|failed|unsupported|removed');
  if (!result.capability.includes('Device creation succeeded')) {
    result.outcome = 'UNSUPPORTED; no download/generation attempted';
  } else {
    await page.exposeFunction('recordStatus', (text) => result.statuses.push({ at: Date.now(), text }));
    await page.evaluate(() => new MutationObserver(() => window.recordStatus(document.querySelector('[role=status]').textContent)).observe(document.querySelector('[role=status]'), { childList: true, subtree: true, characterData: true }));
    await page.getByRole('button', { name: 'Opt in: download or load model' }).click();
    result.coldStatus = await waitStatus('Ready[.]|failed|mismatch|exceeds|removed|lost', 610_000);
    result.coldTiming = await page.getByLabel('Local timing measurements').textContent();
    await memory('after cold load');
    if (!result.coldStatus.startsWith('Ready.')) throw new Error('Real model load failed');
    result.storage = await page.evaluate(() => navigator.storage.estimate());
    await page.getByRole('button', { name: 'Cancel and release runtime' }).click();
    await page.getByRole('button', { name: 'Check WebGPU support' }).click();
    await page.getByRole('button', { name: 'Opt in: download or load model' }).click();
    result.warmStatus = await waitStatus('Ready[.]|failed|removed|lost', 180_000);
    result.warmTiming = await page.getByLabel('Local timing measurements').textContent();
    await memory('after warm load');
    const corpus = [
      'Write one sentence thanking a volunteer for planting trees.',
      'Summarize in one sentence: The library opens at nine. It closes at five. It is closed on Sunday.',
      'Rewrite politely: I cannot attend the meeting tomorrow.',
    ];
    for (const prompt of process.argv.includes("--controls-only") ? [] : corpus) {
      await page.getByLabel('Local draft prompt', { exact: false }).fill(prompt);
      const start = Date.now();
      await page.getByRole('button', { name: 'Generate on this device' }).click();
      const state = await waitStatus('Draft finished|failed|removed', 130_000);
      result.runs.push({ prompt, status: state, wallMs: Date.now() - start,
        output: await page.getByRole('region', { name: 'Local draft output' }).textContent(),
        timing: await page.getByLabel('Local timing measurements').textContent() });
      await memory(`after corpus item ${result.runs.length}`);
      if (!state.startsWith('Draft finished')) throw new Error('Real generation did not complete');
    }
    // Real CacheStorage eviction, no simulated worker.
    await page.getByLabel('Local draft prompt', { exact: false }).fill('Synthetic cache eviction privacy canary 1295');
    await page.evaluate((name) => caches.delete(name), cacheName);
    await page.getByRole('button', { name: 'Generate on this device' }).click();
    result.cacheLoss = await waitStatus('cache lost|failed|removed');
    await page.getByRole('button', { name: 'Check WebGPU support' }).click();
    await page.getByRole('button', { name: 'Opt in: download or load model' }).click();
    await page.waitForFunction(async (name) => (await (await caches.open(name)).keys()).length > 0, cacheName, { polling: 100 });
    const cancelStarted = Date.now();
    await page.getByRole('button', { name: 'Cancel and release runtime' }).click();
    const cancelledStatus = await waitStatus('cache removed|removal failed');
    result.downloadCancellation = { wallMs: Date.now() - cancelStarted, status: cancelledStatus,
      cacheRemains: await page.evaluate((name) => caches.has(name), cacheName), workersRemaining: page.workers().length };
    result.outcome = process.argv.includes('--controls-only') ? 'Real cache loss and public-download cancellation executed; no generation claim'
      : 'Real generation executed; physical device acceptance remains OPEN';
  }
  const beforeFallback = result.requests.length;
  await page.getByRole('link', { name: 'Switch to server completion' }).click();
  await page.waitForURL('**/ai');
  await page.getByRole('heading', { name: 'AI Studio' }).waitFor();
  result.fallback = { url: page.url(), prompt: await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(),
    requests: result.requests.slice(beforeFallback) };
  if (result.requests.some((r) => r.method !== 'GET')) throw new Error('Unexpected non-GET request');
} catch (error) {
  result.failure = String(error);
  try { result.lastStatus = await status(); result.partialOutput = await page.getByRole('region', { name: 'Local draft output' }).textContent(); } catch { /* page terminated */ }
}
finally {
  result.heat = 'NOT MEASURABLE on VM'; result.battery = 'NOT MEASURABLE on VM';
  await context.close(); await browser.close();
  await writeFile(outputFile, JSON.stringify(result, null, 2) + '\n');
  console.log(outputFile, result.failure ?? result.outcome);
  if (result.requests.some((request) => request.method !== 'GET')) process.exitCode = 1;
}
