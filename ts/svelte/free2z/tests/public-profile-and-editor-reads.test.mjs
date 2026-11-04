import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative) =>
  readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );

test("owner profiles use the public zPage list contract", () => {
  const loader = read("src/routes/[username]/+page.server.ts");
  const profile = read("src/routes/[username]/+page.svelte");

  assert.match(
    loader,
    /\/api\/zpage\/\?username=\$\{encodedUsername\}&\$\{query\}/,
  );
  assert.doesNotMatch(loader, /\/api\/zpage\/\?mine=true/);
  assert.match(profile, /\$: publishedCount = data\.zpages\?\.count \?\? 0/);
  assert.match(profile, /\{#each publishedPages as zpage\}/);
  assert.doesNotMatch(profile, /value="drafts"|const drafts/);
});

test("editor private reads explicitly opt into draft visibility", () => {
  const reactEditor = read("../../react/free2z/src/EditPage.tsx");
  const svelteEditor = read("src/routes/edit/+page.svelte");
  const routeLoader = read("src/routes/edit/+page.ts");

  assert.match(
    reactEditor,
    /\.get\(`\/api\/zpage\/\$\{id\}\/`,\s*\{\s*params:\s*\{\s*mine:\s*true\s*\}\s*\}\)/s,
  );
  assert.match(
    svelteEditor,
    /zpageVariantsList\(identifier,\s*\{\s*mine:\s*true\s*\}\)/,
  );
  assert.match(
    routeLoader,
    /variants\/\$\{encodeURIComponent\(language\)\}\/\?mine=true/,
  );
  assert.match(svelteEditor, /apiFetch\(`\$\{resourceUrl\}\?mine=true`\)/);
});

test("dashboard unpublished pages never link to the public article route", () => {
  const dashboard = read("src/routes/[username]/dashboard/pages/+page.svelte");
  const card = read("src/lib/components/ZpageCard.svelte");

  assert.match(
    dashboard,
    /privateHref=\{!zpage\.is_published \? editUrl\(zpage\) : null\}/,
  );
  assert.match(
    dashboard,
    /href=\{zpage\.is_published \? pageUrl\(zpage\) : editUrl\(zpage\)\}/,
  );
  assert.match(card, /export let privateHref: string \| null = null/);
  assert.match(card, /if \(privateHref\) return privateHref/);
});
