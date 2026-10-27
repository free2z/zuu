import assert from "node:assert/strict";
import test from "node:test";

import { parseBioFrontmatter, sameAsUrls } from "../src/lib/utils/bio.js";

test("strips fenced frontmatter and parses a twitter handle (real #566 shape)", () => {
  const bio = "---\nsocials:\n  twitter: _skyl\n---\n\nHello **world**";
  const { body, socials } = parseBioFrontmatter(bio);

  assert.equal(body, "Hello **world**");
  assert.equal(socials.length, 1);
  assert.deepEqual(socials[0], {
    key: "twitter",
    label: "X",
    value: "_skyl",
    url: "https://x.com/_skyl",
    display: "@_skyl",
  });
});

test("returns the bio unchanged when there is no frontmatter", () => {
  const bio = "Just a normal bio.\n\nWith paragraphs.";
  const { body, socials } = parseBioFrontmatter(bio);

  assert.equal(body, bio);
  assert.deepEqual(socials, []);
});

test("does not treat a leading markdown thematic break as frontmatter", () => {
  // No closing fence -> not frontmatter, body is untouched.
  const bio = "---\n\nA divider, not frontmatter.";
  const { body, socials } = parseBioFrontmatter(bio);

  assert.equal(body, bio);
  assert.deepEqual(socials, []);
});

test("parses a bare (unfenced) leading socials block", () => {
  const bio = "socials:\n  github: someuser\n\nBody text here.";
  const { body, socials } = parseBioFrontmatter(bio);

  assert.equal(body, "Body text here.");
  assert.equal(socials.length, 1);
  assert.equal(socials[0].url, "https://github.com/someuser");
});

test("normalizes aliases (x, url) and renders in canonical order", () => {
  const bio = [
    "---",
    "socials:",
    "  url: example.com",
    "  x: '@alice'",
    "  github: alice",
    "---",
    "",
    "Bio",
  ].join("\n");
  const { socials } = parseBioFrontmatter(bio);

  assert.deepEqual(
    socials.map((s) => s.key),
    ["twitter", "github", "website"],
  );
  const website = socials.find((s) => s.key === "website");
  assert.equal(website.url, "https://example.com");
  assert.equal(website.display, "example.com");
  const twitter = socials.find((s) => s.key === "twitter");
  assert.equal(twitter.url, "https://x.com/alice");
});

test("passes through full URLs and resolves nostr/mastodon shorthands", () => {
  const bio = [
    "---",
    "socials:",
    "  website: https://free2z.cash/skylar",
    "  mastodon: alice@mastodon.social",
    "  nostr: npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzzzz",
    "---",
    "body",
  ].join("\n");
  const { socials } = parseBioFrontmatter(bio);
  const byKey = Object.fromEntries(socials.map((s) => [s.key, s]));

  assert.equal(byKey.website.url, "https://free2z.cash/skylar");
  assert.equal(byKey.mastodon.url, "https://mastodon.social/@alice");
  assert.equal(
    byKey.nostr.url,
    "https://njump.me/npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzzzz",
  );
});

test("ignores unknown keys and empty values", () => {
  const bio = "---\nsocials:\n  twitter:\n  myspace: tom\n---\nbody";
  const { socials } = parseBioFrontmatter(bio);
  assert.deepEqual(socials, []);
});

test("handles null / empty input defensively", () => {
  assert.deepEqual(parseBioFrontmatter(null), { body: "", socials: [] });
  assert.deepEqual(parseBioFrontmatter(""), { body: "", socials: [] });
  assert.deepEqual(parseBioFrontmatter(undefined), { body: "", socials: [] });
});

// sameAsUrls() -- issue. `sameAs` is an identity assertion, so a link
// only counts when its resolved URL genuinely lands on that platform's own
// domain, never merely because it was written under that platform's key.
test("a handle-shaped social resolves onto its platform's own domain and qualifies", () => {
  const bio = "---\nsocials:\n  twitter: _skyl\n  github: alice\n---\nbody";
  const { socials } = parseBioFrontmatter(bio);

  assert.deepEqual(sameAsUrls(socials), [
    "https://x.com/_skyl",
    "https://github.com/alice",
  ]);
});

test("a raw URL claiming to be a platform link is dropped unless it actually is one (codex finding, #1094)", () => {
  const bio = [
    "---",
    "socials:",
    "  twitter: https://unrelated.example/famous-person",
    "---",
    "body",
  ].join("\n");
  const { socials } = parseBioFrontmatter(bio);

  assert.deepEqual(sameAsUrls(socials), []);
});

test("a raw URL that genuinely points at the platform's domain still qualifies", () => {
  const bio = [
    "---",
    "socials:",
    "  twitter: https://x.com/_skyl",
    "  github: https://www.github.com/alice",
    "---",
    "body",
  ].join("\n");
  const { socials } = parseBioFrontmatter(bio);

  assert.deepEqual(sameAsUrls(socials), [
    "https://x.com/_skyl",
    "https://www.github.com/alice",
  ]);
});

test("mastodon, nostr and website are excluded -- no single canonical domain to check", () => {
  const bio = [
    "---",
    "socials:",
    "  website: https://free2z.cash/skylar",
    "  mastodon: alice@mastodon.social",
    "  nostr: npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzzzzzz",
    "---",
    "body",
  ].join("\n");
  const { socials } = parseBioFrontmatter(bio);

  assert.deepEqual(sameAsUrls(socials), []);
});

test("sameAsUrls tolerates an empty list", () => {
  assert.deepEqual(sameAsUrls([]), []);
});

// A same-host URL that is NOT actually a profile (a repo, a video, a search
// page, or the bare host) must not qualify -- a host allowlist alone was not
// enough (codex review, ).
test("a same-host URL that is not a profile page is rejected", () => {
  const bio = [
    "---",
    "socials:",
    "  twitter: https://x.com/",
    "  github: https://github.com/alice/some-project",
    "  youtube: https://youtube.com/watch?v=dQw4w9WgXcQ",
    "  instagram: https://instagram.com/p/Cxyz123/",
    "---",
    "body",
  ].join("\n");
  const { socials } = parseBioFrontmatter(bio);

  assert.deepEqual(sameAsUrls(socials), []);
});

test("known utility/reserved routes (github login, facebook share.php) are rejected (codex finding)", () => {
  const bio = [
    "---",
    "socials:",
    "  github: https://github.com/login",
    "  facebook: https://facebook.com/share.php?u=https://example.com",
    "---",
    "body",
  ].join("\n");
  const { socials } = parseBioFrontmatter(bio);

  assert.deepEqual(sameAsUrls(socials), []);
});

test("a query string or fragment disqualifies an otherwise profile-shaped URL", () => {
  const bio = [
    "---",
    "socials:",
    "  twitter: https://x.com/alice?ref=bio",
    "  github: https://github.com/alice#readme",
    "---",
    "body",
  ].join("\n");
  const { socials } = parseBioFrontmatter(bio);

  assert.deepEqual(sameAsUrls(socials), []);
});

test("real profile-shaped URLs on linkedin/reddit/telegram/youtube qualify", () => {
  const bio = [
    "---",
    "socials:",
    "  linkedin: https://linkedin.com/in/alice-example",
    "  reddit: https://reddit.com/u/alice",
    "  telegram: https://t.me/alice_example",
    "  youtube: https://youtube.com/@alice",
    "---",
    "body",
  ].join("\n");
  const { socials } = parseBioFrontmatter(bio);

  assert.deepEqual(sameAsUrls(socials), [
    "https://youtube.com/@alice",
    "https://linkedin.com/in/alice-example",
    "https://reddit.com/u/alice",
    "https://t.me/alice_example",
  ]);
});

// International YouTube handles (codex review, ). `new URL()`
// percent-encodes a non-ASCII pathname, so an ASCII-only allowlist silently
// drops a handle YouTube itself considers valid -- a false negative that
// costs a real creator their `sameAs` with no error anywhere.
test("an international youtube handle still qualifies for sameAs", () => {
  // Two codex rounds each named a different valid handle that a tighter
  // character class dropped: a 4-char Han handle, then a 2-char Han/Hangul
  // one, then the middle dot. The check now pins delimiters, not alphabet.
  //
  // The published value is the PARSED url, so a non-ASCII handle comes back
  // percent-encoded -- the canonical wire form of the same URL, not a
  // different one. Assert the handle survived rather than the byte string, so
  // this stays a test about the allowlist.
  for (const handle of ["@山田太郎", "@山田", "@가나", "@a·b", "@алиса"]) {
    const bio = ["---", "socials:", `  youtube: ${handle}`, "---", "body"].join(
      "\n",
    );
    const { socials } = parseBioFrontmatter(bio);
    const published = sameAsUrls(socials);

    assert.equal(published.length, 1, handle);
    const url = new URL(published[0]);
    assert.equal(url.origin, "https://youtube.com", handle);
    assert.equal(decodeURIComponent(url.pathname), `/${handle}`, handle);
  }
  //...and pin the exact wire form once, so the encoding itself is covered.
  const { socials } = parseBioFrontmatter(
    ["---", "socials:", "  youtube: @山田", "---", "body"].join("\n"),
  );
  assert.deepEqual(sameAsUrls(socials), [
    "https://youtube.com/@%E5%B1%B1%E7%94%B0",
  ]);
});

test("a youtube handle longer than 30 characters is still rejected", () => {
  const bio = [
    "---",
    "socials:",
    `  youtube: @${"a".repeat(31)}`,
    "---",
    "body",
  ].join("\n");
  const { socials } = parseBioFrontmatter(bio);

  assert.deepEqual(sameAsUrls(socials), []);
});

test("percent-decoding cannot smuggle a non-profile path past the allowlist", () => {
  // `%2F` decodes to `/`; the allowlist admits no delimiter, so a
  // multi-segment path stays rejected even after decoding.
  const bio = [
    "---",
    "socials:",
    "  youtube: https://youtube.com/@alice%2Fvideos",
    "  github: https://github.com/alice%2Fproject",
    "---",
    "body",
  ].join("\n");
  const { socials } = parseBioFrontmatter(bio);

  assert.deepEqual(sameAsUrls(socials), []);
});

test("a malformed percent-escape is rejected rather than thrown", () => {
  const bio = [
    "---",
    "socials:",
    "  github: https://github.com/ali%E0%A4ce",
    "---",
    "body",
  ].join("\n");
  const { socials } = parseBioFrontmatter(bio);

  assert.deepEqual(sameAsUrls(socials), []);
});

// --- The published string must be the one that was validated (codex review
// round 4, ). Every gate in `sameAsUrls` interrogates the WHATWG-parsed
// URL; publishing the raw frontmatter string instead validated one thing and
// shipped another, in the false-positive direction -- a machine-readable
// claim that this creator IS some other entity. All of these were verified
// passing, and published verbatim, before the fix.

function sameAsFor(lines) {
  const { socials } = parseBioFrontmatter(
    ["---", "socials:", ...lines, "---", "body"].join("\n"),
  );
  return sameAsUrls(socials);
}

test("a URL containing a character the URL parser deletes or rewrites is refused", () => {
  // `new URL()` DELETES tab/LF/CR anywhere in the input and REWRITES `\` to
  // `/` under a special scheme, so each of these validated as the handle
  // `alice` while the profile page renders the link the creator typed.
  assert.deepEqual(sameAsFor(["  github: https://github.com/al\tice"]), []);
  assert.deepEqual(sameAsFor(["  github: https://github.com/al\rice"]), []);
  assert.deepEqual(sameAsFor(["  github: https://github.com/alice\\"]), []);
  assert.deepEqual(sameAsFor(["  twitter: https://x.com/al ice"]), []);
});

test("an empty path segment is refused, not collapsed", () => {
  // `filter(Boolean)` validated `//alice` as `alice` and then published the
  // double slash, which is not that profile. `//evil.example` under a handle
  // key resolves to `https://facebook.com///evil.example` the same way.
  assert.deepEqual(sameAsFor(["  github: https://github.com//alice"]), []);
  assert.deepEqual(sameAsFor(["  facebook: //evil.example"]), []);
  assert.deepEqual(sameAsFor(["  twitter: https://x.com//alice"]), []);
});

test("userinfo or an explicit port disqualifies an otherwise profile-shaped URL", () => {
  assert.deepEqual(
    sameAsFor(["  github: https://alice:hunter2@github.com/alice"]),
    [],
  );
  assert.deepEqual(sameAsFor(["  github: https://evil@github.com/alice"]), []);
  assert.deepEqual(sameAsFor(["  github: https://github.com:8443/alice"]), []);
});

test("http:// is refused for hosts that are HTTPS-only", () => {
  assert.deepEqual(sameAsFor(["  twitter: http://x.com/alice"]), []);
  assert.deepEqual(sameAsFor(["  github: http://github.com/alice"]), []);
});

test("a trailing slash is still a profile, and is published as parsed", () => {
  assert.deepEqual(sameAsFor(["  github: https://github.com/alice/"]), [
    "https://github.com/alice/",
  ]);
});

test("more platform utility routes are refused as profiles (codex review)", () => {
  // Each of these was verified passing as a `sameAs` before the fix.
  assert.deepEqual(sameAsFor(["  twitter: https://x.com/login"]), []);
  assert.deepEqual(sameAsFor(["  twitter: https://x.com/signup"]), []);
  assert.deepEqual(sameAsFor(["  instagram: https://instagram.com/about"]), []);
  assert.deepEqual(
    sameAsFor(["  facebook: https://facebook.com/profile.php"]),
    [],
  );
  assert.deepEqual(sameAsFor(["  telegram: https://t.me/share"]), []);
  assert.deepEqual(sameAsFor(["  telegram: https://t.me/joinchat"]), []);
  assert.deepEqual(sameAsFor(["  github: https://github.com/signup"]), []);
});

test("any facebook *.php endpoint is refused, named in the list or not", () => {
  // The deny-list is wrong by omission the first time Facebook adds a route;
  // `.php` is categorical because no vanity profile name ends in it.
  for (const path of ["story.php", "permalink.php", "someroute.php"]) {
    assert.deepEqual(
      sameAsFor([`  facebook: https://facebook.com/${path}`]),
      [],
      path,
    );
  }
});

test("a facebook vanity name is length-bounded", () => {
  // The class was `{5,}` -- unbounded creator-controlled text straight into
  // public SSR HTML as an identity claim.
  assert.deepEqual(
    sameAsFor([`  facebook: https://facebook.com/${"a".repeat(200)}`]),
    [],
  );
  assert.deepEqual(
    sameAsFor([`  facebook: https://facebook.com/${"a".repeat(51)}`]),
    [],
  );
  // Positive control: a real-shaped vanity name still qualifies.
  assert.deepEqual(
    sameAsFor(["  facebook: https://facebook.com/alice.example"]),
    ["https://facebook.com/alice.example"],
  );
});
