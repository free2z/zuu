import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

//  the billing page opens on Zcash. `?tab=stripe` and its alias
// `?tab=card` pick card, `?tab=zcash` picks Zcash, and anything else is no
// choice (the page may then fall back to Card when Zcash is unavailable).

let vite;
let requestedPaymentTab;

before(async () => {
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  ({ requestedPaymentTab } = await vite.ssrLoadModule(
    "/src/lib/billing-payment-tab.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const at = (search) =>
  new URL(`https://free2z.test/alice/dashboard/billing${search}`);

test("explicit tabs", () => {
  assert.equal(requestedPaymentTab(at("?tab=stripe")), "stripe");
  assert.equal(requestedPaymentTab(at("?tab=card")), "stripe");
  assert.equal(requestedPaymentTab(at("?tab=zcash")), "zcash");
});

test("no tab, or one we do not know, is no choice", () => {
  assert.equal(requestedPaymentTab(at("")), null);
  assert.equal(requestedPaymentTab(at("?tab=")), null);
  assert.equal(requestedPaymentTab(at("?tab=Stripe")), null);
  assert.equal(requestedPaymentTab(at("?tab=paypal")), null);
  assert.equal(requestedPaymentTab(at("?section=history")), null);
});
