// Cross-runtime parity for the FALLBACK zPage meta description.
//
// `k8s/free2z/nginx.conf` splits crawlers by User-Agent and hands the two
// halves to two DIFFERENT renderers: `$seobot` (googlebot, bingbot, gptbot,
// claudebot, applebot, perplexity, …) to this SvelteKit app, `$prerender`
// (twitter, facebook, slack, discord, telegram, whatsapp, …) to the Django
// crawler tier. Both compute this string, in two languages, and until
// they agreed on nothing — 200 characters vs 300, word boundary vs mid-word,
// markdown stripped vs untouched, whitespace collapsed vs a literal newline
// sitting inside the HTML attribute. Measured live on one article at one
// moment: Googlebot 194 characters, Twitterbot 310.
//
// So the expected answer lives in ONE file and both suites assert against it:
//
//   py/free2z/dj/apps/g12f/testdata/meta_description_parity.json
//     ← this file, over compactText() in src/lib/seo.ts
//     ← py/free2z/dj/apps/g12f/test_meta_description.py, over compact_text()
//
// Change one implementation without the other and both suites go red. That is
// the entire point of the file; do not "fix" a failure here by editing the
// table unless you have changed both implementations to match it.
//
// What this does NOT prove: that either tier's page-level code CALLS the
// shared helper. `buildDescription()` in src/lib/meta.ts is covered by
// social-card-parity.test.mjs; the Django view is covered by the second half
// of test_meta_description.py against real Postgres.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const PARITY_FIXTURE = new URL(
  "../../../../py/free2z/dj/apps/g12f/testdata/meta_description_parity.json",
  import.meta.url,
);
const CRAWLER_VIEW = new URL(
  "../../../../py/free2z/dj/apps/g12f/views/crawler.py",
  import.meta.url,
);
const META_DESCRIPTION_PY = new URL(
  "../../../../py/free2z/dj/apps/g12f/meta_description.py",
  import.meta.url,
);

const parity = JSON.parse(readFileSync(PARITY_FIXTURE, "utf8"));

let compactText;
let stripMarkdown;
let truncateText;
let META_DESCRIPTION_CHARS;
let DESCRIPTION_SOURCE_CHARS;
let server;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({
    compactText,
    stripMarkdown,
    truncateText,
    META_DESCRIPTION_CHARS,
    DESCRIPTION_SOURCE_CHARS,
  } = await server.ssrLoadModule("/src/lib/seo.ts"));
});

after(async () => {
  await server?.close();
});

test("the golden table is not empty and names its real reproductions", () => {
  // A table that silently loses its cases still passes every parametrized
  // assertion below, which is the failure mode this guards.
  assert.ok(parity.cases.length >= 15);
  const values = parity.cases.map((entry) => entry.value);
  // /example_creator/maps — the Django tier served this AS the meta description,
  // heading, directive, newlines and all.
  assert.ok(
    values.includes("# Maps\n\n\n\n::embed[/uploadz/public/example/clip.mp4]"),
  );
  // /example_creator/video-example — this tier ate the `_` in `?si=…` and
  // published a broken URL in Google's snippet.
  assert.ok(
    values.includes(
      "::embed[https://youtu.be/abc_DEFgh12?si=sample_under_score]",
    ),
  );
});

test("every case in the golden table derives the same answer here", () => {
  for (const entry of parity.cases) {
    assert.equal(
      compactText(
        entry.value,
        entry.fallback ?? "",
        entry.max_length ?? META_DESCRIPTION_CHARS,
      ),
      entry.expected,
      entry.name,
    );
  }
});

test("no expected answer can break an HTML attribute", () => {
  // The class of defect, stated as an invariant rather than case by case: a
  // raw newline inside `content="…"` is what /example_creator/maps served in prod.
  for (const entry of parity.cases) {
    const { expected, name } = entry;
    assert.ok(!/[\n\r\t]/.test(expected), name);
    assert.ok(!expected.includes("  "), name);
    assert.equal(expected, expected.trim(), name);
    assert.ok(
      Array.from(expected).length <=
        (entry.max_length ?? META_DESCRIPTION_CHARS),
      name,
    );
  }
});

test("a URL keeps its underscores", () => {
  // The defect this replaced: `[#*_>`~|]` as a character class turned
  // `?si=AAMiA_b4jz8To4ik` into `?si=AAMiA b4jz8To4ik` and published it.
  const url = "https://youtu.be/abc_DEFgh12?si=sample_under_score";
  assert.ok(
    stripMarkdown(`Watch it here: ${url} — bring questions.`).includes(url),
  );
  assert.equal(stripMarkdown("snake_case_name"), "snake_case_name");
  // Intraword `__` is not emphasis under CommonMark either.
  assert.equal(stripMarkdown("a__b"), "a__b");
});

test("emphasis at a word boundary is still stripped", () => {
  assert.equal(stripMarkdown("_italic_"), "italic");
  assert.equal(stripMarkdown("__bold__ text"), "bold text");
  assert.equal(stripMarkdown("wrap _this_ up"), "wrap this up");
});

test("an embed directive is never description text", () => {
  assert.equal(stripMarkdown("::embed[/uploadz/public/x/clip.mp4]"), "");
  assert.equal(
    stripMarkdown("Intro.\n::embed[/x.mp4]\nOutro."),
    "Intro. Outro.",
  );
});

test("only the renderer's own directive shape counts as markup", () => {
  // src/lib/utils/markdown.ts is line-anchored with a closed set of three
  // names. A broader "any `::name`" rule publishes `Use std here` for an
  // article that visibly renders `Use std::vector here`.
  assert.equal(stripMarkdown("Use std::vector here."), "Use std::vector here.");
  assert.equal(
    stripMarkdown("See https://ex.com/a::b now."),
    "See https://ex.com/a::b now.",
  );
  assert.equal(
    stripMarkdown("Look at ::embed[/x.mp4] inline."),
    "Look at ::embed[/x.mp4] inline.",
  );
});

test("the two runtimes cannot disagree about whitespace", () => {
  // Python's `\s` matches U+001C–U+001F and U+0085; ECMAScript's does not.
  // ECMAScript's matches U+FEFF; Python's does not. Left to a bare `\s+`
  // collapse that is a cross-tier divergence in the one function whose whole
  // purpose is not to have one, so everything whitespace-ish except `\n` is
  // folded to U+0020 before any of it is consulted.
  assert.equal(
    stripMarkdown("alpha\u0085beta\u00a0gamma\ufeffdelta"),
    "alpha beta gamma delta",
  );
});

test("zero-width joiners are meaning, not noise", () => {
  // Stripping ZWJ splits one emoji into two and reshapes Persian and Indic.
  assert.equal(
    stripMarkdown("Built by \u{1F469}\u200d\u{1F4BB} here."),
    "Built by \u{1F469}\u200d\u{1F4BB} here.",
  );
});

test("a comparison is not an HTML tag", () => {
  // The old `<[^>]*>` — and Django's strip_tags — both ate this.
  assert.equal(
    stripMarkdown("latency < 200 and rate > 5"),
    "latency < 200 and rate > 5",
  );
  // …but a tag spanning a newline still is one.
  assert.equal(stripMarkdown('<img\n  src="/x.png">After.'), "After.");
  assert.equal(stripMarkdown("<!-- note -->Visible."), "Visible.");
});

test("both tiers read the same source window", () => {
  // The parity gap one layer ABOVE the rules (codex adversarial review):
  // Django never holds more than a 4,000-character Substr of `content`, while
  // this tier's caller has the whole article from the API. Feeding the same
  // function two different windows is the same divergence  is about, so
  // the clamp lives inside the derivation rather than in either caller.
  const body = `\`\`\`\n${"x".repeat(5000)}\n\`\`\`\n\nVisible prose after it.`;
  assert.equal(compactText(body, "Fallback."), "Fallback.");
  assert.equal(
    compactText(body.slice(0, DESCRIPTION_SOURCE_CHARS), "Fallback."),
    "Fallback.",
  );
  assert.equal(DESCRIPTION_SOURCE_CHARS, 4000);
  assert.match(
    readFileSync(META_DESCRIPTION_PY, "utf8"),
    /^DESCRIPTION_SOURCE_CHARS = 4000$/m,
  );
  // And Django's excerpt is never SHORTER than the window read here.
  const crawler = readFileSync(CRAWLER_VIEW, "utf8");
  const cardBody = Number(/^CARD_BODY_CHARS = (\d+)$/m.exec(crawler)[1]);
  assert.ok(cardBody >= DESCRIPTION_SOURCE_CHARS);
});

test("only a line-anchored fence opens a code block", () => {
  // Unanchored, the prose "Type ``` to open a block" reads as an unterminated
  // fence and deletes everything after it — in a 4,000-character excerpt that
  // is the whole rest of the description.
  assert.equal(
    stripMarkdown("Type ``` to open a block, then continue."),
    "Type to open a block, then continue.",
  );
  assert.equal(stripMarkdown("Intro.\n\n```js\nconst x = 1;"), "Intro.");
});

test("a closing fence must be at least as long as its opener", () => {
  // CommonMark's rule, and markdown.ts's. With a fixed ``` pattern the literal
  // ``` line inside a four-backtick block reads as the close and the real
  // close reads as a fresh unterminated opener — so the card publishes code
  // from inside the block and deletes the prose after it.
  const body = "````md\ninside\n```\nstill inside\n````\n\nThe real prose.";
  assert.equal(stripMarkdown(body), "The real prose.");
  // And an UNTERMINATED four-backtick block is not closed by the ``` inside it
  // either — the info string must exclude backticks or the capture backtracks.
  assert.equal(
    stripMarkdown("Intro sentence.\n\n````md\ncode\n```\nmore code, no close"),
    "Intro sentence.",
  );
});

test("case-insensitivity is ASCII-only in both runtimes", () => {
  // Python's Unicode IGNORECASE folds U+0130 onto `i`; JavaScript's `/i` does
  // not. Without `re.A` on the Python side, `::İframe[x]` is markup to Django
  // and literal text here — the same split, one layer down.
  assert.equal(
    stripMarkdown("::\u0130frame[/x.mp4] here."),
    "::\u0130frame[/x.mp4] here.",
  );
  assert.equal(stripMarkdown("::IFRAME[/x.mp4]"), "");
});

test("digit classes are ASCII-only in both runtimes", () => {
  // Python's `\d` matches Unicode digits and this runtime's does not, so an
  // Arabic article opening `١. …` would lose its numbering on the Django tier
  // and keep it here. Both spell the class `[0-9]`.
  assert.equal(stripMarkdown("١. مقدمة"), "١. مقدمة");
  assert.equal(stripMarkdown("1. ASCII item"), "ASCII item");
});

test("headings are line-anchored, so a hashtag survives mid-sentence", () => {
  assert.equal(stripMarkdown("# Maps"), "Maps");
  assert.equal(stripMarkdown("Filed under #zcash"), "Filed under #zcash");
});

test("truncation counts code points, not UTF-16 code units", () => {
  // 150 astral emoji are 150 code points and 300 `String#length` units. The
  // old implementation used `.length`, so it truncated a string Python would
  // have passed through untouched — the two tiers cutting the same text in
  // different places is the whole bug.
  const text = `${"🙂".repeat(150)} tail`;
  assert.equal(text.length, 305);
  assert.equal(Array.from(text).length, 155);
  assert.equal(truncateText(text), text);
});

test("the ellipsis is inside the budget, and never orphaned by a space", () => {
  const result = truncateText(stripMarkdown("word ".repeat(200)));
  assert.ok(Array.from(result).length <= META_DESCRIPTION_CHARS);
  assert.ok(result.endsWith("…"));
  assert.ok(!result.endsWith(" …"));
});

test("a single oversized token is cut, not erased", () => {
  // Without the word-boundary floor this returns an ellipsis and nothing else.
  const result = truncateText("x".repeat(400));
  assert.equal(Array.from(result).length, META_DESCRIPTION_CHARS);
  assert.equal(result, `${"x".repeat(META_DESCRIPTION_CHARS - 1)}…`);
});

test("an empty value falls back — `value ?? fallback` did not", () => {
  // `parsedBio.body` for a creator with no bio is `''`, not null, so the old
  // nullish coalescing stamped an EMPTY meta description on their profile.
  assert.equal(compactText("", "Fallback."), "Fallback.");
  assert.equal(compactText("   \n\n  ", "Fallback."), "Fallback.");
  assert.equal(compactText(null, "Fallback."), "Fallback.");
});

test("both tiers agree on the shared bound", () => {
  // Retuning one side and not the other re-creates  exactly: Google and
  // Slack handed different-length descriptions for the same article. The
  // golden table would catch a change to the DEFAULT only indirectly (its
  // cases pass max_length through), so pin the number itself, on both sides.
  assert.equal(META_DESCRIPTION_CHARS, 200);
  assert.match(
    readFileSync(META_DESCRIPTION_PY, "utf8"),
    /^META_DESCRIPTION_CHARS = 200$/m,
  );
  // …and that the Django card view really takes its bound from there rather
  // than keeping the 300 it used to hardcode.
  assert.match(
    readFileSync(CRAWLER_VIEW, "utf8"),
    /^CARD_DESCRIPTION_CHARS = META_DESCRIPTION_CHARS$/m,
  );
});
