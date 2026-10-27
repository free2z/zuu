// Regression guards for  /  /.
//
// These are source assertions, not DOM tests: the failure mode they protect
// against is a control silently reverting to a truncating single-line input, or
// the markdown container losing its wrap rule. Both are one-line edits that no
// other test would notice, and both hide part of a Zcash address — a payout
// address you cannot read end to end cannot be verified, and a wrong one is
// unrecoverable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let sanitizeZcashAddressInput;
let truncateZcashAddress;
let formatZcashAddressForDisplay;
let reactTruncateZcashAddress;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: {
      middlewareMode: true,
      // The legacy CRA app is a sibling package; loading its helper from this
      // Vite root needs it explicitly allowed.
      fs: {
        allow: [
          fileURLToPath(new URL("..", import.meta.url)),
          fileURLToPath(new URL("../../../react/free2z", import.meta.url)),
        ],
      },
    },
  });
  ({ sanitizeZcashAddressInput, truncateZcashAddress } =
    await server.ssrLoadModule("/src/lib/utils/zcashAddress.ts"));
  // The legacy CRA app lives outside this Vite root, so it is loaded by path.
  ({
    formatZcashAddressForDisplay,
    truncateZcashAddress: reactTruncateZcashAddress,
  } = await server.ssrLoadModule(
    fileURLToPath(
      new URL(
        "../../../react/free2z/src/utils/zcashAddress.ts",
        import.meta.url,
      ),
    ),
  ));
});

after(async () => {
  await server?.close();
});

const read = (relative) =>
  readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );

const SETTINGS = "src/routes/[username]/dashboard/settings/+page.svelte";
const PUBLISH_SHEET = "src/lib/components/mdEditor/PublishSheet.svelte";
const MARKDOWN_CONTENT = "src/lib/components/MarkdownContent.svelte";
const COPYABLE_VALUE = "src/lib/components/CopyableValue.svelte";
const QR_CODE = "src/lib/components/MarkdownQrCode.svelte";

test("#598: the payout address field wraps instead of truncating", () => {
  const source = read(SETTINGS);

  // The control bound to p2paddr is a Textarea, never an <Input>.
  assert.match(
    source,
    /<Textarea[\s\S]*?id="zcash"[\s\S]*?bind:value=\{p2paddr\}/,
  );
  assert.doesNotMatch(source, /<Input[^>]*bind:value=\{p2paddr\}/);
  //...and it actually breaks the unbroken string.
  assert.match(source, /id="zcash"[\s\S]*?break-all/);
});

const CLEAN_ADDRESS =
  "u18vffksp4zjra0c8aqzyxvvhmxqmr2rk8j7x9m2q0lhq3wgs6tqk9v4zn7l3xd8fpq5j2m6c0rtyv9wq8hn3lz7kx4mv2p6gd9sr0tqy5h";

test("#598: a paste carrying whitespace never reaches the payout address", () => {
  // A paste out of a wrapped block carries newlines mid-string, so trimming
  // only the ends is not enough.
  const wrapped = `${CLEAN_ADDRESS.slice(0, 40)}\n  ${CLEAN_ADDRESS.slice(40)}\n`;
  assert.equal(sanitizeZcashAddressInput(wrapped), CLEAN_ADDRESS);
  assert.equal(
    sanitizeZcashAddressInput(` \t${CLEAN_ADDRESS}\r\n`),
    CLEAN_ADDRESS,
  );
});

test("#598: ZERO-WIDTH characters never reach the payout address", () => {
  // The dangerous case, and the reason `\s` is not good enough: JavaScript's
  // \s matches none of these. A zero-width character surviving into a stored
  // address is invisible in the UI — the address looks right and is wrong, and
  // the funds are unrecoverable.
  // The five that JS `\s` genuinely misses. U+FEFF is the exception — it *is*
  // in JS's \s class — so it is exercised below but not claimed here.
  const invisibleToWhitespaceStrip = [
    "\u200b", // ZERO WIDTH SPACE
    "\u200c", // ZERO WIDTH NON-JOINER
    "\u200d", // ZERO WIDTH JOINER
    "\u2060", // WORD JOINER
    "\u180e", // MONGOLIAN VOWEL SEPARATOR
  ];

  for (const char of invisibleToWhitespaceStrip) {
    // Prove the premise: this is exactly what a whitespace-only strip missed.
    assert.equal(
      char.replace(/\s+/g, "").length,
      1,
      `\\s must not match ${escape(char)} — that is why this test exists`,
    );
  }

  for (const char of [...invisibleToWhitespaceStrip, "\ufeff"]) {
    const poisoned =
      CLEAN_ADDRESS.slice(0, 50) + char + CLEAN_ADDRESS.slice(50);
    assert.notEqual(poisoned, CLEAN_ADDRESS);
    assert.equal(
      sanitizeZcashAddressInput(poisoned),
      CLEAN_ADDRESS,
      `${escape(char)} survived sanitization`,
    );
  }
});

test("#598: non-ASCII lookalikes and control characters are stripped too", () => {
  assert.equal(
    sanitizeZcashAddressInput(`${CLEAN_ADDRESS}\u00a0`),
    CLEAN_ADDRESS,
  );
  assert.equal(sanitizeZcashAddressInput(`u\u200b1\u0000`), "u1");
  // A legitimate address is returned untouched.
  assert.equal(sanitizeZcashAddressInput(CLEAN_ADDRESS), CLEAN_ADDRESS);
});

test("#598: both address inputs go through the shared sanitizer", () => {
  for (const file of [SETTINGS, PUBLISH_SHEET]) {
    const source = read(file);
    assert.match(source, /sanitizeZcashAddressInput\(target\.value\)/);
    // No hand-rolled whitespace-only strip may creep back in.
    assert.doesNotMatch(source, /replace\(\/\\s\+\/g, ['"]{2}\)/);
  }
  // The saved payload is sanitized too, not merely trimmed: a programmatic set
  // or an autofill never runs the keystroke handler.
  assert.match(read(SETTINGS), /p2paddr: sanitizeZcashAddressInput\(p2paddr\)/);
});

test("#598: the publish-flow address override wraps too", () => {
  const source = read(PUBLISH_SHEET);
  assert.match(source, /<Textarea[\s\S]*?id="zcash-address"/);
  assert.doesNotMatch(source, /<Input[^>]*id="zcash-address"/);
});

test("#603: the QR code renders its encoded value and copies it verbatim", () => {
  const source = read(QR_CODE);

  // The encoded value is displayed, not just stuffed into alt text.
  assert.match(source, /<CopyableValue\b/);
  // The image itself is a real button, so it is keyboard-activatable.
  assert.match(source, /<button[\s\S]*?onclick=\{copyValue\}/);
  assert.match(source, /aria-label=/);
});

test("#603: copying never mutates the value", () => {
  const copyable = read(COPYABLE_VALUE);
  const clipboard = read("src/lib/utils/clipboard.ts");

  // No trim/normalize anywhere on the copy path — the exact string or nothing.
  for (const source of [copyable, clipboard]) {
    assert.doesNotMatch(source, /\.trim\(\)/);
    assert.doesNotMatch(source, /\.replace\(/);
  }
  assert.match(copyable, /copyToClipboard\(value\)/);
});

// --- Middle truncation, tail weighted -------------------------------------
//
// The owner's ruling: addresses ARE truncated for display all the time, and
// "the crucial part is to show the last digits that can't be faked". A vanity
// prefix is cheap to grind; the trailing characters carry the bech32/base58
// checksum, so a head-only `slice(0, 15) + "..."` displays exactly the part an
// attacker controls and hides the only part a user could verify.

const PROFILE = "src/routes/[username]/dashboard/profile/+page.svelte";
const REACT = "../../react/free2z/src";

test("truncateZcashAddress keeps the tail, and the tail is never shorter than the head", () => {
  const out = truncateZcashAddress(CLEAN_ADDRESS);
  assert.notEqual(out, CLEAN_ADDRESS, "a 105-char address must truncate");

  const [head, tail] = out.split("…");
  assert.ok(head.length > 0 && tail.length > 0);
  assert.ok(
    tail.length >= head.length,
    `tail (${tail.length}) must be at least as long as head (${head.length})`,
  );
  assert.equal(head, CLEAN_ADDRESS.slice(0, head.length));
  assert.equal(
    tail,
    CLEAN_ADDRESS.slice(-tail.length),
    "the rendered tail must be the real tail of the address",
  );
});

test("a head-weighted request is swapped, not grown", () => {
  // The forgeable shape, asked for explicitly. It is refused — and refused
  // WITHIN the caller's width budget: the weight moves to the tail rather than
  // the tail being raised to match the head, which would silently return a
  // string far wider than the container was sized for.
  const out = truncateZcashAddress(CLEAN_ADDRESS, { head: 30, tail: 2 });
  const [head, tail] = out.split("…");

  assert.equal(head.length, 2);
  assert.equal(tail.length, 30);
  // 30 + 2 + 1 ellipsis. Asserting the LENGTH is the point: `tail >= head`
  // alone also passes for a 61-character string, which is the bug.
  assert.equal(out.length, 33);
  assert.equal(tail, CLEAN_ADDRESS.slice(-30));
  assert.equal(head, CLEAN_ADDRESS.slice(0, 2));
});

test("short addresses are returned untouched", () => {
  // Truncating has to save characters or it is pure loss.
  for (const value of ["", "t1", "u1short", CLEAN_ADDRESS.slice(0, 20)]) {
    assert.equal(truncateZcashAddress(value), value);
  }
  assert.equal(
    truncateZcashAddress(CLEAN_ADDRESS, { head: 200, tail: 200 }),
    CLEAN_ADDRESS,
  );
});

test("a zero-width budget shows the address, not a bare ellipsis", () => {
  // `{head: 0, tail: 0}` erases the value rather than shortening it — "…" is
  // not a truncated address, it is no address.
  for (const opts of [{ head: 0, tail: 0 }, { head: 0 }, { tail: 0 }]) {
    const out = truncateZcashAddress(CLEAN_ADDRESS, {
      head: opts.head ?? 0,
      tail: opts.tail ?? 0,
    });
    assert.equal(out, CLEAN_ADDRESS);
  }
  // A tail-only budget is still legitimate: it keeps the evidence.
  assert.equal(
    truncateZcashAddress(CLEAN_ADDRESS, { head: 0, tail: 12 }),
    `…${CLEAN_ADDRESS.slice(-12)}`,
  );
});

test("empty and missing input never throw", () => {
  assert.equal(truncateZcashAddress(undefined), "");
  assert.equal(truncateZcashAddress(null), "");
  assert.equal(truncateZcashAddress(""), "");
});

test("a zcash: URI truncates its address, not its query string", () => {
  // Keeping the literal tail of `zcash:addr?amount=0.5&memo=` would show the
  // parameters and hide the checksum entirely — the opposite of the point.
  const uri = `zcash:${CLEAN_ADDRESS}?amount=0.500&memo=`;
  const out = formatZcashAddressForDisplay(uri);

  assert.ok(out.startsWith("zcash:"));
  assert.ok(!out.includes("amount="), "the query string is not the evidence");
  assert.ok(
    out.endsWith(CLEAN_ADDRESS.slice(-8)),
    "the address's own tail must be what is shown",
  );
  // A bare address goes through the same rule.
  assert.equal(
    formatZcashAddressForDisplay(CLEAN_ADDRESS),
    truncateZcashAddress(CLEAN_ADDRESS),
  );
  assert.equal(formatZcashAddressForDisplay(undefined), "");
});

test("the two copies of the helper cannot drift apart", () => {
  // The rule is a security rule, so the SvelteKit app and the legacy CRA app
  // have to agree on it exactly — including the edge cases that are easy to
  // "fix" in one place only.
  const cases = [
    undefined,
    "",
    "t1short",
    CLEAN_ADDRESS,
    [CLEAN_ADDRESS, { head: 30, tail: 2 }],
    [CLEAN_ADDRESS, { head: 0, tail: 0 }],
    [CLEAN_ADDRESS, { head: 0, tail: 12 }],
    [CLEAN_ADDRESS, { head: 200, tail: 200 }],
  ];
  for (const entry of cases) {
    const args = Array.isArray(entry) ? entry : [entry];
    assert.equal(
      reactTruncateZcashAddress(...args),
      truncateZcashAddress(...args),
      `divergent for ${JSON.stringify(args)}`,
    );
  }
});

test("no display path re-introduces a head-only truncation", () => {
  // `slice(0, n) + "..."` with no tail is the exact forgeable pattern.
  const forgeable = /slice\(\s*0\s*,\s*\d+\s*\)[^\n]*\.\.\./;
  for (const file of [
    PROFILE,
    `${REACT}/components/QRAddress.tsx`,
    `${REACT}/components/SimpleZcashAddress.tsx`,
    `${REACT}/components/DonateZcashPanel.tsx`,
  ]) {
    assert.doesNotMatch(read(file), forgeable, `${file} truncates head-only`);
  }
});

test("the profile wallet chip truncates in the middle and stays copyable", () => {
  const source = read(PROFILE);

  assert.match(source, /truncateZcashAddress\(creator\.p2paddr\)/);
  // CSS ellipsis on the raw value cuts the tail by definition.
  assert.doesNotMatch(
    source,
    /max-w-\[140px\] truncate[\s\S]{0,200}\{creator\.p2paddr\}/,
  );
  // A `title` tooltip is unreachable on touch, so the copy button is required.
  assert.match(source, /copyToClipboard\(creator\.p2paddr\)/);
  assert.match(source, /title=\{creator\.p2paddr\}/);
});

test("#640: markdown content can never overflow its column horizontally", () => {
  const source = read(MARKDOWN_CONTENT);
  const styleBlock = source.slice(source.indexOf("<style>"));

  assert.match(
    styleBlock,
    /\.markdown-content\s*\{[^}]*overflow-wrap:\s*anywhere/,
    "the .markdown-content root must set overflow-wrap: anywhere",
  );
  assert.match(styleBlock, /\.markdown-content\s*\{[^}]*max-width:\s*100%/);
});

test("#640: tables get their own scroll container, not collapsed columns", () => {
  // `overflow-wrap: anywhere` participates in min-content sizing, so without
  // this a table's columns could collapse to a few characters wide.
  const source = read(MARKDOWN_CONTENT);

  assert.match(source, /function enhanceTables\(\)/);
  assert.match(source, /enhanceTables\(\);/);
  assert.match(source, /\.markdown-table-scroll\)\s*\{[^}]*overflow-x:\s*auto/);
  // Cells opt back down to `break-word`, which does not shrink min-content.
  assert.match(
    source,
    /\.markdown-table-scroll table\)\s*\{[^}]*overflow-wrap:\s*break-word/,
  );
});
