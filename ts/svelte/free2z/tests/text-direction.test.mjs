// Which way an article's text runs.
//
// The frontend had NO direction handling of any kind — `grep -rn 'dir=' src`
// returned nothing — so a purchased Arabic, Farsi, Hebrew or Urdu translation
// was laid out left-to-right in both the editor and the reader. / had
// already made `<html lang>` describe the CONTENT rather than the reader; `lang`
// and `dir` are independent attributes and fixing one never touched the other.
//
// These are the unit-level halves. The ones that can only be proved in a
// browser — that an element's RESOLVED direction is right-to-left, that the
// chrome's is not, and that a Latin run inside Arabic prose is ordered
// correctly — are `tests/browser/article-direction.spec.ts` and
// `tests/browser/editor-direction.spec.ts`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import {
  RTL_SCRIPTS,
  contentDirection,
  contentScript,
} from "../src/lib/content-direction.js";
import {
  contentDirectionAttribute,
  contentLanguageDirection,
  TRANSLATABLE_LANGUAGES,
} from "../src/lib/zpage-language.js";

/**
 * The tag -> direction entry point. `contentLanguageDirection` normalizes first;
 * `contentDirection` in `content-direction.js` is the primitive underneath it.
 */
const textDirection = contentLanguageDirection;

// `markdown.ts` reads `$env/dynamic/public`, so it only resolves through Vite —
// the same harness `tests/markdown.test.mjs` uses.
let vite;
let processMarkdown;
let sanitizeMarkdownHtml;

before(async () => {
  vite = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { hmr: false, middlewareMode: true },
  });
  ({ processMarkdown } = await vite.ssrLoadModule(
    "/src/lib/utils/markdown.ts",
  ));
  ({ sanitizeMarkdownHtml } = await vite.ssrLoadModule(
    "/src/lib/utils/markdown-sanitize.ts",
  ));
});

after(async () => {
  await vite?.close();
});

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const source = (relativePath) =>
  fs.readFileSync(path.join(UI_ROOT, "..", relativePath), "utf8");

const PARITY = JSON.parse(
  fs.readFileSync(
    fileURLToPath(
      new URL(
        "../../../../py/free2z/dj/apps/g12f/testdata/zpage_language_parity.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
);

/** CLDR's own rtl=YES set, checked in because CI has no network. */
const CLDR_RTL = JSON.parse(
  fs.readFileSync(
    fileURLToPath(
      new URL(
        "../../../../py/free2z/dj/apps/g12f/testdata/cldr_rtl_scripts.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
);

// --- 1. direction comes from the SCRIPT, not from the primary subtag --------

test("every RTL language we sell is right-to-left, by script", () => {
  // FIVE now, not the four  was filed about: `TRANSLATABLE` grew from 39 to
  // 78 the same night this landed and picked up Pashto — and this needed no
  // change at all, because the rule is about the SCRIPT. That is the argument for
  // a script set over a language allow-list, made by the repo rather than by me.
  // In Python: `[t for t in TRANSLATABLE if text_direction(t) == "rtl"]` is
  // `['ar', 'fa', 'he', 'ps', 'ur']`.
  for (const tag of ["ar", "fa", "he", "ps", "ur"]) {
    assert.equal(textDirection(tag), "rtl", tag);
    //...because of the script CLDR says they are written in, which none of
    // them spells out. A guard reading only an explicit `-Arab`/`-Hebr` subtag
    // does not fire for a single one of them.
    assert.ok(
      RTL_SCRIPTS.has(contentScript(tag)),
      `${tag} -> ${contentScript(tag)}`,
    );
    assert.ok(!tag.includes("-"));
    assert.equal(contentDirection(tag), "rtl", tag);
  }
});

test("the sell list can grow an RTL language without a code change", () => {
  // The property, asserted as a property rather than as a list. `TRANSLATABLE`
  // went 39 -> 78 on the same night as this change and gained Pashto; nothing
  // here or in `py/free2z/f2z/languages.py` was touched, because direction is read off
  // the CLDR script. A language allow-list would have needed an edit and, until
  // someone made it, would have laid Pashto out left-to-right.
  //
  // So: every language we sell must resolve to a CONCRETE direction — never
  // `null`, which would mean we are selling a translation into something we
  // cannot lay out.
  for (const tag of TRANSLATABLE_LANGUAGES) {
    const direction = contentLanguageDirection(tag);
    assert.ok(
      direction === "ltr" || direction === "rtl",
      `${tag} is sold but resolves to ${direction}`,
    );
  }
  //...and the set really does contain more than the four the issue named, so
  // this is not vacuously true against a 39-entry list.
  assert.ok(TRANSLATABLE_LANGUAGES.length >= 78, TRANSLATABLE_LANGUAGES.length);
  const rtl = TRANSLATABLE_LANGUAGES.filter(
    (tag) => contentLanguageDirection(tag) === "rtl",
  );
  assert.deepEqual(rtl.toSorted(), ["ar", "fa", "he", "ps", "ur"]);
});

test("romanizing a right-to-left language makes it left-to-right", () => {
  // The case a four-entry list of primary subtags gets backwards in one
  // direction...
  for (const tag of ["ar-Latn", "he-Latn", "ur-Latn"]) {
    assert.equal(textDirection(tag), "ltr", tag);
  }
  //...and this is the same list getting it backwards in the other. `pa` is
  // Gurmukhi and left-to-right; Shahmukhi Punjabi is the same language in the
  // Arabic script and runs the other way.
  assert.equal(textDirection("pa"), "ltr");
  assert.equal(textDirection("pa-Arab"), "rtl");
});

test("a region never changes the script, and other RTL languages work too", () => {
  for (const tag of ["ar-EG", "he-IL", "ur-PK", "fa-AF", "fa-IR"]) {
    assert.equal(textDirection(tag), "rtl", tag);
  }
  // Languages the registry accepts — some we now sell, some we do not yet. None
  // is named anywhere in the implementation; they work because the rule is about
  // scripts.
  for (const tag of ["ps", "sd", "dv", "yi", "ckb"]) {
    assert.equal(textDirection(tag), "rtl", tag);
  }
});

test("a tag that names no language says nothing, and is not 'ltr'", () => {
  for (const value of [
    "und",
    "mul",
    "zxx",
    "mis",
    "",
    "   ",
    null,
    undefined,
    42,
  ]) {
    assert.equal(textDirection(value), null, String(value));
  }
  // Which matters because the two are DIFFERENT declarations at the attribute.
  assert.equal(contentDirectionAttribute("und"), "auto");
  assert.equal(contentDirectionAttribute("en"), "ltr");

  // The trap that made  export no raw tag->direction primitive: CLDR happily
  // maximizes `und` to `Latn`, so a helper that skipped normalization would
  // answer a confident `"ltr"` for text nobody has identified — on a value this
  // codebase really does store. `content-direction.js` closes it at the source by
  // rejecting non-languages in `contentScript` itself, which is why adopting that
  // module removed the sharp edge rather than inheriting it. Pinned so a future
  // "simplification" to a bare `maximize()` cannot quietly reopen it.
  assert.equal(contentScript("und"), null);
  assert.equal(contentDirection("und"), null);
  assert.equal(new Intl.Locale("und").maximize().script, "Latn");
});

/**
 * ISO 15924 **variant** codes for scripts that CLDR does mark right-to-left, and
 * which `scriptMetadata.json` therefore does not list at all.
 *
 * `Aran` is Nastaliq (a style of `Arab`); `Syre`/`Syrj`/`Syrn` are the
 * Estrangelo, Western and Eastern styles of `Syrc`. Both parents are `rtl: YES`,
 * so these are right-to-left by construction — but CLDR has no row for them, so
 * the oracle below cannot confirm them and each has to be exempted explicitly.
 *
 * The exemption EARNS itself: the test asserts each entry is genuinely absent
 * from the oracle and that its parent script is present and RTL. `Todr` could
 * never have been exempted this way, because CLDR has a row for it saying
 * `rtl: NO`.
 *
 * An earlier round of this PR used `Intl.Locale#getTextInfo()` as the oracle and
 * exempted exactly these four on the grounds that `und-<script>` maximizes to
 * `en-<script>-US`. That reached the right verdict for the wrong reason:
 * `getTextInfo()` answers about a LOCALE's layout, so `sq-Todr-AL` says `ltr`
 * about ALBANIAN and nothing about Todhri, and the `en-` maximization was just
 * what "absent from CLDR" looks like through the wrong lens. It also only
 * inspects entries that are PRESENT, which is why it could not find `Sidt`
 * missing.
 */
const ORACLE_EXCEPTIONS = new Set(["Aran", "Syre", "Syrj", "Syrn"]);

test("RTL_SCRIPTS is exactly CLDR's rtl=YES set, plus justified variants", () => {
  // The oracle is CLDR `scriptMetadata.json` itself, checked in as a fixture
  // because CI has no network and an oracle you cannot consult is not an oracle.
  // It is not the implementation because the Python tier has no CLDR API at all
  // and must carry the same literal set — one rule, two runtimes, pinned below.
  //
  // Asserted in BOTH directions, which is the whole point: a wrong entry
  // mis-renders content just as surely as a missing one. Against this oracle the
  // merged set had one of each — `Todr` (rtl=NO) present, and `Sidt` (rtl=YES)
  // absent.
  const oracle = new Set(CLDR_RTL.rtl_scripts);
  assert.ok(oracle.size >= 37, `oracle looks truncated: ${oracle.size}`);

  const extra = [...RTL_SCRIPTS]
    .filter((script) => !oracle.has(script) && !ORACLE_EXCEPTIONS.has(script))
    .sort();
  assert.deepEqual(
    extra,
    [],
    `in RTL_SCRIPTS but not rtl=YES in CLDR: ${extra}`,
  );

  const missing = [...oracle]
    .filter((script) => !RTL_SCRIPTS.has(script))
    .sort();
  assert.deepEqual(missing, [], `CLDR says rtl=YES but we omit: ${missing}`);

  // Every exemption is absent from the oracle -- not merely inconvenient -- and
  // is a variant of a script the oracle DOES mark right-to-left.
  const PARENTS = { Aran: "Arab", Syre: "Syrc", Syrj: "Syrc", Syrn: "Syrc" };
  for (const script of ORACLE_EXCEPTIONS) {
    assert.ok(
      RTL_SCRIPTS.has(script),
      `${script} is exempted but not in the set`,
    );
    assert.ok(
      !oracle.has(script),
      `${script} IS in the oracle, so it must not be exempted`,
    );
    assert.ok(
      oracle.has(PARENTS[script]),
      `${script} is exempt only because its parent ${PARENTS[script]} is rtl=YES`,
    );
  }

  // The two discrepancies this oracle found, pinned by name so a future edit
  // that reintroduces either has to argue with a test rather than a comment.
  assert.ok(!RTL_SCRIPTS.has("Todr"), "Todhri is rtl=NO in CLDR");
  assert.ok(RTL_SCRIPTS.has("Sidt"), "Sidetic is rtl=YES in CLDR");
});

test("the CLDR oracle fixture is the real thing, not a hand-written list", () => {
  // A fixture that drifted from upstream is worse than no fixture: it would keep
  // asserting an answer nobody can trace. Provenance is part of the contract.
  assert.match(CLDR_RTL.cldr_version, /^\d+\.\d+\.\d+$/);
  assert.equal(CLDR_RTL.source, "cldr-json/cldr-core/scriptMetadata.json");
  assert.ok(
    CLDR_RTL._comment.join(" ").includes("scriptMetadata.json"),
    "the fixture must say where it came from",
  );
  // Spot-check the shape against facts that cannot quietly change: the four
  // scripts the product actually sells into, and one that must NOT be there.
  for (const script of ["Arab", "Hebr", "Thaa", "Syrc"]) {
    assert.ok(CLDR_RTL.rtl_scripts.includes(script), script);
  }
  assert.ok(!CLDR_RTL.rtl_scripts.includes("Latn"));
  assert.ok(!CLDR_RTL.rtl_scripts.includes("Todr"));
});

test("the JS and Python non-language subtag sets agree", () => {
  // `NON_LANGUAGE_PRIMARY_SUBTAGS` exists in BOTH `content-direction.js` and
  // `zpage-language.js` with a comment saying "Mirrors..." and, until now,
  // nothing enforcing it. An unenforced mirror is a comment, not an invariant,
  // and this one decides whether `und` reaches a direction helper at all.
  const subtagsOf = (relativePath) => {
    const text = source(relativePath);
    const match = text.match(
      /NON_LANGUAGE_PRIMARY_SUBTAGS\s*=\s*(?:Object\.freeze\()?new Set\(\[([\s\S]*?)\]\)/,
    );
    assert.ok(match, `no NON_LANGUAGE_PRIMARY_SUBTAGS in ${relativePath}`);
    return [...match[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort();
  };
  const fromDirection = subtagsOf("src/lib/content-direction.js");
  const fromLanguage = subtagsOf("src/lib/zpage-language.js");
  assert.deepEqual(fromDirection, fromLanguage);
  // NOT grepped out of `py/free2z/f2z/languages.py`: Python rejects these by their IANA
  // *scope* (`special`/`collection`/`private-use`), so it has no literal list to
  // compare against and asserting one would pin an implementation detail it is
  // right not to have. The cross-runtime half is behavioural and lives where it
  // can actually run — `test_crawler_language.py` asserts
  // `direction_attribute(...) == "auto"` and that `normalize` raises, for each of
  // these subtags.
});

// --- 2. the cross-runtime golden table -------------------------------------

test("direction resolves identically in both runtimes", () => {
  // `py/free2z/dj/apps/g12f/test_crawler_language.py` asserts the very same table
  // against `f2z.languages.direction_attribute`. The Django crawler tier
  // renders the same URL as SvelteKit (nginx's `prerender` cookie outcome), so
  // a divergence lays one article out two ways depending on which upstream
  // answered — the  failure shape, one attribute over.
  assert.ok(PARITY.direction.length >= 40, "the table must be worth having");
  for (const { tag, dir } of PARITY.direction) {
    assert.equal(contentDirectionAttribute(tag), dir, `?lang=${tag}`);
  }
  // Every one of the four is in there.
  const tags = new Set(PARITY.direction.map((entry) => entry.tag));
  for (const tag of ["ar", "fa", "he", "ur"]) assert.ok(tags.has(tag), tag);
});

test("the content entry point refuses the `und` sentinel specifically", () => {
  // `normalizeContentLanguage` already rejects it, but `und` is a STORED value
  // on legacy articles rather than a typo, so the path deserves its own pin: an
  // unlabelled article gets `auto` and the browser reads its text, not a silent
  // left-to-right.
  assert.equal(contentLanguageDirection("und"), null);
  assert.equal(contentDirectionAttribute("und"), "auto");
  assert.equal(contentDirectionAttribute(null), "auto");
  assert.equal(contentDirectionAttribute("ar"), "rtl");
  // Normalization still happens on the way in.
  assert.equal(contentDirectionAttribute(" AR-eg "), "rtl");
  assert.equal(contentDirectionAttribute("pt"), "ltr");
});

// --- 3. per-block direction in rendered markdown ---------------------------

test("a fenced code block is left-to-right and isolated", () => {
  const html = processMarkdown(
    ["```sh", "npm run build && echo done", "```"].join("\n"),
  );
  assert.match(html, /<pre dir="ltr">/);
  // Including mermaid, which takes a different branch of the renderer.
  const mermaid = processMarkdown(
    ["```mermaid", "graph TD;", "```"].join("\n"),
  );
  assert.match(mermaid, /<pre dir="ltr">/);
});

test("an inline code span states its direction and isolates itself", () => {
  const html = processMarkdown("العلامة `--flag=value` و `2Z`");
  const spans = html.match(/<code[^>]*>/g) || [];
  assert.equal(spans.length, 2);
  // `ltr` and not `auto`: `MarkdownContent` already sets `direction: ltr` on
  // every `code`, so an `auto` attribute described a rendering that never
  // happened (codex round 3). The attribute agrees with the CSS now, and still
  // earns its place through the isolate — asserted in the browser spec, because
  // `unicode-bidi` is the half a `direction` declaration cannot express.
  for (const span of spans) assert.match(span, /dir="ltr"/);
  // The override took over marked's escaping, so it has to still escape.
  assert.match(processMarkdown("`a<b&c>d`"), /a&lt;b&amp;c&gt;d/);
  assert.doesNotMatch(processMarkdown("`<script>`"), /<script>/);
});

test("a bare URL is left-to-right; link text that is prose is not", () => {
  const bare = processMarkdown("اقرأ https://example.com/a?b=1&c=2 هنا");
  assert.match(bare, /<a href="https:\/\/example\.com[^"]*"[^>]*dir="ltr"/);

  //...and the decision is made from the TEXT, not the href: every link has an
  // LTR href, and an Arabic label must run with the sentence around it.
  const prose = processMarkdown("[الصفحة الرئيسية](https://example.com/)");
  const anchor = prose.match(/<a [^>]*>/)[0];
  assert.doesNotMatch(anchor, /dir=/);

  // An explicit `[url](url)` is still a URL.
  const explicit = processMarkdown(
    "[https://example.com/x](https://example.com/x)",
  );
  assert.match(explicit.match(/<a [^>]*>/)[0], /dir="ltr"/);
});

test("ordinary prose blocks are NOT given dir=auto", () => {
  // The container states the base direction from the language, and `auto` would
  // undo it: an Arabic paragraph opening with "Zcash" has a Latin first strong
  // character and would be laid out left-to-right by the heuristic. This is why
  // the fix is a targeted set of overrides rather than `dir="auto"` everywhere.
  const html = processMarkdown("Zcash هو عملة معماة\n\n> اقتباس\n\n- بند");
  for (const tag of ["<p", "<blockquote", "<li", "<ul"]) {
    const opening = html.match(new RegExp(`${tag}[^>]*>`));
    if (!opening) continue;
    assert.doesNotMatch(opening[0], /dir=/, opening[0]);
  }
});

test("the sanitizer keeps dir, and it is declared in ADD_ATTR", () => {
  // `dir` is in DOMPurify's default allowlist, so this is a regression guard
  // against a future config that narrows the attribute set: losing it drops the
  // isolate silently and nothing on the page looks broken enough to notice.
  const kept = sanitizeMarkdownHtml(
    '<pre dir="ltr"><code dir="auto">x</code></pre>',
  );
  assert.match(kept, /<pre dir="ltr">/);
  assert.match(kept, /dir="auto"/);
  assert.match(source("src/lib/utils/markdown-sanitize.ts"), /^\s*"dir",$/m);
});

// --- 4. the surfaces actually carry it ------------------------------------

test("the reader declares direction on the content, never on <html>", () => {
  for (const route of [
    "src/routes/[username]/[vanity]/+page.svelte",
    "src/routes/article/[id]/+page.svelte",
  ]) {
    const text = source(route);
    // Same element the content `lang` is on, and from one helper.
    assert.match(text, /contentDirectionAttribute/, route);
    assert.match(
      text,
      /<article[\s\S]{0,200}?dir=\{articleContentDirection\}/,
      route,
    );
    assert.match(
      text,
      /<h1[\s\S]{0,200}?dir=\{articleContentDirection\}/,
      route,
    );
  }
  // The document element is deliberately untouched: an Arabic article does not
  // entitle us to flip an English-reading visitor's navbar, and RTL
  // product UI is.
  assert.doesNotMatch(source("src/hooks.server.ts"), /\bdir=/);
  assert.doesNotMatch(source("src/app.html"), /<html[^>]*\bdir=/);
  assert.doesNotMatch(source("src/lib/i18n.ts"), /documentElement\.dir/);
});

test("the editor's writing surface and preview share the reader's helper", () => {
  const composer = source("src/lib/components/mdEditor/EditorComposer.svelte");
  assert.match(composer, /contentDirectionAttribute/);
  // The article's language, not the creator's UI locale.
  // The ARTICLE's language, and not even the editor's own presumed label for a
  // fresh draft — which IS the creator's UI locale, because `+page.ts` falls
  // `requestedLanguage` back to `layout.locale`. Composer and preview take the
  // same value or they can disagree about one document.
  const editor = source("src/routes/edit/+page.svelte");
  assert.equal((editor.match(/language=\{writingLanguage\}/g) || []).length, 2);
  assert.doesNotMatch(editor, /language=\{openLanguage\}/);
  // Direction follows a STATED language, never the editor's presumed label, and
  // in particular never "the article exists now" — which is what the first
  // autosave makes true while the label is still the UI locale.
  assert.match(editor, /const writingLanguage = \$derived\(languageIsStated/);
  assert.match(
    editor,
    /languageIsStated = \$derived\([\s\S]{0,400}?getRouteData\(\)\.zpage/,
  );
  assert.doesNotMatch(
    editor,
    /languageIsStated = \$derived\([\s\S]{0,400}?Boolean\(currentZPage\)/,
  );

  // `languageIsStated` must derive ONLY from state that is replaced wholesale, so
  // there is no path on which it can go stale. Route data is replaced by the
  // loader; `currentZPage`'s fields are replaced by hydration.
  //
  // This replaces a structural pin on a latched `languageStatedByCreator`, which
  // accumulated FOUR defects in its lifecycle — the last two being "survives a
  // client-side navigation" and "survives a SHALLOW one", because
  // `updateEditorUrl` uses `replaceState` and the hydration key is unchanged for a
  // never-saved draft. A latch has to be cleared on every path that replaces the
  // document and we missed four; the fix was to remove the remembered state, not
  // to add a fifth reset.
  //
  // So this asserts the SHAPE, which is the thing that was wrong: no assignment
  // may appear in the derivation's inputs.
  const stated = editor.slice(
    editor.indexOf("const languageIsStated = $derived("),
    editor.indexOf("const writingLanguage = $derived("),
  );
  assert.ok(stated.length > 0, "languageIsStated must exist");
  assert.doesNotMatch(
    stated,
    /languageStatedByCreator/,
    "the latched flag is gone; do not reintroduce it — see the docstring",
  );
  // EVERY term is route data — not "route data or a `currentZPage` field", which
  // is what this asserted until F5. `currentZPage` moves under a save, and two
  // terms that read it turned the backend's detection into permission to assert
  // the UI LOCALE's direction, because the value being gated (`selectedLanguage`)
  // is never moved by a save response. Route data cannot make that mistake: it is
  // the same source `selectedLanguage` itself derives from.
  const terms = [...stated.matchAll(/^\s{6}([^\n]+?)\s*(?:\|\||,)\s*$/gm)].map(
    (match) => match[1],
  );
  assert.equal(terms.length, 3, `expected three terms, got ${terms}`);
  for (const term of terms) {
    assert.match(
      term,
      /^getRouteData\(\)\./,
      `\`${term}\` is not route data, so it can move under a save`,
    );
  }
  // Named explicitly, because "not route data" is the general rule and these two
  // are the specific readings that caused F5.
  assert.doesNotMatch(stated, /detected_language/);
  assert.doesNotMatch(stated, /language_source/);
  assert.doesNotMatch(stated, /currentZPage/);
  // And no `$state` declaration exists to remember a creator's choice across
  // documents, which is what made the first four defects possible.
  assert.doesNotMatch(editor, /let languageStatedByCreator/);

  const body = source("src/lib/components/mdEditor/EditorContentField.svelte");
  assert.match(body, /<textarea[\s\S]{0,400}?dir=\{direction\}/);
  // The gutter control  is placed logically, so one `dir` flips it.
  assert.match(body, /class="relative" dir=\{resolvedDirection\}/);
  assert.match(body, /absolute start-0/);
  assert.doesNotMatch(body, /absolute left-0/);
  assert.match(body, /md:me-1\.5/);

  const title = source("src/lib/components/mdEditor/EditorTitleField.svelte");
  assert.match(title, /<textarea[\s\S]{0,200}?dir=\{direction\}/);

  // Preview and reader must agree, which is only true if both call the same
  // function on the same value.
  const preview = source("src/lib/components/mdEditor/EditorPreview.svelte");
  assert.match(preview, /contentDirectionAttribute\(language\)/);
  assert.match(preview, /<article\s+dir=\{previewDirection\}/);
  //...and the preview's hand-written prose CSS has to be logical or it
  // disagrees with the reader's `prose`, which already is.
  assert.doesNotMatch(preview, /padding-left|border-left|text-align: left/);
});

test("the Python registry mirrors the RTL script set", () => {
  // Not a substitute for the golden table — that pins the ANSWERS — but a
  // divergence in the set itself is worth catching at the source, since the two
  // literals are the one thing neither runtime can derive from the other.
  const python = fs.readFileSync(
    fileURLToPath(
      new URL("../../../../py/free2z/f2z/languages.py", import.meta.url),
    ),
    "utf8",
  );
  const block = python.match(/RTL_SCRIPTS = frozenset\(\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(
    block,
    "RTL_SCRIPTS must be a frozenset literal in f2z/languages.py",
  );
  const pythonScripts = new Set(
    [...block[1].matchAll(/"([A-Za-z]{4})"/g)].map((match) => match[1]),
  );
  assert.deepEqual([...pythonScripts].sort(), [...RTL_SCRIPTS].sort());
});
