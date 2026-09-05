import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  REVIEWED_DIRECTIVES,
  RETIRED_SOURCES,
  assertCspPolicy,
  parseCsp,
} from "./csp-policy.mjs";

const config = JSON.parse(
  await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const CSP = config?.app?.security?.csp;

/** Comments explain why a component is absent; only executable code counts. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
}

const sources = await Promise.all(
  [
    "../src/components/ui/avatar.tsx",
    "../src/components/layout/TopBar.tsx",
    "../src/features/wallet/funding/SendTab.tsx",
    "../src/features/home/Hero.tsx",
    "../src/features/home/VaultActions.tsx",
  ].map(async (path) => [
    path,
    stripComments(await readFile(new URL(path, import.meta.url), "utf8")),
  ]),
);

test("the committed packaged CSP matches the reviewed directive contract", () => {
  assert.doesNotThrow(() => assertCspPolicy(CSP));
});

test("every reviewed directive carries a written justification", () => {
  for (const [name, contract] of Object.entries(REVIEWED_DIRECTIVES)) {
    assert.ok(contract.sources.length > 0, `${name} declares no source`);
    assert.ok(
      typeof contract.why === "string" && contract.why.length > 20,
      `${name} has no justification`,
    );
  }
});

test("an unreviewed directive fails rather than passing unnoticed", () => {
  assert.throws(
    () => assertCspPolicy(`${CSP}; font-src https://fonts.gstatic.com`),
    /directive set differs/,
  );
});

test("a repeated directive fails instead of silently taking one of them", () => {
  assert.throws(
    () => assertCspPolicy(`${CSP}; img-src 'self' data: https:`),
    /repeats the img-src directive/,
  );
});

test("every retired source is rejected wherever it reappears", () => {
  for (const source of RETIRED_SOURCES) {
    const widened = CSP.replace(
      "connect-src 'self'",
      `connect-src 'self' ${source}`,
    );
    assert.notEqual(widened, CSP, source);
    assert.throws(() => assertCspPolicy(widened), /differs|re-admits/, source);
  }
});

/**
 * The CSP claim is only true because no production source renders a remote
 * image any more. Assert the code half here so the two cannot drift: a
 * reintroduced `<img src>` would still pass the string check above while
 * silently breaking at runtime under `img-src 'self' data:`.
 */
test("no vault chrome source renders a remote image", () => {
  const imageSources = parseCsp(CSP).get("img-src");
  assert.deepEqual(imageSources, ["'self'", "data:"]);

  for (const [path, source] of sources) {
    assert.doesNotMatch(source, /<img\b/, `${path} renders a raw <img>`);
    assert.doesNotMatch(
      source,
      /\bAvatarImage\b/,
      `${path} renders a remote avatar image`,
    );
  }
});

test("the frontend never names a retired network origin", async () => {
  const env = await readFile(new URL("../src/lib/env.ts", import.meta.url), "utf8");
  for (const needle of ["dyte.io", "zec.rocks", "realtime.cloudflare.com"]) {
    assert.doesNotMatch(env, new RegExp(needle.replace(/\./gu, "\\.")), needle);
  }
});
