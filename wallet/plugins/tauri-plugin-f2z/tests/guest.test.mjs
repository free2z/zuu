import test from 'node:test';
import assert from 'node:assert/strict';
const sent = [];
let rejectWith;
globalThis.window = { __TAURI_INTERNALS__: { invoke: async (...args) => {
  sent.push(args);
  if (rejectWith) { const e = rejectWith; rejectWith = undefined; throw e; }
  return null;
} } };
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

test('sign-in rejection codes reach the app unchanged', async () => {
  for (const code of ['user_cancelled', 'browser_unavailable', 'timeout', 'browser_error']) {
    rejectWith = { code, retryable: false };
    await assert.rejects(nativeBridge.signIn(), (e) => e.code === code && e.retryable === false);
    assert.equal(sent.at(-1)[0], 'plugin:f2z|sign_in');
  }
});
