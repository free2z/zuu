// The markdown lightbox is a full-viewport dialog. Dialog.Content centers
// itself with Tailwind's `translate-x-[-50%] translate-y-[-50%]` utilities,
// which set the CSS `translate` property (independent of `transform`).
// The lightbox style block tries to cancel that with `translate: none` next
// to `transform: none`, but lightningcss drops `translate` in that pair, so
// production keeps the -50% shift. `translate: 0 0` beside `transform: none`
// is deleted too. The load-bearing fix is `translate-x-0 translate-y-0` on
// the class string, which tailwind-merge removes the -50% utilities for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { browserslistToTargets, transform } from "lightningcss";
import browserslist from "browserslist";
import { twMerge } from "tailwind-merge";

const APP_ROOT = new URL("../", import.meta.url);

function readApp(path) {
  return readFileSync(new URL(path, APP_ROOT), "utf8");
}

function browserslistQueries() {
  return readApp(".browserslistrc")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);
}

const lightboxSource = readApp(
  "src/lib/components/MarkdownImageLightbox.svelte",
);
const dialogSource = readApp(
  "src/lib/components/ui/dialog/dialog-content.svelte",
);

function lightboxClass() {
  const match = lightboxSource.match(
    /data-testid="markdown-image-lightbox"[\s\S]*?\bclass="([^"]+)"/,
  );
  assert.ok(match, "lightbox Dialog.Content class is missing");
  return match[1];
}

function dialogBaseClass() {
  const match = dialogSource.match(/class=\{cn\(\s*"([^"]+)"/);
  assert.ok(match, "dialog base class is missing");
  return match[1];
}

function lightboxResetRule() {
  const match = lightboxSource.match(
    /:global\(\[data-testid="markdown-image-lightbox"\]\)\s*\{([^}]+)\}/,
  );
  assert.ok(match, "lightbox reset rule is missing");
  return match[1];
}

function minify(css) {
  const queries = browserslistQueries();
  assert.match(queries.join("\n"), /chrome >= 111/);
  assert.match(queries.join("\n"), /safari >= 16\.4/);
  assert.match(queries.join("\n"), /firefox >= 128/);
  const targets = browserslistToTargets(browserslist(queries));
  return transform({
    filename: "lightbox.css",
    code: Buffer.from(css),
    minify: true,
    targets,
  }).code.toString();
}

test("lightbox classes replace the dialog's -50% translate", () => {
  const base = dialogBaseClass();
  const override = lightboxClass();
  assert.match(base, /(?:^|\s)translate-x-\[-50%\](?:\s|$)/);
  assert.match(base, /(?:^|\s)translate-y-\[-50%\](?:\s|$)/);
  assert.match(override, /(?:^|\s)translate-x-0(?:\s|$)/);
  assert.match(override, /(?:^|\s)translate-y-0(?:\s|$)/);

  const merged = twMerge(base, override);
  assert.equal(merged.includes("translate-x-[-50%]"), false, merged);
  assert.equal(merged.includes("translate-y-[-50%]"), false, merged);
  assert.match(merged, /(?:^|\s)translate-x-0(?:\s|$)/);
  assert.match(merged, /(?:^|\s)translate-y-0(?:\s|$)/);
  assert.match(merged, /(?:^|\s)inset-0(?:\s|$)/);
  assert.equal(merged.includes("top-[50%]"), false, merged);
  assert.equal(merged.includes("left-[50%]"), false, merged);
});

test("lightningcss drops translate when the lightbox reset also sets transform", () => {
  const body = lightboxResetRule();
  assert.match(body, /translate:\s*none\s*!important/);
  assert.match(body, /transform:\s*none\s*!important/);

  const minified = minify(`[data-testid="markdown-image-lightbox"]{${body}}`);
  assert.doesNotMatch(minified, /translate\s*:/);
  assert.match(minified, /transform:\s*none/);

  // The false repair: `translate: 0 0` next to `transform: none` is deleted
  // the same way, so editing only the style block cannot cancel Tailwind.
  const zeroed = minify(
    `[data-testid="markdown-image-lightbox"]{translate:0 0 !important;transform:none !important}`,
  );
  assert.doesNotMatch(zeroed, /translate\s*:/);
  assert.match(zeroed, /transform:\s*none/);
});
