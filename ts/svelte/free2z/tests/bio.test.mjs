import assert from "node:assert/strict";
import test from "node:test";

import { parseBioFrontmatter } from "../src/lib/utils/bio.js";

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
