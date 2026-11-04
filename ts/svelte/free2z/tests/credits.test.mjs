import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("credit explanation and welcome are short plain translated strings", () => {
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const copy = JSON.parse(read(`src/lib/locales/${locale}.json`)).credits;
    assert.deepEqual(Object.keys(copy).sort(), [
      "dismiss",
      "model",
      "sources",
      "title",
      "welcome",
    ]);
    assert.match(copy.welcome, /\{amount\}/);
    assert.match(copy.welcome, /1 2Z/);
    for (const text of Object.values(copy)) {
      assert.ok(text.length < 450);
      // Render as text, never require markdown/HTML or embedded links.
      assert.doesNotMatch(text, /<|>|\]\(|\*\*|https?:/);
    }
  }
});

test("both credit notices share a reachable explanation without replacing the draft", () => {
  for (const component of ["PostingCostNotice", "InsufficientFunds"]) {
    const source = read(`src/lib/components/${component}.svelte`);
    assert.match(source, /href="\/credits"\s+target="_blank"\s+rel="noopener"/);
    assert.match(source, /credits\.title/);
  }
  const welcome = read("src/lib/components/WelcomeCredits.svelte");
  assert.match(welcome, /\$currentUser\?\.welcome_grant/);
  assert.match(welcome, /welcome-credits:\$\{account\}/);
  assert.doesNotMatch(welcome, /fetch\(|apiFetch\(|{@html/);
});

test("the up-front notice uses the submitted action cost", () => {
  for (const component of [
    "comments/CommentForm",
    "converse/ConverseComposer",
  ]) {
    assert.match(
      read(`src/lib/components/${component}.svelte`),
      /<PostingCostNotice\s+cost=\{tuzis\}/,
    );
  }
  assert.match(
    read("src/lib/components/PostingCostNotice.svelte"),
    /cost: formatDecimalText\(String\(cost\)/,
  );
});
