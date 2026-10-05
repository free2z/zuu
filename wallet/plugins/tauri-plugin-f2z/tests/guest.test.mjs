import test from 'node:test';
import assert from 'node:assert/strict';
const sent = [];
globalThis.window = { __TAURI_INTERNALS__: { invoke: async (...args) => { sent.push(args); return null; } } };
const { nativeBridge } = await import('../dist/index.js');
test('caller keys and exact quantities reach native unchanged', async () => {
  await nativeBridge.createPurchase({ rail: 'zcash', quantity2z: '18446744073709551615', idempotencyKey: 'known-before-invoke' });
  assert.deepEqual(sent.pop(), ['plugin:f2z|create_purchase', { request: { rail: 'zcash', quantity2z: '18446744073709551615', idempotencyKey: 'known-before-invoke' } }, undefined]);
  await nativeBridge.startChat({ model: 'x', messages: [], max_output_tokens: '9007199254740993' }, { operationId: 'op', idempotencyKey: 'key' });
  assert.equal(sent.at(-1)[1].request.max_output_tokens, '9007199254740993');
  assert.deepEqual(sent.at(-1)[1].operation, { operationId: 'op', idempotencyKey: 'key' });
});
test('pull and cancel address only their caller-owned operation', async () => {
  await nativeBridge.nextChat('op');
  assert.equal(sent.at(-1)[0], 'plugin:f2z|next_chat');
  await nativeBridge.cancelChat('op');
  assert.deepEqual(sent.at(-1)[1], { operationId: 'op' });
});
test('guest exports no token, raw request or URL callback method', () => {
  assert.deepEqual(Object.keys(nativeBridge).sort(), ['balance','call','cancelChat','createPurchase','estimate','grant','models','nextChat','openCheckout','purchase','session','signIn','signOut','startChat','waitForCall','waitForPurchase'].sort());
});

test('grant proof invokes only the bearer-bound native command', async () => {
  await nativeBridge.grant();
  assert.deepEqual(sent.pop(), ['plugin:f2z|grant', {}, undefined]);
});

test('models returns the native catalogue unchanged: booleans stay booleans, amounts stay decimals', async () => {
  const catalogue = { catalog_version: '7', includes_markup_bps: '0', models: [{
    id: 'gpt-4o', provider: 'openai', display_name: null, context_window: '128000', max_output_tokens: '16384',
    capabilities: { vision: false, tools: false, reasoning: false, structured_output: true },
    prices: { input_milli_2z_per_mtok: '300000' }, min_charge_2z: '1', ttfb_timeout_ms: '60000',
  }] };
  const internals = globalThis.window.__TAURI_INTERNALS__, original = internals.invoke;
  internals.invoke = async (...args) => { sent.push(args); return catalogue; };
  try {
    const result = await nativeBridge.models();
    assert.deepEqual(sent.pop(), ['plugin:f2z|models', {}, undefined]);
    assert.equal(result.models[0].capabilities.structured_output, true);
    assert.equal(result.models[0].prices.input_milli_2z_per_mtok, '300000');
  } finally { internals.invoke = original; }
});
