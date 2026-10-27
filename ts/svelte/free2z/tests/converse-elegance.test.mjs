import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

/**
 * The /converse elegance pass —.
 *
 * "The amount of verbiage is redundant and infantilizing… It's a microblog.
 * It's obvious… we don't have to put our thumb on the scale."
 *
 * Two things are pinned here, because both regress silently:
 *
 * 1. **The title field is gone and cannot come back.** `Comment.headline`
 *    stays in the model and the API (historic rows have real ones, and the
 *    thread page still renders them), so nothing about the backend stops a
 *    future PR from reintroducing the input.
 * 2. **The copy stays quiet.** Every string in a UI is a string translated
 *    into 50+ languages, and the strings this pass deleted are exactly the
 *    kind that grow back one well-meaning "helpful hint" at a time.
 *
 * NEGATIVE CONTROLS (each was run by reverting the change and re-running):
 *
 *   - restore the `<Input id="converse-headline">` block in
 *     ConverseComposer.svelte        -> "the composer has no title field" fails
 *   - restore `{#if composerOpen}` around <ConverseComposer/>
 *                                    -> "the composer is not behind a toggle" fails
 *   - put "converse.subtitle" back into en.json
 *                                    -> "deleted keys stay deleted" fails
 *   - restore the old promotional en strings (subtitle / bodyPlaceholder /
 *     emptyBody)                     -> "no promotional or editorialising copy"
 *                                       fails, naming each one
 *   - `deriveConverseTitle` returning `getVisibleHeadline(post)` only
 *                                    -> every derived-title test below fails
 *   - drop one locale's deletion (e.g. leave `converse.subtitle` in fr.json)
 *                                    -> "deleted keys stay deleted" fails on fr
 */

const url = (relative) => new URL(relative, import.meta.url);

const composerSource = await readFile(
  url("../src/lib/components/converse/ConverseComposer.svelte"),
  "utf8",
);
const conversePageSource = await readFile(
  url("../src/routes/converse/+page.svelte"),
  "utf8",
);
const threadPageSource = await readFile(
  url("../src/routes/converse/[uuid]/+page.svelte"),
  "utf8",
);

const LOCALES = ["en", "es", "fr", "pt-BR"];
const catalogs = Object.fromEntries(
  await Promise.all(
    LOCALES.map(async (code) => [
      code,
      JSON.parse(
        await readFile(url(`../src/lib/locales/${code}.json`), "utf8"),
      ),
    ]),
  ),
);

let vite;
let utils;

before(async () => {
  const { createServer } = await import("vite");
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  utils = await vite.ssrLoadModule("/src/lib/components/converse/utils.ts");
});

after(async () => {
  await vite?.close();
});

// ---------------------------------------------------------------------------
// The composer asks for a body and nothing else
// ---------------------------------------------------------------------------

describe("the converse composer", () => {
  test("has no title field, in markup or in state", () => {
    assert.doesNotMatch(
      composerSource,
      /converse-headline/,
      "the title input is gone — `Comment.headline` stays optional in the " +
        "API for historic rows, but this UI no longer asks for one",
    );
    assert.doesNotMatch(
      composerSource,
      /\blet headline\b/,
      "a `headline` binding with no input is how the field comes back",
    );
    assert.doesNotMatch(composerSource, /converse\.titlePlaceholder/);
    assert.doesNotMatch(composerSource, /converse\.titleLabel/);
  });

  test("still sends a headline the serializer accepts, and never a sentinel", () => {
    // `Comment.headline` is `blank=True, default=''`, so DRF marks it
    // `required=False` — but the field is still in `CommentCreateSerializer`,
    // and the old "N/A"/"re" sentinels leaked into card titles and auto-tweet
    // prompts. Empty string, explicitly, for roots and replies alike.
    assert.match(composerSource, /headline: ""/);
    assert.doesNotMatch(composerSource, /headline:\s*isReply/);
  });

  test("keeps an accessible name on every control whose label went away", () => {
    // Removing visible text is minimalism. Removing the accessible name is a
    // bug. The body field's <label> is `sr-only`; the 2Z amount's is NOT, and
    // must not become so — submitting debits the author's ledger by that
    // amount, and a spend control with no visible verb discloses nothing to a
    // sighted phone user (raised by the codex review, twice).
    assert.match(
      composerSource,
      /<label\s+for=\{isReply \? `reply-weight-\$\{parent\}` : "converse-weight"\}[\s\S]{0,160}converse\.backWith/,
      "the 2Z amount field must keep a real, visible <label>",
    );
    assert.doesNotMatch(
      composerSource,
      /class="sr-only"[\s\S]{0,120}converse\.backWith/,
      "the money label must not be hidden from sighted users",
    );
    assert.match(
      composerSource,
      /class="sr-only"[\s\S]{0,200}converse\.bodyLabel/,
    );
    // The exact character count is only ever exposed to assistive tech, so it
    // must not be behind the same condition as the visible counter.
    const counterBlock = composerSource.slice(
      composerSource.indexOf("COUNTER_VISIBLE_FROM"),
    );
    assert.match(
      counterBlock,
      /class="sr-only"[\s\S]{0,80}getCharacterCounterLabel/,
      "the screen-reader character count must be unconditional",
    );
  });

  test("the character counter is a limit warning, not permanent furniture", () => {
    assert.match(composerSource, /COUNTER_VISIBLE_FROM/);
    assert.match(
      composerSource,
      /content\.length >= COUNTER_VISIBLE_FROM/,
      "a permanent 0/1,000 under an empty box is noise on every visit",
    );
  });
});

describe("the /converse page", () => {
  test("mounts the responsive composer without conditional draft destruction", () => {
    assert.match(conversePageSource, /<MobileConverseComposer on:posted=/);
  });

  test("keeps the H1 and drops the promotional subtitle", () => {
    assert.match(conversePageSource, /\$t\("converse\.title", "Converse"\)/);
    assert.doesNotMatch(conversePageSource, /converse\.subtitle/);
  });

  test("the RSS link is quiet but still named", () => {
    // Icon-only is fine; anonymous is not.
    const link = conversePageSource.slice(
      conversePageSource.indexOf('data-testid="converse-rss-link"') - 400,
      conversePageSource.indexOf('data-testid="converse-rss-link"') + 600,
    );
    assert.match(link, /aria-label=\{\$t\("converse\.rssLabel"/);
    assert.match(link, /href=\{CONVERSE_RSS_PATH\}/);
  });

  test("the empty state is one line, with no second call to action", () => {
    assert.match(conversePageSource, /converse\.emptyTitle/);
    assert.doesNotMatch(conversePageSource, /converse\.emptyBody/);
    assert.doesNotMatch(conversePageSource, /converse\.emptySearchBody/);
  });
});

describe("the thread page", () => {
  test("names itself after the thread, not after the category", () => {
    assert.match(threadPageSource, /deriveConverseTitle\(comment\)/);
    assert.doesNotMatch(threadPageSource, /converse\.threadTitle/);
    assert.doesNotMatch(threadPageSource, /converse\.threadSubtitle/);
  });

  test("still has exactly one h1, even when nothing is titled", () => {
    // The visible headline moved to <h2> in ConversePost, so a post with no
    // headline would otherwise leave the page with no h1 at all.
    assert.match(
      threadPageSource,
      /<h1 class="sr-only">\{displayTitle\}<\/h1>/,
    );
  });
});

// ---------------------------------------------------------------------------
// A post's name, when nobody typed one
// ---------------------------------------------------------------------------

describe("deriveConverseTitle", () => {
  const derive = (post, max) => utils.deriveConverseTitle(post, max);

  test("prefers a real headline", () => {
    assert.equal(
      derive({ headline: "Shielded notes", content: "body text" }),
      "Shielded notes",
    );
  });

  test("ignores the historic placeholder headlines", () => {
    // comments.0006 blanked the stored "N/A"/"re" rows, but a rolled-back pod
    // or a cached client can still produce one.
    assert.equal(derive({ headline: "N/A", content: "gm" }), "gm");
    assert.equal(derive({ headline: " re ", content: "gm" }), "gm");
  });

  test("falls back to the first non-empty line of the body", () => {
    assert.equal(
      derive({ headline: "", content: "\n\n  first line  \nsecond line" }),
      "first line",
    );
  });

  test("strips markdown leaders so a title is not '## gm'", () => {
    assert.equal(derive({ headline: "", content: "## gm" }), "gm");
    assert.equal(derive({ headline: "", content: "> quoted" }), "quoted");
    assert.equal(derive({ headline: "", content: "- listed" }), "listed");
    assert.equal(derive({ headline: "", content: "1. numbered" }), "numbered");
  });

  test("collapses runs of whitespace", () => {
    assert.equal(
      derive({ headline: "", content: "too   many\tspaces" }),
      "too many spaces",
    );
  });

  test("truncates long bodies on a word boundary", () => {
    const long =
      "the shielded pool is bigger than it was last month and nobody is talking about it";
    const title = derive({ headline: "", content: long });
    assert.ok(title.length <= 61, `too long: ${title.length}`);
    assert.ok(title.endsWith("…"), title);
    // Not mid-word, and not with a dangling space before the ellipsis.
    assert.ok(long.startsWith(title.slice(0, -1)), title);
    assert.doesNotMatch(title, / …$/);
  });

  test("does not truncate a body that already fits", () => {
    assert.equal(derive({ headline: "", content: "gm" }), "gm");
  });

  test("truncates a single unbroken word rather than returning nothing", () => {
    const title = derive({ headline: "", content: "z".repeat(200) }, 20);
    assert.equal(title, `${"z".repeat(20)}…`);
  });

  test("never splits an emoji when it truncates", () => {
    // `String#slice` cuts UTF-16 code units, so a cut landing inside a
    // surrogate pair yields half a character — U+FFFD in the browser tab and
    // in the og:title. A microblog's first line is exactly where emoji live.
    // The 11th code point here is the emoji: a code-unit cut at 11 lands
    // between its surrogates, a code-point cut keeps it whole.
    const title = derive({ headline: "", content: "abcdefghij🎉tail" }, 11);
    assert.equal(title, "abcdefghij🎉…");
    // A lone surrogate — one half of a pair — is the actual defect. A whole
    // pair is fine and must not trip this.
    const loneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    assert.doesNotMatch(title, loneSurrogate, title);
    assert.doesNotMatch(title, /\uFFFD/, title);
    assert.ok(loneSurrogate.test("abcdefghij\uD83C"), "the guard must bite");
  });

  test("never splits a grapheme cluster either", () => {
    // A ZWJ family is one character to a reader and seven code points. A
    // code-point cut at 11 lands inside it and leaves loose people and a
    // dangling U+200D in the browser tab.
    const title = derive({ headline: "", content: "abcdefghij👨‍👩‍👧‍👦tail" }, 11);
    assert.equal(title, "abcdefghij👨‍👩‍👧‍👦…");
    assert.doesNotMatch(title, /\u200D…$/, "dangling zero-width joiner");
  });

  test("counts an emoji as one character, not two", () => {
    assert.equal(derive({ headline: "", content: "🎉🎉🎉" }, 3), "🎉🎉🎉");
  });

  test("returns '' when there is nothing to derive, so the caller can fall back", () => {
    assert.equal(derive({ headline: "", content: "" }), "");
    assert.equal(derive({ headline: "  ", content: "\n \n" }), "");
    assert.equal(derive(null), "");
    assert.equal(derive(undefined), "");
  });
});

describe("zPage source identifiers", () => {
  test("accepts canonical URLs emitted after the cutover", () => {
    assert.equal(
      utils.getSourceIdentifier({
        content_url: "/alice/canonical-article?lang=es",
      }),
      "canonical-article",
    );
  });

  test("keeps accepting permanent legacy redirect URLs", () => {
    assert.equal(
      utils.getSourceIdentifier({
        content_url: "/alice/zpage/legacy-article?lang=es",
      }),
      "legacy-article",
    );
  });

  test("accepts collision-safe immutable article URLs", () => {
    assert.equal(
      utils.getSourceIdentifier({
        content_url: "/article/collision-address?lang=es",
      }),
      "collision-address",
    );
  });

  test("shares the canonical helper's partial-prefix policy", () => {
    assert.equal(
      utils.getSourceIdentifier({ content_url: "/profile/ordinary" }),
      "ordinary",
    );
    assert.equal(
      utils.getSourceIdentifier({ content_url: "/profile/kyc" }),
      null,
    );
    assert.equal(
      utils.getSourceIdentifier({ content_url: "/api/ordinary" }),
      null,
    );
  });

  test("does not mistake unrelated routes for zPages", () => {
    assert.equal(
      utils.getSourceIdentifier({ content_url: "/converse/thread-id" }),
      null,
    );
    assert.equal(utils.getSourceIdentifier({ content_url: "/search" }), null);
  });
});

// ---------------------------------------------------------------------------
// The catalogs
// ---------------------------------------------------------------------------

// Every one of these was on screen at once in the state that prompted this
// pass. They are listed by name so that restoring any of them fails loudly
// rather than quietly re-growing the wall of text.
const DELETED_KEYS = [
  "subtitle",
  "startConversation",
  "closeComposer",
  "titleLabel",
  "titlePlaceholder",
  "startPrompt",
  "signInHint",
  "replyingTo",
  "replyPlaceholder",
  "previewEmpty",
  "emptyBody",
  "emptySearchBody",
  "threadTitle",
  "threadSubtitle",
  "allConversations",
  "discussion",
  "threadStarter",
  "nativeDiscussion",
  // Dead before this pass — referenced by nothing, translated four times.
  "searchResults",
  "loadedCount",
  "linkedDiscussion",
  "openSource",
  "beFirstReply",
];

describe("the converse catalogs", () => {
  test("deleted keys stay deleted, in every locale", () => {
    const rot = [];
    for (const code of LOCALES) {
      for (const key of DELETED_KEYS) {
        if (key in catalogs[code].converse)
          rot.push(`${code}: converse.${key}`);
      }
    }
    assert.deepEqual(
      rot,
      [],
      "a string removed from the UI but left in a catalog is a string still " +
        "being translated into every language we add",
    );
  });

  test("no promotional or editorialising copy in the English catalog", () => {
    // The register the owner asked for: "modest, confident-enough-not-to-
    // advertise-its-strengths-in-the-UI", and a place where somebody is free
    // to shitpost without the interface implying they are in the wrong room.
    // Promotional claims belong in marketing, not in a text field's
    // placeholder.
    const denied = [
      [/\bthoughtful\b/i, "editorialises what a post should be"],
      [/\bworth discussing\b/i, "editorialises what a post should be"],
      [/\bin context\b/i, "advertises a feature inside the feature"],
      [/\bthe community\b/i, "promotional register"],
      [/\bgive the community\b/i, "promotional register"],
      [/\bjoin the conversation\b/i, "promotional register"],
      [/\bclear title\b/i, "there is no title field any more"],
    ];
    const findings = [];
    for (const [key, value] of Object.entries(catalogs.en.converse)) {
      if (typeof value !== "string") continue;
      for (const [pattern, why] of denied) {
        if (pattern.test(value)) findings.push(`converse.${key}: ${why}`);
      }
    }
    assert.deepEqual(findings, []);
  });

  test("the placeholder is short and neutral", () => {
    const placeholder = catalogs.en.converse.bodyPlaceholder;
    assert.ok(
      placeholder.length <= 24,
      `the composer placeholder is read on every visit: "${placeholder}"`,
    );
  });

  test("the four catalogs still agree on the converse key set", () => {
    const reference = Object.keys(catalogs.en.converse).sort();
    for (const code of LOCALES.slice(1)) {
      assert.deepEqual(
        Object.keys(catalogs[code].converse).sort(),
        reference,
        `${code}.json drifted from en.json`,
      );
    }
  });
});
