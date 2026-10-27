import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

/**
 *  posting costs a penny by design; say so before a 0-balance creator
 * writes, and name both ways in. The browser spec
 * (`tests/browser/converse-posting-cost.spec.ts`) proves the wire; this pins
 * the predicate and the source contract that both composers share.
 *
 * NEGATIVE CONTROLS (each run by reverting the change and re-running):
 *   - `cannotCoverMinimumPost` returning `true` for a null decimal
 *     -> "unknown is not zero" fails;
 *   - removing the `{:else if cannotCoverAComment}` branch from CommentForm
 *     -> "both composers say it up front" fails naming CommentForm;
 *   - deleting `insufficientFunds.giftIntro` from fr.json
 *     -> "every catalog carries the copy" fails on fr.
 */

const read = (relative) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

function loadFundsModule() {
  const compiled = ts.transpileModule(read("src/lib/insufficient-funds.ts"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "require", "module", compiled)(
    module.exports,
    () => ({ ApiError: class ApiError extends Error {} }),
    module,
  );
  return module.exports;
}

const funds = loadFundsModule();

test("the smallest post is 1 2Z, matching the composer and the server", () => {
  assert.equal(funds.MINIMUM_POST_STAKE, "1");
  assert.match(
    read("src/lib/components/converse/ConverseComposer.svelte"),
    /min=\{1\}/,
  );
});

test("a known balance below 1 2Z cannot cover a post", () => {
  for (const balance of ["0", "0.000", "0.99", "0.999999", "-1", 0, 0.5]) {
    assert.equal(funds.cannotCoverMinimumPost(balance), true, `${balance}`);
  }
  for (const balance of ["1", "1.000", "1.5", "10000", 1, 2]) {
    assert.equal(funds.cannotCoverMinimumPost(balance), false, `${balance}`);
  }
});

test("unknown is not zero", () => {
  for (const balance of [undefined, null, "", "abc", NaN, {}, []]) {
    assert.equal(
      funds.cannotCoverMinimumPost(balance),
      false,
      `${JSON.stringify(balance)} must not read as an empty balance`,
    );
  }
});

test("the intro door goes to the page a creator has, never a refused second one", () => {
  // `/edit` creates a page, and `_create_page` refuses a second one below
  // 1 2Z. A creator who already has one is sent to it instead.
  assert.deepEqual(funds.introPath({ username: "ann", zpages: 1 }), {
    href: "/ann/dashboard/pages",
    written: true,
  });
  assert.deepEqual(funds.introPath({ username: "a b", zpages: 3 }), {
    href: "/a%20b/dashboard/pages",
    written: true,
  });
  for (const user of [
    { username: "ann", zpages: 0 },
    { username: "ann" },
    { zpages: 2 },
    null,
    undefined,
  ]) {
    assert.deepEqual(
      funds.introPath(user),
      { href: "/edit", written: false },
      JSON.stringify(user),
    );
  }
});

test("both composers say it up front, and the refusal still wins", () => {
  for (const [relative, flag] of [
    ["src/lib/components/converse/ConverseComposer.svelte", "cannotCoverAPost"],
    ["src/lib/components/comments/CommentForm.svelte", "cannotCoverAComment"],
  ]) {
    const source = read(relative);
    assert.match(
      source,
      new RegExp(
        `${flag}\\s*=\\s*(?:\\$derived\\()?cannotCoverMinimumPost\\(\\$currentUser\\?\\.tuzis\\)`,
      ),
      `${relative} must derive the note from the session balance`,
    );
    assert.match(
      source,
      /intro\s*=\s*(?:\$derived\()?introPath\(\$currentUser\)/,
      `${relative} must route the intro door through introPath`,
    );
    assert.match(
      source,
      new RegExp(
        `\\{#if insufficientFunds\\}\\s*<InsufficientFunds[^>]*introHref=\\{intro\\.href\\}[^>]*introWritten=\\{intro\\.written\\}[^>]*/>\\s*\\{:else if ${flag}\\}\\s*<PostingCostNotice`,
      ),
      `${relative} must show the up-front note only when no 402 is on screen`,
    );
  }
});

test("the Converse composer keeps its draft when a door is followed", () => {
  // It has no draft storage (CommentForm does), so its links open a new tab.
  const source = read("src/lib/components/converse/ConverseComposer.svelte");
  assert.match(source, /<InsufficientFunds[^>]*\bnewTab\b[^>]*\/>/);
});

test("the note names the price, the balance and both ways in", () => {
  const source = read("src/lib/components/PostingCostNotice.svelte");
  assert.match(source, /insufficientFunds\.postCost/);
  assert.match(source, /insufficientFunds\.giftIntro/);
  assert.match(source, /insufficientFunds\.giftWaiting/);
  assert.match(source, /formatDecimalText\(balance/);
  assert.match(source, /href=\{intro\.href\}\s*target="_blank"/);
  assert.match(source, /href="\/buy-2z"\s*target="_blank"/);
  // A note, not an error, and never a gate on the textarea.
  assert.match(source, /role="note"/);
  assert.doesNotMatch(source, /disabled/);
});

test("every catalog carries the copy, with the balance placeholder", () => {
  for (const code of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(read(`src/lib/locales/${code}.json`));
    const section = catalog.insufficientFunds;
    assert.equal(typeof section.postCost, "string", `${code}: postCost`);
    for (const key of ["giftIntro", "giftWaiting", "yourPages"]) {
      assert.equal(typeof section[key], "string", `${code}: ${key}`);
    }
    assert.match(section.postCost, /\{balance\}/, `${code}: postCost`);
    assert.match(section.postCost, /\b1 2Z\b/, `${code}: postCost price`);
  }
});
