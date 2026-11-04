//  -- the ZEC product boundary. ZEC goes (a) directly to a creator, or
// (b) to Free2Z only to buy 2Z. Boosts and comments are 2Z actions.
//
// The direct-support dialog used to attach `{"act":"page_fund","id":<uuid>}`
// to a payment addressed to the CREATOR's wallet: a legacy instruction that
// only ever meant something to a Free2Z-controlled wallet, riding on a
// peer-to-peer payment Free2Z never sees. It also ignored the zPage's
// effective `p2paddr`, so a page routing support to a campaign wallet would
// have paid the profile wallet instead. Both are real-money routing defects.
//
// Two layers here:
//   1. the URI builder itself -- decode what a wallet would receive and check
//      recipient, amount, memo, byte limits, Unicode and transparent
//      addresses;
//   2. a source invariant on the dialog -- no internal intent JSON can be
//      attached to a direct-support recipient, and zPage support pays the
//      page's effective address.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ZCASH_MEMO_MAX_BYTES,
  addressAcceptsMemo,
  buildDirectSupportUri,
  defaultSupportMemo,
  memoByteLength,
  normalizeZecAmount,
  parseZcashUri,
  truncateToBytes,
} from "../src/lib/zcash-support-uri.ts";

const root = new URL("../", import.meta.url);
const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, root)), "utf8");

const PAGE_ADDRESS =
  "u1supportpage0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
const CREATOR_ADDRESS =
  "zs1creatorprofile000000000000000000000000000000000000000000000000000000000";
const TRANSPARENT = "t1KbeGmXH8Rc4qEeTU1fgjF5HqjgtxdSTE";

test("direct support carries the recipient, the amount and the memo -- nothing else", () => {
  const built = buildDirectSupportUri({
    address: PAGE_ADDRESS,
    amount: "0.25",
    memo: "Thanks for the article",
  });
  const parsed = parseZcashUri(built.uri);
  assert.equal(parsed.address, PAGE_ADDRESS);
  assert.equal(parsed.amount, "0.25");
  assert.equal(parsed.memo, "Thanks for the article");
  assert.deepEqual(Object.keys(parsed.params).sort(), ["amount", "memo"]);
  assert.doesNotMatch(parsed.memo, /page_fund|"act"|"id"/);
});

test("clearing the memo omits the memo parameter entirely", () => {
  for (const memo of ["", null, undefined]) {
    const built = buildDirectSupportUri({ address: PAGE_ADDRESS, memo });
    assert.equal(built.uri, `zcash:${PAGE_ADDRESS}`);
    assert.equal(built.memo, null);
    assert.equal(parseZcashUri(built.uri).memo, null);
  }
  const withAmount = buildDirectSupportUri({
    address: PAGE_ADDRESS,
    amount: "1",
    memo: "",
  });
  assert.equal(withAmount.uri, `zcash:${PAGE_ADDRESS}?amount=1`);
});

test("a transparent recipient never receives a memo-bearing request", () => {
  const built = buildDirectSupportUri({
    address: TRANSPARENT,
    amount: "0.5",
    memo: "this must not be attached",
  });
  assert.equal(built.memoUnsupported, true);
  assert.equal(built.memo, null);
  assert.equal(built.uri, `zcash:${TRANSPARENT}?amount=0.5`);
  assert.equal(addressAcceptsMemo(TRANSPARENT), false);
  assert.equal(addressAcceptsMemo("tex1qabc"), false);
  assert.equal(addressAcceptsMemo(CREATOR_ADDRESS), true);
  assert.equal(addressAcceptsMemo(PAGE_ADDRESS), true);
});

test("memo bytes are counted in UTF-8, not JavaScript characters", () => {
  // 170 emoji = 170 JS "characters" by codepoint (340 UTF-16 units) but
  // 680 bytes: a character-count check would let this through and the wallet
  // would refuse or truncate the memo.
  const emoji = "🎉".repeat(170);
  assert.equal(emoji.length, 340);
  assert.equal(memoByteLength(emoji), 680);
  const built = buildDirectSupportUri({ address: PAGE_ADDRESS, memo: emoji });
  assert.equal(built.memoTooLong, true);
  assert.equal(built.uri, "", "no URI may be produced for an oversize memo");

  // Exactly at the limit is fine; one byte over is not.
  const atLimit = "é".repeat(ZCASH_MEMO_MAX_BYTES / 2);
  assert.equal(memoByteLength(atLimit), ZCASH_MEMO_MAX_BYTES);
  assert.equal(
    buildDirectSupportUri({ address: PAGE_ADDRESS, memo: atLimit }).memoTooLong,
    false,
  );
  assert.equal(
    buildDirectSupportUri({ address: PAGE_ADDRESS, memo: atLimit + "a" })
      .memoTooLong,
    true,
  );
});

test("Unicode memos round-trip through base64url intact", () => {
  const memo = "¡Gracias! 谢谢 — “quotes” 🎉";
  const built = buildDirectSupportUri({ address: CREATOR_ADDRESS, memo });
  assert.equal(parseZcashUri(built.uri).memo, memo);
  // base64url only: no `+`, `/` or `=` may appear in the memo parameter.
  assert.doesNotMatch(built.uri.split("memo=")[1], /[+/=]/);
});

test("the default zPage memo is the localized title, short and human-readable", () => {
  assert.equal(
    defaultSupportMemo("  Why   Zcash\n matters  "),
    "Why Zcash matters",
  );
  assert.equal(defaultSupportMemo(""), "");
  assert.equal(defaultSupportMemo(null), "");
  assert.equal(defaultSupportMemo(undefined), "");
  // A pathological title is bounded by bytes and never splits a code point.
  const long = "🎉".repeat(400);
  const memo = defaultSupportMemo(long);
  assert.ok(memoByteLength(memo) <= 200);
  assert.equal(memoByteLength(memo) % 4, 0, "no half emoji");
  assert.equal(truncateToBytes("aé", 2), "a");
});

test("amounts stay ZIP 321 decimal text -- never exponent notation", () => {
  assert.equal(normalizeZecAmount("0.00000001"), "0.00000001");
  // A JS number (a `type="number"` binding) is rendered with all eight
  // places: `String(1e-8)` would otherwise reach the regex as exponent text.
  assert.equal(normalizeZecAmount(0.00000001), "0.00000001");
  assert.equal(normalizeZecAmount(0.25), "0.25");
  assert.equal(normalizeZecAmount(Number.NaN), null);
  assert.equal(normalizeZecAmount("1.50000000"), "1.5");
  assert.equal(normalizeZecAmount("007"), "7");
  // Mid-typing shapes are canonicalised, not flagged per keystroke.
  assert.equal(normalizeZecAmount(".5"), "0.5");
  assert.equal(normalizeZecAmount("1."), "1");
  assert.equal(normalizeZecAmount("."), null);
  assert.equal(normalizeZecAmount(".123456789"), null, "more than 8 places");
  assert.equal(normalizeZecAmount("0"), null);
  assert.equal(normalizeZecAmount("0.0"), null);
  assert.equal(normalizeZecAmount("-1"), null);
  assert.equal(normalizeZecAmount("1.123456789"), null, "more than 8 places");
  assert.equal(normalizeZecAmount(""), null);
  assert.equal(normalizeZecAmount("abc"), null);
  const parsed = parseZcashUri(
    buildDirectSupportUri({ address: PAGE_ADDRESS, amount: "0.00000001" }).uri,
  );
  assert.equal(parsed.amount, "0.00000001");
});

test("a populated but invalid amount produces no URI -- never an unspecified-amount handoff", () => {
  // codex adversarial review: an entered amount the builder cannot represent
  // must not silently vanish into an enabled, amount-less payment link.
  for (const amount of [
    "abc",
    "-1",
    "1.123456789",
    "1e-8",
    "0,25",
    ".",
    "0.",
  ]) {
    const built = buildDirectSupportUri({ address: PAGE_ADDRESS, amount });
    assert.equal(built.amountInvalid, true, amount);
    assert.equal(built.uri, "", amount);
  }
  // A keystroke ending in a dot is not an error: `.5` and `1.` build a URI.
  assert.equal(
    buildDirectSupportUri({ address: PAGE_ADDRESS, amount: ".5" }).uri,
    `zcash:${PAGE_ADDRESS}?amount=0.5`,
  );
  assert.equal(
    buildDirectSupportUri({ address: PAGE_ADDRESS, amount: "1." }).uri,
    `zcash:${PAGE_ADDRESS}?amount=1`,
  );
  // Blank is a choice, not an error: the wallet asks for the amount.
  for (const amount of ["", "   ", null, undefined]) {
    const built = buildDirectSupportUri({ address: PAGE_ADDRESS, amount });
    assert.equal(built.amountInvalid, false);
    assert.equal(built.uri, `zcash:${PAGE_ADDRESS}`);
  }
});

test("the dialog keeps the amount as decimal text, not a number input", () => {
  const source = read("src/lib/components/profile/ProfileDonate.svelte");
  const amountInput = /id="zec-support-amount"[\s\S]*?\/>/.exec(source)?.[0];
  assert.ok(amountInput, "amount input present");
  assert.match(amountInput, /type="text"/);
  assert.match(amountInput, /inputmode="decimal"/);
  assert.doesNotMatch(amountInput, /type="number"/);
});

test("no address, no URI", () => {
  assert.equal(buildDirectSupportUri({ address: "", memo: "x" }).uri, "");
  assert.equal(buildDirectSupportUri({ address: "   " }).uri, "");
});

// --- Source invariants on the dialog ---------------------------------------

test("direct support never attaches page_fund or any internal intent JSON", () => {
  const source = read("src/lib/components/profile/ProfileDonate.svelte");
  assert.doesNotMatch(source, /page_fund/);
  assert.doesNotMatch(source, /act\s*:/);
  assert.doesNotMatch(
    source,
    /JSON\.stringify\([^)]*(?:pageId|free2zaddr)/,
    "a page id must never be serialized into a payment memo",
  );
  // The one reviewed builder is the only way a `zcash:` URI is produced.
  assert.doesNotMatch(source, /`zcash:/);
  assert.match(source, /buildDirectSupportUri\(/);
});

test("zPage support pays the page's effective address, profile support the creator's", () => {
  const dialog = read("src/lib/components/profile/ProfileDonate.svelte");
  assert.match(
    dialog,
    /pageId\s*\?\s*pageAddress\s*\|\|\s*creator\?\.p2paddr\s*:\s*creator\?\.p2paddr/,
  );
  const actions = read("src/lib/components/zpageActions/PageActions.svelte");
  assert.match(actions, /pageAddress=\{article\?\.p2paddr\}/);
});

test("the buy-2Z flow is the only place a structured memo is built", () => {
  // The billing dashboard sends ZEC to a Free2Z-controlled address with the
  // REQUIRED buy_2z attribution. That is a Free2Z purchase and must stay
  // distinct from direct support: it is the only source file allowed to
  // serialize an intent into a memo.
  const billing = read("src/routes/[username]/dashboard/billing/+page.svelte");
  assert.match(billing, /buy_2z/);
  const dialog = read("src/lib/components/profile/ProfileDonate.svelte");
  assert.doesNotMatch(dialog, /buy_2z/);
});
