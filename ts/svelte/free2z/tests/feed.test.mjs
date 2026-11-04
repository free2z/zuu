import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  asRelativeZpagePageUrl,
  calculateVirtualFeedWindow,
  createAbortDeadline,
  createFeedPager,
  isDrfPageOutOfRange,
  shouldReportFeedFailure,
  zpageKey,
} from "../src/lib/feed.js";

const mobileFeedSource = readFileSync(
  new URL("../src/lib/components/MobileFeed.svelte", import.meta.url),
  "utf8",
);
const zpageCardSource = readFileSync(
  new URL("../src/lib/components/ZpageCard.svelte", import.meta.url),
  "utf8",
);
const localeSources = ["en", "es", "fr", "pt-BR"].map((locale) =>
  readFileSync(
    new URL(`../src/lib/locales/${locale}.json`, import.meta.url),
    "utf8",
  ),
);

test("homepage mobile cards use the shared horizontal zPage variant", () => {
  assert.match(
    mobileFeedSource,
    /<ZpageCard[\s\S]*?story=\{row\.story\}[\s\S]*?mobileHorizontal=\{true\}/,
  );
  assert.match(zpageCardSource, /export let mobileHorizontal = false;/);
  // Prettier's Tailwind plugin sorts class lists, so pin WHICH classes
  // the horizontal branch carries, never the order it happens to print them in.
  const horizontal = zpageCardSource.match(/mobileHorizontal \? `([^`]*)`/);
  assert.ok(horizontal, "expected the mobileHorizontal class branch");
  const classes = horizontal[1].split(/\s+/);
  for (const required of ["h-32", "min-h-32", "max-h-32", "flex-row"]) {
    assert.ok(
      classes.includes(required),
      `the mobileHorizontal card must pin ${required}`,
    );
  }
});

test("homepage mobile search renders one icon in a unified control", () => {
  const searchForm = mobileFeedSource.match(
    /<form role="search"[\s\S]*?<\/form>/,
  )?.[0];

  assert.ok(searchForm);
  assert.equal(searchForm.match(/<Search\b/g)?.length, 1);
  assert.match(searchForm, /data-testid="homepage-mobile-search"/);
  assert.doesNotMatch(searchForm, /class="flex gap-/);
  assert.match(searchForm, /variant="default"/);
  assert.doesNotMatch(searchForm, /variant="ghost"/);
  assert.match(searchForm, /<input[\s\S]*bg-transparent/);
  assert.match(searchForm, /shadow-none/);
  assert.match(searchForm, /focus-within:ring-2/);
  assert.match(
    searchForm,
    /focus-visible:ring-2[^\"]*focus-visible:ring-inset/,
  );
});

test("mobile feed uses a safe viewport minimum rather than a fixed height", () => {
  assert.match(
    mobileFeedSource,
    /data-testid="homepage-mobile-feed"[\s\S]*?min-h-screen min-h-svh/,
  );
  assert.doesNotMatch(mobileFeedSource, /[\s"]h-screen(?:\s|")/);
});

test("mobile feed uses one localized toggle without a redundant eyebrow", () => {
  assert.match(
    mobileFeedSource,
    /<button[\s\S]*?id="mobile-feed-heading"[\s\S]*?homepage\.latest[\s\S]*?homepage\.trending[\s\S]*?<\/button>/,
  );
  assert.doesNotMatch(mobileFeedSource, /homepage\.mobileFeedEyebrow/);
  assert.match(mobileFeedSource, /class="flex justify-end pt-3 pb-3"/);
  for (const localeSource of localeSources) {
    assert.doesNotMatch(localeSource, /"mobileFeedEyebrow"/);
  }
});

test("mobile feed invalidates stale requests and bounds duplicate recovery", () => {
  assert.match(mobileFeedSource, /activeController\?\.abort\(\)/);
  assert.match(mobileFeedSource, /generation !== requestGeneration\) return;/);
  assert.match(mobileFeedSource, /attempt < MAX_DUPLICATE_PAGES/);
  assert.match(
    mobileFeedSource,
    /if \(!reachedNewContentOrEnd\)[\s\S]*?if \(isTrending && trendingMore\) trendingFailed = true;/,
  );
  assert.match(mobileFeedSource, /createAbortDeadline\(/);
  assert.match(mobileFeedSource, /deadline\.clear\(\);/);
  assert.match(
    mobileFeedSource,
    /isDrfPageOutOfRange\(res\.status, errorBody\)/,
  );
  assert.doesNotMatch(mobileFeedSource, /nextPage\s*\+=/);
  assert.match(mobileFeedSource, /asRelativeZpagePageUrl\(data\?\.next\)/);
  assert.match(mobileFeedSource, /pagination:\s*"cursor"/);
  assert.match(
    mobileFeedSource,
    /async function toggleFeedMode\(\)[\s\S]*?activeController\?\.abort\(\)[\s\S]*?await tick\(\)[\s\S]*?loadMore\(\)/,
  );
  assert.match(
    mobileFeedSource,
    /if \(isTrending\) trendingFailed = false;[\s\S]*?else failed = false;/,
  );
});

test("API cursor links are reduced to the expected relative endpoint", () => {
  assert.equal(
    asRelativeZpagePageUrl(
      "https://api.example.test/api/zpage/?cursor=abc&page_size=20",
    ),
    "/api/zpage/?cursor=abc&page_size=20",
  );
  assert.equal(
    asRelativeZpagePageUrl("/api/zpage/?cursor=def"),
    "/api/zpage/?cursor=def",
  );
  assert.equal(asRelativeZpagePageUrl("/api/creator/?cursor=abc"), null);
  assert.equal(asRelativeZpagePageUrl("not a cursor"), null);
});

test("virtual feed keeps a bounded number of rows mounted deep in a session", () => {
  const window = calculateVirtualFeedWindow({
    itemCount: 10_000,
    scrollTop: 700_000,
    listTop: 1_000,
    viewportHeight: 800,
    rowStride: 140,
    overscan: 6,
  });

  assert.ok(window.start > 0);
  assert.ok(window.end < 10_000);
  assert.ok(window.end - window.start <= Math.ceil(800 / 140) + 12);
  assert.equal(window.topSpacer, window.start * 140);
  assert.equal(window.bottomSpacer, (10_000 - window.end) * 140);
  assert.match(mobileFeedSource, /bind:this=\{feedList\}/);
  assert.match(mobileFeedSource, /\{#each virtualRows as row/);
  assert.doesNotMatch(mobileFeedSource, /\{#each displayedItems as story/);
});

test("load-more deadline aborts the whole request chain and remains reportable", async () => {
  const controller = new AbortController();
  const deadline = createAbortDeadline(controller, 5);

  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(controller.signal.aborted, true);
  assert.equal(deadline.expired, true);
  assert.equal(
    shouldReportFeedFailure({
      isCurrent: true,
      aborted: controller.signal.aborted,
      timedOut: deadline.expired,
    }),
    true,
  );
  deadline.clear();
});

test("cleared deadlines and intentional aborts remain silent", async () => {
  const controller = new AbortController();
  const deadline = createAbortDeadline(controller, 5);
  deadline.clear();

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(controller.signal.aborted, false);
  assert.equal(deadline.expired, false);

  controller.abort();
  assert.equal(
    shouldReportFeedFailure({
      isCurrent: true,
      aborted: controller.signal.aborted,
      timedOut: deadline.expired,
    }),
    false,
  );
  assert.equal(
    shouldReportFeedFailure({
      isCurrent: false,
      aborted: false,
      timedOut: false,
    }),
    false,
  );
});

test("DRF out-of-range pages end the feed instead of retrying", () => {
  assert.equal(isDrfPageOutOfRange(404, { detail: "Invalid page." }), true);
  assert.equal(isDrfPageOutOfRange(404, { detail: " invalid PAGE " }), true);
  assert.equal(isDrfPageOutOfRange(404, { detail: "Not found." }), false);
  assert.equal(isDrfPageOutOfRange(404, "upstream not found"), false);
  assert.equal(isDrfPageOutOfRange(500, { detail: "Invalid page." }), false);
});

test("zpageKey prefers free2zaddr, then vanity, then id", () => {
  assert.equal(zpageKey({ free2zaddr: "abc", vanity: "v", id: 1 }), "abc");
  assert.equal(zpageKey({ vanity: "v", id: 1 }), "v");
  assert.equal(zpageKey({ id: 7 }), "7");
});

test("zpageKey returns an empty key for unusable rows", () => {
  assert.equal(zpageKey(undefined), "");
  assert.equal(zpageKey({}), "");
  assert.equal(zpageKey({ free2zaddr: null }), "");
});

test("pager keeps the server-rendered first page in order", () => {
  const pager = createFeedPager([{ free2zaddr: "a" }, { free2zaddr: "b" }]);
  assert.deepEqual(pager.items.map(zpageKey), ["a", "b"]);
});

test("pager appends new rows and reports how many it took", () => {
  const pager = createFeedPager([{ free2zaddr: "a" }]);
  const added = pager.append([{ free2zaddr: "b" }, { free2zaddr: "c" }]);
  assert.equal(added, 2);
  assert.deepEqual(pager.items.map(zpageKey), ["a", "b", "c"]);
});

test("a row repeated by offset pagination is dropped, not rendered twice", () => {
  // Publishing between fetches pushes "b" from page 1 onto page 2.
  const pager = createFeedPager([{ free2zaddr: "a" }, { free2zaddr: "b" }]);
  const added = pager.append([{ free2zaddr: "b" }, { free2zaddr: "c" }]);
  assert.equal(added, 1);
  assert.deepEqual(pager.items.map(zpageKey), ["a", "b", "c"]);
});

test("duplicates within a single page are collapsed", () => {
  const pager = createFeedPager();
  const added = pager.append([{ free2zaddr: "a" }, { free2zaddr: "a" }]);
  assert.equal(added, 1);
  assert.deepEqual(pager.items.map(zpageKey), ["a"]);
});

test("rows with no usable key are skipped rather than breaking the keyed each", () => {
  const pager = createFeedPager();
  const added = pager.append([{}, { free2zaddr: "a" }, { vanity: null }]);
  assert.equal(added, 1);
  assert.deepEqual(pager.items.map(zpageKey), ["a"]);
});

test("append tolerates a missing or empty payload", () => {
  const pager = createFeedPager([{ free2zaddr: "a" }]);
  assert.equal(pager.append(undefined), 0);
  assert.equal(pager.append([]), 0);
  assert.deepEqual(pager.items.map(zpageKey), ["a"]);
});
