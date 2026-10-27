// The two article routes are two views of ONE article, and their
// `<svelte:head>` blocks are supposed to be identical. Until now that was a
// claim in a comment:
//
//     "keeping the two head blocks identical is what stops one from
//      regressing when a style is added"
//
// It had already failed by the time it was written. `/article/[id]` computed
// `pageMeta.alternates` from the same helper as its sibling and never rendered
// them, so the immutable URL emitted a bare `rel=canonical` with no hreflang
// cluster around it, for as long as the cluster has existed.
// added a head tag to one route; nothing noticed the other did not get it.
//
// Two tests already assert each route independently (`article-language.test.mjs`
// checks that BOTH render the cluster, `social-card-parity.test.mjs` checks
// that both write `<meta>` attributes out rather than spreading them). Neither
// compares the two blocks to each other, so the NEXT tag added to one of them
// regresses the other exactly the way the last one did. This is the comment,
// turned into a check.
//
// Scope, deliberately: this is about the head, and only the head. The bodies of
// the two routes are legitimately different — one is a full hero layout, the
// other a minimal escape hatch.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));

const ROUTES = [
  "src/routes/[username]/[vanity]/+page.svelte",
  "src/routes/article/[id]/+page.svelte",
];

/**
 * The `<svelte:head>` block of a route, as MARKUP: comments removed and
 * whitespace collapsed.
 *
 * Comments are dropped on purpose. The two routes explain themselves
 * differently and should be free to — one of them has a `<style>` block and
 * the other does not, and that is worth saying in prose next to the code. What
 * must not diverge is the set of tags a crawler receives.
 *
 * @param {string} relativePath
 * @returns {string}
 */
function headMarkup(relativePath) {
  const source = fs.readFileSync(
    path.join(UI_ROOT, "..", relativePath),
    "utf8",
  );
  const block = /<svelte:head>([\s\S]*?)<\/svelte:head>/.exec(source);
  assert.ok(block, `${relativePath} has no <svelte:head> block`);
  return block[1]
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

test("both article routes emit the same <svelte:head>", () => {
  const [vanity, immutable] = ROUTES.map(headMarkup);

  assert.equal(
    immutable,
    vanity,
    "the two article routes' <svelte:head> blocks have diverged. They are two " +
      "views of one article and must declare the same thing to a crawler: " +
      "title, canonical, the hreflang cluster, the social tags and the JSON-LD. " +
      "If a route genuinely needs its own head tag, say so here rather than " +
      "letting the difference ship unnoticed — that is how /article/<id> lost " +
      "its hreflang cluster (#1931).",
  );

  // Not vacuous: an empty or trivially short block would satisfy `equal` above
  // if both routes lost their head at once.
  assert.ok(
    vanity.length > 200,
    "the shared head block is suspiciously small; is it still rendering tags?",
  );
});

test("the shared head still carries each thing it exists for", () => {
  // The parity test says "the same". These say "the same AS WHAT" — so a
  // matched pair of deletions cannot pass.
  for (const relativePath of ROUTES) {
    const head = headMarkup(relativePath);
    assert.match(head, /<title>/, `${relativePath}: no <title>`);
    assert.match(
      head,
      /<link rel="canonical"/,
      `${relativePath}: no canonical`,
    );
    // The `<head>` is the AUTHORITATIVE hreflang carrier since: past
    // `SITEMAP_MAX_BYTES_PER_ZPAGE` per article the sitemap stops repeating the
    // cluster and relies on exactly this markup.
    assert.match(
      head,
      /\{#each pageMeta\.alternates as alternate\}/,
      `${relativePath}: no hreflang cluster`,
    );
    assert.match(
      head,
      /rel="alternate" hreflang=\{alternate\.hreflang\}/,
      `${relativePath}: the cluster does not render an hreflang`,
    );
    assert.match(
      head,
      /\{#each pageMeta\.tags as tag\}/,
      `${relativePath}: no social tags`,
    );
    assert.match(head, /application\/ld\+json/, `${relativePath}: no JSON-LD`);
  }
});

test("neither route sets a document direction from the article's language", () => {
  //  gives the article's own language a `dir`, and deliberately does NOT
  // put it on the document: content language and product-UI locale are
  // independent axes ( §2 principle 8), so an English-reading visitor gets
  // an RTL article body inside an LTR page. `<svelte:head>` is where someone
  // would reach for `<svelte:document dir=...>` or a `<html dir>` tag to "fix"
  // a half-RTL page, and that is the regression this guards.
  for (const relativePath of ROUTES) {
    const source = fs.readFileSync(
      path.join(UI_ROOT, "..", relativePath),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /<svelte:(document|html)[^>]*\bdir=/,
      `${relativePath}: the chrome's direction is not the article's to set`,
    );
    assert.doesNotMatch(
      source,
      /documentElement\.dir\s*=/,
      `${relativePath}: the chrome's direction is not the article's to set`,
    );
  }
});
