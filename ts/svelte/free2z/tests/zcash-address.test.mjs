// Zcash address display rules.
//
// Addresses ARE truncated for display all the time — the crucial part is that
// the last characters, which cannot be faked, stay on screen. A vanity prefix
// is cheap to grind; the trailing characters carry the bech32/base58 checksum,
// so a head-only `slice(0, 15) + "..."` displays exactly the part an attacker
// controls and hides the only part a user could verify.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let truncateZcashAddress;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ truncateZcashAddress } = await server.ssrLoadModule(
    "/src/lib/utils/zcashAddress.ts",
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

const PROFILE = "src/routes/[username]/dashboard/profile/+page.svelte";

// An obviously-synthetic address: the right shape and length for a Unified
// address, but random characters. It belongs to nobody.
const SAMPLE_ADDRESS =
  "u18vffksp4zjra0c8aqzyxvvhmxqmr2rk8j7x9m2q0lhq3wgs6tqk9v4zn7l3xd8fpq5j2m6c0rtyv9wq8hn3lz7kx4mv2p6gd9sr0tqy5h";

test("truncateZcashAddress keeps the tail, and the tail is never shorter than the head", () => {
  const out = truncateZcashAddress(SAMPLE_ADDRESS);
  assert.notEqual(out, SAMPLE_ADDRESS, "a 105-char address must truncate");

  const [head, tail] = out.split("…");
  assert.ok(head.length > 0 && tail.length > 0);
  assert.ok(
    tail.length >= head.length,
    `tail (${tail.length}) must be at least as long as head (${head.length})`,
  );
  assert.equal(head, SAMPLE_ADDRESS.slice(0, head.length));
  assert.equal(
    tail,
    SAMPLE_ADDRESS.slice(-tail.length),
    "the rendered tail must be the real tail of the address",
  );
});

test("a head-weighted request is swapped, not grown", () => {
  // The forgeable shape, asked for explicitly. It is refused — and refused
  // WITHIN the caller's width budget: the weight moves to the tail rather than
  // the tail being raised to match the head, which would silently return a
  // string far wider than the container was sized for.
  const out = truncateZcashAddress(SAMPLE_ADDRESS, { head: 30, tail: 2 });
  const [head, tail] = out.split("…");

  assert.equal(head.length, 2);
  assert.equal(tail.length, 30);
  // 30 + 2 + 1 ellipsis. Asserting the LENGTH is the point: `tail >= head`
  // alone also passes for a 61-character string, which is the bug.
  assert.equal(out.length, 33);
  assert.equal(tail, SAMPLE_ADDRESS.slice(-30));
  assert.equal(head, SAMPLE_ADDRESS.slice(0, 2));
});

test("short addresses are returned untouched", () => {
  // Truncating has to save characters or it is pure loss.
  for (const value of ["", "t1", "u1short", SAMPLE_ADDRESS.slice(0, 20)]) {
    assert.equal(truncateZcashAddress(value), value);
  }
  assert.equal(
    truncateZcashAddress(SAMPLE_ADDRESS, { head: 200, tail: 200 }),
    SAMPLE_ADDRESS,
  );
});

test("a zero-width budget shows the address, not a bare ellipsis", () => {
  // `{head: 0, tail: 0}` erases the value rather than shortening it — "…" is
  // not a truncated address, it is no address.
  for (const opts of [{ head: 0, tail: 0 }, { head: 0 }, { tail: 0 }]) {
    const out = truncateZcashAddress(SAMPLE_ADDRESS, {
      head: opts.head ?? 0,
      tail: opts.tail ?? 0,
    });
    assert.equal(out, SAMPLE_ADDRESS);
  }
  // A tail-only budget is still legitimate: it keeps the evidence.
  assert.equal(
    truncateZcashAddress(SAMPLE_ADDRESS, { head: 0, tail: 12 }),
    `…${SAMPLE_ADDRESS.slice(-12)}`,
  );
});

test("empty and missing input never throw", () => {
  assert.equal(truncateZcashAddress(undefined), "");
  assert.equal(truncateZcashAddress(null), "");
  assert.equal(truncateZcashAddress(""), "");
});

test("no display path re-introduces a head-only truncation", () => {
  // `slice(0, n) + "..."` with no tail is the exact forgeable pattern.
  const forgeable = /slice\(\s*0\s*,\s*\d+\s*\)[^\n]*\.\.\./;
  assert.doesNotMatch(
    read(PROFILE),
    forgeable,
    `${PROFILE} truncates head-only`,
  );
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
