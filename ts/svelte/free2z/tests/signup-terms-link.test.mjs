// The signup consent link used to point at `/terms`, a confirmed production
// 404, while every navigation surface already used the real Docusaurus route.
// This contract joins all three independently maintained facts:
//
//   Docusaurus baseUrl + the Terms document slug
//       === LEGAL_LINKS[0].href
//       === the destination rendered by UnifiedAuthModal.
//
// The browser test follows the rendered link. This cheaper test is the guard
// that names which half drifted when a route or import changes.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { LEGAL_LINKS } from "../src/lib/nav-links.js";

const APP_ROOT = new URL("../", import.meta.url);
const REPO_ROOT = new URL("../../../", APP_ROOT);
const modalSource = readFileSync(
  new URL("src/lib/components/auth/UnifiedAuthModal.svelte", APP_ROOT),
  "utf8",
);
const docsConfig = readFileSync(
  new URL("docs/about-free2z/docusaurus.config.js", REPO_ROOT),
  "utf8",
);
const termsSource = readFileSync(
  new URL(
    "docs/about-free2z/docs/legal/01-terms-of-service-agreement.md",
    REPO_ROOT,
  ),
  "utf8",
);

function frontmatterValue(source, key) {
  const match = source.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  assert.ok(match, `Terms document has no ${key} frontmatter`);
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

test("the signup Terms destination is the canonical built docs route", () => {
  const baseUrlMatch = docsConfig.match(/^\s*baseUrl:\s*['"]([^'"]+)['"]/m);
  assert.ok(baseUrlMatch, "Docusaurus config has no baseUrl");
  const builtTermsRoute = `${baseUrlMatch[1].replace(/\/$/, "")}${frontmatterValue(termsSource, "slug")}`;

  assert.equal(
    frontmatterValue(termsSource, "title"),
    "Terms of Service Agreement",
  );
  assert.equal(builtTermsRoute, "/docs/legal/");
  assert.deepEqual(LEGAL_LINKS[0], {
    href: builtTermsRoute,
    key: "footer.terms",
    fallback: "Terms of service",
    reload: true,
  });
});

test("the signup modal uses the legal contract with safe new-tab navigation", () => {
  assert.match(
    modalSource,
    /import\s*\{\s*LEGAL_LINKS\s*\}\s*from\s*["']\$lib\/nav-links["']/,
  );
  assert.match(modalSource, /const\s+termsLink\s*=\s*LEGAL_LINKS\[0\]/);
  // Inside an SDK app's flow the same Terms open in their plain rendering
  // (/docs/plain/legal/: no docs navigation, which reaches "2Z credits");
  // everywhere else, the canonical route above.
  assert.match(
    modalSource,
    /termsHref\s*=\s*sdkSheet\s*\?\s*["']\/docs\/plain\/legal\/["']\s*:\s*termsLink\.href/,
  );
  assert.match(modalSource, /href=\{termsHref\}/);
  // …and that rendering exists: the docs site's `plain` instance at
  // /docs/plain/ (docusaurus.config.js), whose allow-list carries the Terms.
  assert.match(docsConfig, /routeBasePath:\s*["']plain["']/);
  const plainAllowList = readFileSync(
    new URL("docs/about-free2z/src/legal-plain/allowlist.js", REPO_ROOT),
    "utf8",
  );
  assert.match(plainAllowList, /["']01-terms-of-service-agreement\.md["']/);
  assert.match(modalSource, /target="_blank"/);
  assert.match(modalSource, /rel="noopener noreferrer"/);
  assert.match(
    modalSource,
    /data-sveltekit-reload=\{termsLink\.reload\s*\?\s*true\s*:\s*undefined\}/,
  );

  const termsAnchor = modalSource.match(
    /<a\s+[\s\S]*?href=\{termsHref\}[\s\S]*?\$t\(["']auth\.termsLink["']\)[\s\S]*?<\/a\s*>/,
  );
  assert.ok(termsAnchor, "signup Terms anchor was not found");
  assert.doesNotMatch(
    termsAnchor[0],
    /\bon[a-z]+\s*=/i,
    "Terms navigation must remain passive so form and CAPTCHA state survive",
  );
});

test("auth source contains no link to the retired /terms route", () => {
  const authDir = fileURLToPath(new URL("src/lib/components/auth/", APP_ROOT));
  const offenders = readdirSync(authDir)
    .filter((name) => name.endsWith(".svelte"))
    .filter((name) =>
      /href\s*=\s*["']\/terms(?:[/?#"'])/.test(
        readFileSync(`${authDir}/${name}`, "utf8"),
      ),
    );

  assert.deepEqual(offenders, []);
});
