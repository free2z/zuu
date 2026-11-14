// Opt-in, anonymous GETs only. Never follow redirects or accept an override
// origin: the checked URLs are the production API configured by both apps.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const origin = 'https://free2z.cash';
const page = (v) => Number.isInteger(v?.count) && v.count >= 0 && Array.isArray(v.results) && (v.next === null || typeof v.next === 'string');
const providers = (v) => Array.isArray(v?.providers) && ['x', 'google', 'github'].every((name) => v.providers.filter((p) => p.provider === name && typeof p.configured === 'boolean').length === 1);
const numberString = (v) => typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) > 0;
const checks = [
  ['/api/zpage/?page=1&page_size=1&homeSort=popular', page],
  ['/api/creator/?page_size=1&homeSort=random', page],
  ['/api/ai/models/?page_size=1', page],
  ['/api/dyte/public/?page_size=1', page],
  ['/api/pricing/', (v) => numberString(v?.zec_usd) && numberString(v?.tuzis_per_zec) && typeof v.stale === 'boolean'],
  ['/api/pricing/quote/?tuzis=100', (v) => v?.tuzis === 100 && numberString(v.zec_amount) && Number.isInteger(v.card_cents) && v.card_cents > 0 && typeof v.stale === 'boolean'],
  ['/api/auth/social/providers/', providers],
  ['/api/auth/social/mobile/providers/', providers],
];
export async function runProductionReadSmoke({ fetchImpl = fetch, timeoutMs = 15000, log = console.log, errorLog = console.error } = {}) {
  let failed = false;
  for (const [path, validate] of checks) {
    try {
      const response = await fetchImpl(origin + path, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      assert.equal(response.status, 200, `HTTP ${response.status}`);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i);
      const body = await response.json();
      assert.ok(validate(body), 'unexpected response shape');
      const detail = path.includes('/providers/') ? ` ${body.providers.map(({provider, configured}) => `${provider}=${configured}`).join(' ')}` : '';
      log(`${new Date().toISOString()} PASS ${path}${detail}`);
    } catch (error) {
      failed = true;
      errorLog(`${new Date().toISOString()} FAIL ${path}: ${error.message}`);
    }
  }
  return !failed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!await runProductionReadSmoke()) process.exitCode = 1;
}
