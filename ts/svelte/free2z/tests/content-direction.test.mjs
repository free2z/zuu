// Direction is a property of the SCRIPT, not of the language (§5).
//
// These are the cases a `["ar", "he", "fa", "ur"]` list gets wrong. They are
// the point of the module, so they are the point of the test: a suite that
// only checked `ar` -> rtl would pass against the naive implementation this
// one exists to rule out.

import assert from "node:assert/strict";
import test from "node:test";

import {
  NO_SPACE_SCRIPTS,
  RTL_SCRIPTS,
  contentDirection,
  contentScript,
  usesNoSpaceScript,
} from "../src/lib/content-direction.js";

// --- 1. the same language, both directions ---------------------------------

test("a spelled-out script decides, not the language", () => {
  // Azerbaijani, Punjabi and Kurdish are each written in both an RTL and an
  // LTR script. Every one of these pairs is a wrong answer for a
  // language->direction table.
  assert.equal(contentDirection("az-Arab"), "rtl");
  assert.equal(contentDirection("az-Latn"), "ltr");
  assert.equal(contentDirection("pa-Arab"), "rtl");
  assert.equal(contentDirection("pa-Guru"), "ltr");
  assert.equal(contentDirection("ku-Arab"), "rtl");
  assert.equal(contentDirection("ku-Latn"), "ltr");
  assert.equal(contentDirection("sr-Cyrl"), "ltr");
  // Case is not part of the answer: a stored `AZ-ARAB` is the same content.
  assert.equal(contentDirection("AZ-ARAB"), "rtl");
  assert.equal(contentDirection("az_Arab"), "rtl");
});

test("a bare tag takes CLDR's implicit script", () => {
  // Nothing in the tag says "Arabic script", and it still has to be one.
  assert.equal(contentScript("ur"), "Arab");
  assert.equal(contentScript("ps"), "Arab");
  assert.equal(contentScript("ckb"), "Arab");
  assert.equal(contentScript("dv"), "Thaa");
  assert.equal(contentScript("yi"), "Hebr");
  assert.equal(contentScript("az"), "Latn");
  assert.equal(contentScript("pa"), "Guru");
  // A region is enough to pin a script down, with no script subtag at all.
  assert.equal(contentScript("zh-TW"), "Hant");
  assert.equal(contentScript("zh-CN"), "Hans");
});

test("every language we sell a translation into today is right", () => {
  // The four that are live and broken on prod as this lands.
  for (const tag of ["ar", "he", "fa", "ur"]) {
    assert.equal(contentDirection(tag), "rtl", `${tag} must be rtl`);
  }
  //...and the rest of TRANSLATABLE is not accidentally flipped with them.
  for (const tag of ["en", "es", "pt-BR", "fr", "ja", "ko", "zh-Hans", "hi"]) {
    assert.equal(contentDirection(tag), "ltr", `${tag} must be ltr`);
  }
});

test("the ones #1904 wants to add next are already correct", () => {
  // No code change should be needed for these; that is what deriving from the
  // script buys, and this test is the claim.
  for (const tag of ["sd", "ug", "nqo", "arz", "ary"]) {
    assert.equal(contentDirection(tag), "rtl", `${tag} must be rtl`);
  }
});

// --- 2. unknown stays unknown ----------------------------------------------

test("an unknown language yields null, never a confident ltr", () => {
  // `Intl.Locale("und").maximize().script` is "Latn" — a real answer to a
  // question nobody asked. The caller omits `dir` entirely on null, so this
  // is the difference between "leave it alone" and "assert left-to-right".
  for (const value of ["und", "mul", "zxx", "mis", "UND"]) {
    assert.equal(contentScript(value), null, `${value} names no script`);
    assert.equal(contentDirection(value), null);
  }
  for (const value of [null, undefined, "", "   ", 42, {}, []]) {
    assert.equal(contentDirection(value), null);
  }
});

test("a spelled-out script is read even where Intl cannot help", () => {
  // These two are the whole reason the explicit-script branch exists as its
  // own step rather than as a faster path to what `Intl.Locale#maximize()`
  // would have said anyway. Without them the branch could be deleted with the
  // suite still green — which is exactly what an earlier round of this test
  // file measured, and said so in the PR rather than pretending otherwise.
  //
  // 1. `und-Arab` states the script. The `und` sentinel guard must not swallow
  //    it: "unknown language" is not "unknown script", and CLDR's `Latn` for
  //    bare `und` is the inference the guard exists to refuse, not this.
  assert.equal(contentScript("und-Arab"), "Arab");
  assert.equal(contentDirection("und-Arab"), "rtl");
  assert.equal(contentDirection("und-Latn"), "ltr");
  //...and the bare sentinel still answers nothing at all.
  assert.equal(contentScript("und"), null);

  // 2. `en-Arab-x` is a tag `Intl.Locale` REJECTS outright — a dangling
  //    singleton — while its script subtag is unambiguous. The `catch` falls
  //    through to a fallback map with no `en` entry, so without this branch
  //    the answer is null and the container gets no direction at all.
  assert.throws(() => new Intl.Locale("en-Arab-x"));
  assert.equal(contentScript("en-Arab-x"), "Arab");
  assert.equal(contentDirection("en-Arab-x"), "rtl");
  assert.equal(contentDirection("en-Latn-x"), "ltr");
});

test("a structurally invalid tag does not throw", () => {
  // A `?lang=` is a representation selector and may never fail a render, so
  // neither may anything downstream of one.
  assert.doesNotThrow(() => contentDirection("this-is-not-a-tag-at-all-x"));
  assert.doesNotThrow(() => contentDirection("-"));
  assert.doesNotThrow(() => contentDirection("a".repeat(400)));
});

// --- 3. line breaking ------------------------------------------------------

test("the four no-space scripts are identified, and CJK is not", () => {
  for (const tag of ["th", "lo", "km", "my", "th-TH", "km-KH"]) {
    assert.equal(usesNoSpaceScript(tag), true, `${tag} needs a dictionary`);
  }
  // Han/Kana/Hangul have no inter-word spaces either, but per-character
  // breaking is the CORRECT rendering for them — claiming otherwise here
  // would turn a working language into a broken one.
  for (const tag of ["zh-Hans", "zh-Hant", "ja", "ko", "yue-Hant"]) {
    assert.equal(usesNoSpaceScript(tag), false, `${tag} must be left alone`);
  }
  for (const tag of ["en", "ar", "he", "und", ""]) {
    assert.equal(usesNoSpaceScript(tag), false);
  }
});

// --- 4. the tables themselves ----------------------------------------------

test("the script tables say what they mean", () => {
  // Cheap, and it catches the copy-paste that quietly makes a set empty.
  assert.ok(RTL_SCRIPTS.has("Arab"));
  assert.ok(RTL_SCRIPTS.has("Hebr"));
  assert.ok(RTL_SCRIPTS.has("Thaa"));
  assert.ok(RTL_SCRIPTS.has("Nkoo"));
  assert.ok(RTL_SCRIPTS.has("Adlm"));
  assert.equal(RTL_SCRIPTS.has("Latn"), false);
  assert.equal(RTL_SCRIPTS.has("Cyrl"), false);
  assert.equal(RTL_SCRIPTS.has("Hans"), false);
  // Every RTL entry is a well-formed ISO 15924 code in canonical case: a
  // lowercase one would never match `contentScript`'s title-cased answer, and
  // would fail silently rather than loudly.
  for (const script of RTL_SCRIPTS) {
    assert.match(script, /^[A-Z][a-z]{3}$/, `${script} is not canonical`);
  }
  for (const script of NO_SPACE_SCRIPTS) {
    assert.match(script, /^[A-Z][a-z]{3}$/, `${script} is not canonical`);
  }
});

test("the same tag asked twice gives the same answer", () => {
  // There is a cache behind this; a cache that can answer `undefined` for a
  // tag whose real answer is null would recompute forever, and one keyed
  // loosely would cross-contaminate two tags.
  assert.equal(contentScript("und"), null);
  assert.equal(contentScript("und"), null);
  assert.equal(contentDirection("ar"), "rtl");
  assert.equal(contentDirection("ar"), "rtl");
  assert.equal(contentDirection("ar-Latn"), "ltr");
  assert.equal(contentDirection("ar"), "rtl");
});
