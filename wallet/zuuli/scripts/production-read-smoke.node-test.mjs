import assert from 'node:assert/strict';
import test from 'node:test';
import { runProductionReadSmoke } from './production-read-smoke.mjs';

function validBody(url) {
  const path = new URL(url).pathname;
  if (path.endsWith('/providers/')) return { providers: ['x', 'google', 'github'].map(provider => ({ provider, configured: false })) };
  if (path === '/api/pricing/') return { zec_usd: '25', tuzis_per_zec: '2500', stale: false };
  if (path === '/api/pricing/quote/') return { tuzis: 100, zec_amount: '0.04', card_cents: 205, stale: false };
  return { count: 0, next: null, results: [] };
}
const jsonResponse = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

async function exercise(first) {
  const calls = [];
  const errors = [];
  const passed = await runProductionReadSmoke({
    timeoutMs: 10,
    log: () => {}, errorLog: message => errors.push(message),
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (calls.length === 1 && first) return first(options);
      return jsonResponse(validBody(url));
    },
  });
  return { passed, calls, errors };
}

test('only anonymous fixed-origin GETs are issued, with no redirect following', async () => {
  const { passed, calls } = await exercise();
  assert.equal(passed, true);
  assert.equal(calls.length, 8);
  for (const [url, options] of calls) {
    assert.equal(new URL(url).origin, 'https://free2z.cash');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    assert.equal(options.body, undefined);
  }
});

for (const [name, first] of [
  ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://other.example/' } })],
  ['non-200', () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })],
  ['wrong content type', () => new Response('{}', { status: 200, headers: { 'content-type': 'text/html' } })],
  ['invalid JSON', () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } })],
  ['wrong shape', () => jsonResponse({ results: {} })],
  ['network error', () => { throw new Error('network unavailable'); }],
  ['timeout', ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))],
]) {
  test(`fails on ${name}`, async () => {
    const { passed, errors } = await exercise(first);
    assert.equal(passed, false);
    assert.equal(errors.length, 1);
  });
}


test('each endpoint rejects a malformed success response', async () => {
  for (let corrupt = 0; corrupt < 8; corrupt++) {
    let index = 0;
    const errors = [];
    const passed = await runProductionReadSmoke({
      origin: 'https://untrusted.example', log: () => {}, errorLog: message => errors.push(message),
      fetchImpl: async (url) => {
        assert.equal(new URL(url).origin, 'https://free2z.cash');
        return jsonResponse(index++ === corrupt ? {} : validBody(url));
      },
    });
    assert.equal(passed, false, `endpoint ${corrupt}`);
    assert.equal(errors.length, 1);
  }
});
