import { createServer } from "node:http";

import { converseStreamPageOne } from "./converse-stream-fixture.mjs";
import { TRANSLATABLE_LANGUAGES } from "../../src/lib/zpage-language.js";

// No default port. playwright.config.ts resolves the suite's ports (a pair
// derived from the worktree path unless PLAYWRIGHT_MOCK_API_PORT says
// otherwise) and passes the answer in. A baked-in fallback would be a
// machine-wide fixed port again -- the thing  is about -- and would let
// this server come up somewhere the specs are not looking.
const port = Number(process.env.MOCK_API_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(
    `mock-api: MOCK_API_PORT is ${JSON.stringify(process.env.MOCK_API_PORT)}, ` +
      `which is not a TCP port.\n` +
      `mock-api: this server is started by playwright.config.ts, which passes ` +
      `the port it resolved. Run the suite with \`npm run test:browser\`; to ` +
      `start this server by hand, set MOCK_API_PORT (and MOCK_TRUSTED_APP_ORIGIN) ` +
      `yourself.`,
  );
  process.exit(2);
}
const trustedAppOrigin = process.env.MOCK_TRUSTED_APP_ORIGIN;
if (!trustedAppOrigin) {
  console.error(
    `mock-api: MOCK_TRUSTED_APP_ORIGIN is not set. It is the app's origin ` +
      `(http://127.0.0.1:<app port>) and playwright.config.ts passes it in. ` +
      `Without it every CORS and same-origin assertion in the suite is testing ` +
      `the wrong origin.`,
  );
  process.exit(2);
}

// What SSR actually sent us.  was invisible from the browser side: the
// page rendered fine, it just rendered anonymous, so the only way to assert
// the fix is to look at the upstream request Node made.
/** @type {{ path: string, method: string | undefined, cookie: string | null, origin: string | null, csrf: string | null }[]} */
let received = [];

// Signed-in first-party card readers: what `/api/auth/user/` answers
// for their sessions, and what a returning reader's `localStorage.auth`
// holds. `stars` are the creators the account subscribes to.
const FP_CARD_USERS = {
  "fp-card-owner": {
    username: "fp-card-user",
    full_name: "First Party Card User",
    stars: [],
    tuzis: "0",
  },
  "fp-card-subscriber": {
    username: "fp-card-subscriber-user",
    full_name: "Card Subscriber",
    stars: ["fp-card-user"],
    tuzis: "0",
  },
  "fp-card-stranger": {
    username: "fp-card-stranger-user",
    full_name: "Card Stranger",
    stars: [],
    tuzis: "0",
  },
};
let liveDiscoveryMode = "normal";
let liveDiscoveryFailures = 0;

// --- Direct-media consent fixture (issues /) ----------------------
// This server's origin differs from the app's by port, so anything it serves
// is genuinely third party to the page under test. The spec hardcodes these
// same literals.
const THIRD_PARTY_AUDIO_PATH = "/third-party-audio/probe.wav";
const THIRD_PARTY_VIDEO_PATH = "/third-party-video/probe.mp4";
const SAME_ORIGIN_AUDIO_PATH = "/uploadz/audio-preload-fixture.wav";
const SAME_ORIGIN_VIDEO_PATH = "/uploadz/video-consent-fixture.mp4";
let thirdPartyAudioHits = 0;
let thirdPartyVideoHits = 0;

// 100ms of silence as a 16-bit mono 8kHz WAV — the smallest thing a media
// element will accept as real audio, built inline so the repo carries no
// binary fixture.
function silentWav() {
  const sampleRate = 8000;
  const samples = sampleRate / 10;
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // format = PCM
  buffer.writeUInt16LE(1, 22); // channels
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

// --- Billing subscription-card fixture (issue ) -------------------------
// One row per price-ceiling state so a single page render exercises every card
// the classifier can produce. Kept in sync with tests/subscription-ceiling.
// NB: not exported — importing this module would start a second listener on
// the same port. The spec hardcodes the same two literals.
const BILLING_FIXTURE_SESSION = "billing-fixture-session";
const BOOST_FIXTURE_SESSION = "boost-session";
const BOOST_FIXTURE_USER = "boost-tester";
const RAW_WRITE_FIXTURE_SESSION = "raw-write-session";
const RAW_WRITE_FIXTURE_USER = "raw-write-user";
const REPORT_BLOCK_FIXTURE_SESSION = "report-block-session";
const REPORT_BLOCK_FIXTURE_USER = "report-reader";
const RESET_PASSWORD_SUCCESS_SESSION = "reset-password-success-session";
const RESET_PASSWORD_SUCCESS_USER = "reset-user";
const CURSOR_FIXTURE_SESSION = "cursor-fixture-session";
const ZPAGE_DELETE_FIXTURE_SESSION = "zpage-delete-fixture-session";
const ZPAGE_DELETE_FIXTURE_USER = "zpagedeletefixture";
const CURSOR_FIXTURE_USER = "cursor-fixture-user";
const CURSOR_FIXTURE_CREATOR = {
  id: 1498,
  username: CURSOR_FIXTURE_USER,
  full_name: "Cursor Fixture User",
  description: "A creator used by the cursor affordance regression suite.",
  avatar_image: null,
  banner_image: null,
  member_price: null,
  p2paddr: "",
};
// The creator every live-stream viewer assertion in
// tests/browser/live-route-ssr.spec.ts resolves to. Lower-case here on
// purpose; see the handler for why.
const LIVE_FIXTURE_USER = "livefixture";
//a creator whose card has a real avatar, so the paid-stream unfurl
// spec can tell "the creator's card" from the house fallback image.
const PAID_STREAM_FIXTURE_USER = "paidstreamfixture";
const PAID_STREAM_FIXTURE_AVATAR =
  "https://media.free2z.example/avatars/paidstreamfixture.png";
// The Go Live dashboard is owner-only. This session deliberately answers with
// can_stream=true so the audience-card suite reaches the real setup form
// instead of proving the ineligible-account warning.
const STREAM_AUDIENCE_FIXTURE_SESSION = "stream-audience-owner-session";
const STREAM_AUDIENCE_FIXTURE_USER = "streamaudienceowner";
const BILLING_FIXTURE_CSRF = "billing-fixture-csrf";
const BILLING_SHORTFALL_SESSION = "billing-shortfall-session";
const BILLING_EMPTY_SESSION = "billing-empty-session";
const BILLING_UNKNOWN_SESSION = "billing-unknown-session";
const BILLING_FIXTURE_USER = "fixtureowner";
const BILLING_FIXTURE_CREATOR_PRICE = "50";
// `tuzis` is `DecimalField(max_digits=17, decimal_places=3)`, which DRF
// serializes as a STRING with all three decimals present. The third decimal is
// the trap: it must be truncated away, never rounded up.
const BILLING_FIXTURE_TUZIS = "64672.234";
let billingFixtureBalance = BILLING_FIXTURE_TUZIS;
let billingFixtureObservation = 1;
let billingFixtureRenewalSummary = null;

const ZPAGE_DELETE_FIXTURE_PAGES = [
  {
    id: 9701,
    free2zaddr: "zpage-delete-draft",
    vanity: "zpage-delete-draft",
    title: "Delete fixture draft",
    is_published: false,
    publish_at: null,
  },
  {
    id: 9702,
    free2zaddr: "zpage-delete-scheduled",
    vanity: "zpage-delete-scheduled",
    title: "Delete fixture scheduled draft",
    is_published: false,
    publish_at: "2099-01-01T00:00:00Z",
  },
  {
    id: 9703,
    free2zaddr: "zpage-delete-published",
    vanity: "zpage-delete-published",
    title: "Delete fixture published page",
    is_published: true,
    publish_at: null,
  },
];
const ZPAGE_DELETE_FIXTURE_PAGE2_PAGES = [
  ...Array.from({ length: 12 }, (_, index) => ({
    id: 9710 + index,
    free2zaddr: `zpage-delete-page1-${index + 1}`,
    vanity: `zpage-delete-page1-${index + 1}`,
    title: `Delete fixture page 1 item ${index + 1}`,
    is_published: false,
    publish_at: null,
  })),
  {
    id: 9722,
    free2zaddr: "zpage-delete-page2-last",
    vanity: "zpage-delete-page2-last",
    title: "Delete fixture page 2 last item",
    is_published: false,
    publish_at: null,
  },
];
let zpageDeleteFixturePages = structuredClone(ZPAGE_DELETE_FIXTURE_PAGES);
let zpageDeleteFixtureMode = "normal";
// Per-page version behind the canonical `ETag`, the way Django's
// `canonical_etag` moves on a save. `/__zpage-delete/touch` is that
// save, from another tab, while the delete dialog is open.
let zpageDeleteFixtureVersions = new Map();

function zpageDeleteFixtureEtag(free2zaddr) {
  return `"${free2zaddr}-v${zpageDeleteFixtureVersions.get(free2zaddr) || 1}"`;
}

function zpageDeleteFixtureRows() {
  return zpageDeleteFixturePages.map((page) => ({
    ...page,
    description: "Deletion fixture page",
    content: "Deletion fixture content",
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-02T10:00:00Z",
    tags: [],
    creator: { username: ZPAGE_DELETE_FIXTURE_USER },
    category: "",
  }));
}
const AUTHENTICATED_HOMEPAGE_DRAFT = {
  id: 799,
  free2zaddr: "private-logout-draft",
  vanity: "private-logout-draft",
  title: "Private logout draft",
  description: "This unpublished draft must disappear after logout.",
  created_at: "2026-08-04T10:00:00Z",
  is_published: false,
  featured_image: { url: "/uploadz/private-draft.png" },
  creator: { username: BILLING_FIXTURE_USER },
};

// --- Profile dashboard overflow fixture ------------------------------------
// A deliberately pathological owner: the widest plausible 2Z balance, a
// 128-char unbroken display name (the model's max_length), and a full Unified
// address. The stats row used to size to its content's min-content width, so
// this is the payload that made a 390px phone scroll horizontally. Separate
// session/user from the billing fixture so neither test perturbs the other.
// The spec hardcodes these same literals.
const PROFILE_FIXTURE_ADDRESS =
  "u18vffksp4zjra0c8aqzyxvvhmxqmr2rk8j7x9m2q0lhq3wgs6tqk9v4zn7l3xd8fpq5j2m6c0rtyv9wq8hn3lz7kx4mv2p6gd9sr0tqy5h";
// The LAYOUT fixture's balance, as the string DRF actually serializes a
// DecimalField to. Deliberately realistic (this is the owner's own balance,
// the one that rendered as "64,6…" in the original report) rather than the
// widest the column can hold — see. A layout fixture carrying a value
// no real creator can have forces the layout assertions to be weakened until
// they no longer cover the case they were written for. The pathological
// widths and the formatter traps live in their own sessions below.
const PROFILE_FIXTURE_TUZIS = "64672.234";
// max_digits=17, decimal_places=3 — the largest value the column can hold.
// Truncating rather than rounding is the whole point: rounded it would read
// "100,000,000,000,000".
const PROFILE_MAX_TUZIS = "99999999999999.999";
// The same magnitude, with cents that round UP through a `Number()`
// round-trip: `Number("99999999999999.01") === 99999999999999.02`, because a
// value near 1e14 with two decimals needs ~16 significant digits and a double
// carries ~15.95. This is the fixture  was missing — both previous
// fixture values happened to round DOWN, so the bug passed every assertion.
const PROFILE_ROUNDUP_TUZIS = "99999999999999.010";
// `mine=true` returns one 12-row DRF page; the true totals arrive alongside,
// and they deliberately dwarf it — the stats read the totals, the lists read
// the page, and the gap between them is its own class of bug.
const PROFILE_FIXTURE_PUBLISHED_COUNT = 4321;
const PROFILE_FIXTURE_DRAFT_COUNT = 1234;

// --- Profile tag vocabulary fixture (issue ) -------------------------
// The first response is deliberately capped at 100 realistic, popular-ish
// tags. The long-tail and draft-only tags live past that starting page, so a
// browser test must actually type a query to reach them.
const TAG_FILTER_FIXTURE_USER = "tagfilterfixture";
// Answered by the routing-creator fixture below.
const ROUTING_FIXTURE_CREATORS = new Set([
  "storytime",
  "an-ordinary-creator",
  "finding",
  "beginner",
]);
const TAG_FILTER_OWNER_SESSION = "tag-filter-owner-session";
const TAG_FILTER_LONG_TAIL = "shielded-pool accounting notes";
const TAG_FILTER_DRAFT_ONLY = "unpublished launch checklist";
const TAG_FILTER_SLOW = "slow response sentinel";
const TAG_FILTER_INITIAL = Array.from({ length: 100 }, (_, index) => ({
  name:
    [
      "privacy engineering",
      "open source",
      "zero knowledge proofs",
      "creator economy",
      "digital rights",
      "free software",
      "secure payments",
      "long form writing",
    ][index % 8] + ` ${String(index + 1).padStart(3, "0")}`,
  count: 100 - index,
  level: index < 10 ? "broad" : "narrow",
}));
const TAG_FILTER_PUBLIC = [
  ...TAG_FILTER_INITIAL,
  { name: TAG_FILTER_LONG_TAIL, count: 1, level: "narrow" },
  { name: TAG_FILTER_SLOW, count: 1, level: "narrow" },
];
const TAG_FILTER_OWNER = [
  ...TAG_FILTER_PUBLIC,
  { name: TAG_FILTER_DRAFT_ONLY, count: 1, level: "narrow" },
];

// --- /tag/<slug> topic hubs  -----------------------------------------
//
// Six scenarios, each its own slug, because a tag hub's behaviour is entirely
// about which of them you are looking at:
//
//   ssr-tag-fixture      populated and over the indexing gate
//   ssr-thin-fixture     under the gate: renders for humans, `noindex, follow`
//   ssr-banned-fixture   404 — the shape the backend returns once the only
//                        creator carrying the tag is deactivated
//   ssr-collide-fixture  two DISTINCT tag names on one slug
//   ssr-alias-fixture    resolves to a different canonical slug -> 301
//   ssr-strasse-fixture  live casefold alias resolves to a canonical union
//
// The titles are production-shaped rather than "fixture 1": a hub whose rows
// are all 12 characters long proves nothing about the card layout it shares
// with /trending.
const TAG_HUB_SENTINEL = "ssr-tag-hub-sentinel";
const TAG_HUB_PAGE_COUNT = 15;

const TAG_HUB_FIXTURES = {
  "ssr-tag-fixture": {
    slug: "ssr-tag-fixture",
    name: "ssr-tag-fixture",
    names: ["ssr-tag-fixture"],
    count: TAG_HUB_PAGE_COUNT,
    indexable: true,
  },
  "ssr-thin-fixture": {
    slug: "ssr-thin-fixture",
    name: "ssr-thin-fixture",
    names: ["ssr-thin-fixture"],
    count: 2,
    indexable: false,
  },
  "ssr-collide-fixture": {
    slug: "ssr-collide-fixture",
    name: "SSR Collide Fixture",
    names: ["SSR Collide Fixture", "ssr/collide/fixture"],
    count: 2,
    indexable: false,
  },
  "ssr-alias-fixture": {
    // A DIFFERENT slug than the one requested: the caller's cue to 301.
    slug: "ssr-tag-fixture",
    name: "ssr-tag-fixture",
    names: ["ssr-tag-fixture"],
    count: TAG_HUB_PAGE_COUNT,
    indexable: true,
  },
  "ssr-strasse-fixture": {
    // The live alias has a different slug because Python/JavaScript slugging
    // lowercases while tag normalization casefolds (`straße` == `STRASSE`).
    slug: "ssr-straße-fixture",
    name: "SSR Straße Fixture",
    names: ["SSR Straße Fixture", "SSR STRASSE FIXTURE"],
    count: 4,
    indexable: true,
  },
  "ssr-straße-fixture": {
    slug: "ssr-straße-fixture",
    name: "SSR Straße Fixture",
    names: ["SSR Straße Fixture", "SSR STRASSE FIXTURE"],
    count: 4,
    indexable: true,
  },
};

function tagHubRow(slug, index) {
  return {
    id: 8100 + index,
    free2zaddr: `${slug}-${index}`,
    vanity: `${slug}-${index}`,
    title: `${TAG_HUB_SENTINEL} ${index}: what a shielded memo teaches about audience building`,
    description:
      "A description long enough to be clamped rather than shown whole, which is the point of the compact row.",
    created_at: "2026-08-14T12:00:00Z",
    updated_at: "2026-08-14T12:00:00Z",
    is_published: true,
    category: "Technology",
    tags: [slug],
    creator: {
      username: "ssrtaghubfixturecreator",
      full_name: "SSR Tag Hub Fixture Creator",
      avatar_image: {},
    },
    get_url: `/ssrtaghubfixturecreator/${slug}-${index}`,
  };
}

const TAG_HUB_PAGES = {
  "ssr-tag-fixture": Array.from({ length: TAG_HUB_PAGE_COUNT }, (_, index) =>
    tagHubRow("ssr-tag-fixture", index),
  ),
  "ssr-thin-fixture": Array.from({ length: 2 }, (_, index) =>
    tagHubRow("ssr-thin-fixture", index),
  ),
  "ssr-collide-fixture": Array.from({ length: 2 }, (_, index) =>
    tagHubRow("ssr-collide-fixture", index),
  ),
  "ssr-straße-fixture": Array.from({ length: 4 }, (_, index) =>
    tagHubRow("ssr-straße-fixture", index),
  ),
};

/**
 * `mix` decides what the one visible page contains, which is the whole point:
 * the page is ordered `-created_at` and the counts span the whole queryset, so
 * a creator really can have 1,234 drafts and a first page holding none of
 * them. Each session is its own scenario; the spec hardcodes these literals.
 */
const PROFILE_FIXTURES = {
  "profile-fixture-session": { username: "profilefixture", mix: "alternating" },
  [TAG_FILTER_OWNER_SESSION]: {
    username: TAG_FILTER_FIXTURE_USER,
    mix: "alternating",
  },
  // 1,234 drafts advertised, none on this page. Also carries the rounding
  // trap: 4.996 must never be displayed as "5", because 5 is more than this
  // creator can actually spend.
  "profile-nodrafts-session": {
    username: "profilenodrafts",
    mix: "published",
    tuzis: "4.996",
  },
  //...and the mirror image.
  "profile-nopublished-session": {
    username: "profilenopublished",
    mix: "drafts",
  },
  // Formatter-only sessions. These carry balances no real
  // creator has, purely to pin `formatTuzis`; nothing asserts layout against
  // them, so the layout suite is free to assert non-clipping unconditionally.
  "profile-maxbalance-session": {
    username: "profilemaxbalance",
    mix: "alternating",
    tuzis: PROFILE_MAX_TUZIS,
  },
  "profile-roundup-session": {
    username: "profileroundup",
    mix: "alternating",
    tuzis: PROFILE_ROUNDUP_TUZIS,
  },
};

// The titles are the reason the first attempt at this fix shipped broken. The
// old fixture said "Profile fixture page 3" — 21 characters, which fits inside
// a 390px row no matter how the container sizes itself. So the layout spec
// asserted `scrollWidth <= 390`, passed, and production still scrolled 415px
// sideways: the row container is `flex-col items-start`, and `align-items:
// flex-start` sizes children to FIT-CONTENT on the cross (horizontal) axis, so
// a nowrap `<h3>` sets the row's width to the full title length. A short title
// simply never reaches the viewport edge, and a test that cannot fail on the
// real bug is worthless. The owner's real titles run 60-90 characters; the last
// `mix: "alternating"` publishes the even indices, so the first two rows put the
// pathological title in BOTH lists.
const PROFILE_FIXTURE_UNBREAKABLE_TITLE =
  "SupercalifragilisticexpialidociousAntidisestablishmentarianismPneumonoultramicroscopicsilicovolcanoconiosis";
const PROFILE_FIXTURE_TITLES = [
  "P2PE2E: An open-source, peer-to-peer, end-to-end encrypted messaging protocol for free2z",
  "Why Zcash shielded pools are the only privacy primitive that actually composes with payments",
  "Building free2z: a year of shipping a creator platform on top of a private, permissionless chain",
  "The 2Z credit ledger, explained end to end — minting, spending, refunds, and why it is not a token",
  "A practical guide to running your own lightwalletd, from bare metal to a hardened systemd unit",
  "Notes on trunk-based development with autonomous agents, worktrees, and adversarial code review",
];

const PROFILE_FIXTURE_DESCRIPTION =
  "A long-form description of the sort the dashboard actually receives, easily past the single line the row clamps it to.";

const profileFixturePages = (mix, username = "profilefixture") =>
  Array.from({ length: 12 }, (_, index) => ({
    id: 9000 + index,
    free2zaddr: `profile-fixture-${index}`,
    vanity: `profile-fixture-${index}`,
    title:
      index < 2
        ? PROFILE_FIXTURE_UNBREAKABLE_TITLE
        : PROFILE_FIXTURE_TITLES[index % PROFILE_FIXTURE_TITLES.length],
    description: PROFILE_FIXTURE_DESCRIPTION,
    creator: {
      username,
      full_name: `${username} Fixture Creator`,
    },
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-02T10:00:00Z",
    is_published:
      mix === "published" ? true : mix === "drafts" ? false : index % 2 === 0,
    tags: [],
  }));

/** username is also the state name, so a failure names its own case. */
const BILLING_FIXTURE_SUBSCRIPTIONS = [
  { username: "state-ok", memberPrice: "10", maxPrice: "100" },
  { username: "state-near", memberPrice: "4", maxPrice: "5" },
  { username: "state-at", memberPrice: "50", maxPrice: "50" },
  // Valid production username used by the server-action persistence test.
  { username: "mutation_target", memberPrice: "50", maxPrice: "50" },
  { username: "state-over", memberPrice: "60", maxPrice: "50" },
  { username: "state-unpriced", memberPrice: null, maxPrice: "50" },
  { username: "state-cancelled", memberPrice: "10", maxPrice: "0" },
  { username: "state-unknown", memberPrice: "10", maxPrice: null },
  {
    username: "state-expired",
    memberPrice: "10",
    maxPrice: "100",
    expired: true,
  },
  //a deactivated creator, redacted exactly as
  // SubscriptionCounterpartySerializer does (member_price null, username kept).
  // A hyphen on purpose: Django allows `[\w.@+-]`, and this row's Unsubscribe
  // must really submit. The billing actions used to refuse `-`.
  {
    username: "state-inactive",
    memberPrice: null,
    maxPrice: "50",
    inactive: true,
  },
];

let billingFixtureSubscriptions = structuredClone(
  BILLING_FIXTURE_SUBSCRIPTIONS,
);

const BILLING_FIXTURE_SUBSCRIBERS = [
  { username: "fan-renewing", maxPrice: "100" },
  { username: "fan-over", maxPrice: "10" },
  { username: "fan-cancelled", maxPrice: "0" },
  // Unreadable ceiling. `max_price` is `default=0, null=False`, so this only
  // happens on payload drift — which is exactly what the card must not paper
  // over with a definite date.
  { username: "fan-unknown", maxPrice: null },
  { username: "fan-nonnumeric", maxPrice: "not-a-number" },
  { username: "fan-whitespace", maxPrice: "   " },
  { username: "fan-boolean", maxPrice: false },
  // 's mirror: a deactivated fan, redacted to a username.
  { username: "fan_inactive", maxPrice: "100", inactive: true },
];

// --- zPage boost score-coherence fixture  ----------------------------
// The browser test mutates these two server-rendered payloads through the
// helper endpoint below. Keeping the score in the mock server, rather than in
// the browser route handler, makes navigation and late responses exercise the
// same SSR/load boundary as production.
const BOOST_FIXTURE_PAGES = {
  "boost-a": {
    free2zaddr: "00000000-0000-4000-8000-000000000861",
    vanity: "boost-a",
    title: "Boost fixture A",
    f2z_score: "0.00000000",
  },
  "boost-b": {
    free2zaddr: "00000000-0000-4000-8000-000000000862",
    vanity: "boost-b",
    title: "Boost fixture B",
    f2z_score: "3.00000000",
  },
};

// --- zPage direct-support recipient fixture  --------------------------
// A page whose EFFECTIVE support address (`p2paddr`, page override) differs
// from the creator's profile address, plus one whose page address is
// transparent. The browser test decodes the `zcash:` URI the Support dialog
// hands to the wallet and checks recipient, amount and memo against these.
const SUPPORT_FIXTURE_CREATOR_ADDRESS = PROFILE_FIXTURE_ADDRESS;
const SUPPORT_FIXTURE_PAGE_ADDRESS =
  "u1pagecampaign7x4k2m9v0d3q8lz5w6n1t7r2y9c4h6b8f0p3s5a7e9g1j3l5n7q9s1u3w5y7z9b2d4f6h8k0m2p4r6t8v0x2z4c6e8g0j2l4n6p8r0t2v4x6";
const SUPPORT_FIXTURE_TRANSPARENT_ADDRESS =
  "t1KbeGmXH8Rc4qEeTU1fgjF5HqjgtxdSTE";
const SUPPORT_FIXTURE_PAGES = {
  "support-zec": {
    free2zaddr: "00000000-0000-4000-8000-000000000863",
    vanity: "support-zec",
    title: "Why Zcash matters — a field guide",
    f2z_score: "1.00000000",
    p2paddr: SUPPORT_FIXTURE_PAGE_ADDRESS,
  },
  "support-zec-t": {
    free2zaddr: "00000000-0000-4000-8000-000000000864",
    vanity: "support-zec-t",
    title: "Transparent campaign page",
    f2z_score: "1.00000000",
    p2paddr: SUPPORT_FIXTURE_TRANSPARENT_ADDRESS,
  },
};

function supportFixtureArticle(page) {
  const article = boostFixtureArticle(page);
  return {
    ...article,
    p2paddr: page.p2paddr,
    creator: {
      ...article.creator,
      username: "support-author",
      full_name: "Support Fixture Author",
      p2paddr: SUPPORT_FIXTURE_CREATOR_ADDRESS,
    },
    get_url: `/support-author/${page.vanity}`,
  };
}

function boostFixtureArticle(page) {
  return {
    ...page,
    p2paddr: "",
    content: `Content for ${page.title}`,
    description: "Browser fixture for score coherence.",
    is_published: true,
    is_subscriber_only: false,
    total_raised: 0,
    total: "0.00000000",
    comments: [],
    featured_image: {},
    creator: {
      username: "boost-author",
      full_name: "Boost Fixture Author",
      avatar_image: {},
      member_price: null,
    },
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    get_url: `/boost-author/${page.vanity}`,
    tags: [],
    source_language: "en",
    requested_language: "en",
    actual_language: "en",
    fallback_used: false,
    available_languages: ["en"],
    variant_is_published: true,
  };
}

// --- Server-rendered article body fixture (issue ) ---------------------
// Sentinels are deliberately unique strings so a failure names the construct
// that regressed. Kept as a template literal (not JSON) so the fenced code
// blocks stay readable.
const SSR_BODY_FIXTURE_CONTENT = [
  "## Heading sentinel ssr-heading-anchor",
  "",
  "This paragraph is the crawler payload: ssr-prose-sentinel must appear in the",
  "raw HTML that a client with JavaScript disabled receives.",
  "Author links: [same-origin destination](/ssr-body-user/ssr-body-fixture) and [external destination](https://external.example/next?from=markdown). Footnote[^1].",
  "",
  "[^1]: Footnote back-reference sentinel.",
  "",
  // Three more headings so the article clears TableOfContents' `items.length > 2`
  // threshold. The outline is built from MutationObserver callbacks over this
  // container, and skipping the initial innerHTML write removes one of those
  // mutations — so the outline has to be asserted, not assumed.
  "## Second section",
  "",
  "### Nested subsection",
  "",
  "## Third section",
  "",
  "| Column A | Column B |",
  "| --- | --- |",
  "| ssr-table-sentinel | second cell |",
  "",
  "```python",
  'print("ssr-code-sentinel")',
  "```",
  "",
  "```mermaid",
  "graph TD;",
  "  A[ssr-mermaid-sentinel] --> B[Rendered];",
  "```",
  "",
  "::qrcode[ssr-qrcode-sentinel]",
  "",
  "![ssr image](/uploadz/ssr-body-fixture.png)",
  "",
  "::embed[https://www.youtube.com/watch?v=dQw4w9WgXcQ]",
  "",
  "Closing prose: ssr-tail-sentinel.",
  "",
].join("\n");

// Past SSR_MARKUP_MAX_DEPTH (64): 200 nested blockquotes. Small in bytes and in
// element count — it clears both width ceilings — so only the depth ceiling
// rejects it, and `sanitizeMarkdownHtmlForMarkup` returns "". That puts this
// article on the client-side build path, which must still render perfectly.
//
// 200, not the ~1,900 that makes the parse cost seconds: past roughly that
// depth `marked` overflows its own call stack and `processMarkdown` degrades to
// escaped source text, so the fixture would stop testing the branch it is here
// to test. The cost curve is measured in tests/markdown.test.mjs instead.
const SSR_OVERCAP_FIXTURE_CONTENT = [
  "## Overcap heading",
  "",
  `${">".repeat(200)} ssr-overcap-quote-sentinel`,
  "",
  "Ordinary prose after the quote: ssr-overcap-prose-sentinel.",
  "",
  "```python",
  'print("ssr-overcap-code-sentinel")',
  "```",
  "",
].join("\n");

const LONG_LIGHTBOX_TITLE = "Long caption ".repeat(150).trim();

const MARKDOWN_IMAGE_LIGHTBOX_FIXTURE_CONTENT = [
  "## Markdown image lightbox fixture",
  "",
  `![landscape lightbox image](/lightbox/landscape.svg "${LONG_LIGHTBOX_TITLE}")`,
  "",
  "![portrait lightbox image](/lightbox/portrait.svg)",
  "",
  "![panorama lightbox image](/lightbox/panorama.svg)",
  "",
  `![](/lightbox/long-caption.svg "${LONG_LIGHTBOX_TITLE}")`,
  "",
  "![broken lightbox image](/lightbox/broken.svg)",
  "",
  "::embed[/uploadz/lightbox-upload.svg]",
  "",
  "[![linked lightbox image](/lightbox/linked.svg)](https://external.example/linked-image)",
  "",
  "::qrcode[lightbox-qr-sentinel]",
  "",
  "::embed[https://image-consent.example/lightbox.svg]",
  "",
  "Lightbox tail sentinel.",
].join("\n");

// --- zPage parallax hero fixtures ------------------------------------------
//
// The hero has to survive whatever a creator uploaded, and the failure modes
// are all visual: white text on a bright photograph, a panorama cropped to a
// sliver, a 96px image blown up to full bleed, no image at all. Each case gets
// its own article so a failure names it.
//
// The images are generated SVGs served by this same process rather than binary
// fixtures in the repo: any size, any colour, no bytes committed, and an
// absolute URL so `normalizeMediaUrl` passes it through untouched.
const HERO_FIXTURE_CONTENT = [
  "## Hero body heading",
  "",
  "hero-body-sentinel — the article body, which the parallax hero must never",
  "cost a crawler.",
  "",
  // Long enough that the document scrolls well past one hero height plus a
  // viewport. Without this the hero can never reach full exit on a phone
  // viewport and the parallax assertions silently test nothing.
  ...Array.from(
    { length: 40 },
    (_, index) =>
      `Filler paragraph ${index + 1}: enough body copy for the document to be ` +
      `taller than the hero plus a viewport, so scroll positions in the test ` +
      `are real positions and not clamped to the bottom of a short page.\n`,
  ),
].join("\n");

/**
 * @type {Record<string, {
 *   title: string,
 *   image: { width: number, height: number, fill: string, accent: string } | null,
 *   gated?: boolean,
 *   avatar?: { fill: string },
 *   links?: Array<{ label: string, href: string }>,
 *   trailingLinks?: Array<{ label: string, href: string }>,
 * }>}
 */
const HERO_FIXTURES = {
  "hero-chips-bright-fixture": {
    title: "Hero with boost and ZEC chips",
    image: { width: 2400, height: 1350, fill: "#fafafa", accent: "#fafafa" },
    score: "1400",
    raised: "17",
    memberPrice: "5",
  },
  "hero-chips-dark-fixture": {
    title: "Hero with boost and ZEC chips",
    image: { width: 2400, height: 1350, fill: "#0a0a0c", accent: "#0a0a0c" },
    score: "1400",
    raised: "17",
    memberPrice: "5",
  },
  // The classic failure: an almost-white photograph under a headline that is
  // near-white in dark mode.
  "hero-bright-fixture": {
    title: "Bright hero fixture",
    image: { width: 2400, height: 1350, fill: "#fdfdfb", accent: "#f4f4ee" },
  },
  //...and its mirror, which breaks a light theme instead.
  "hero-dark-fixture": {
    title: "Dark hero fixture",
    image: { width: 2400, height: 1350, fill: "#07070a", accent: "#101018" },
  },
  // The shape the editor stored for every cover until  forced no shape
  // at all. A cover crop of it in a 2.45:1 hero loses 39% of the width off
  // both ends, which is where creators put their wordmark, so it stays as the
  // regression fixture even though it is no longer mandatory.
  "hero-cover-fixture": {
    title: "Stored cover hero fixture",
    image: { width: 1600, height: 400 },
    // The identical asset the card fixtures use, so one image runs through
    // every surface and a before/after comparison is legible across all of
    // them. Magenta bars on both extreme edges; if one is missing, it was
    // cropped.
    source: "cover",
  },
  //...and the same geometry as a *photograph*, because a flat colour blurs to
  // itself and makes the pad look worse than it is.
  "hero-photo-fixture": {
    title: "Photographic cover hero fixture",
    image: { width: 1600, height: 400 },
    source: "photo",
  },
  // 13:1. A cover crop of this is a sliver of one stripe.
  "hero-pano-fixture": {
    title: "Panorama hero fixture",
    image: { width: 4000, height: 300, fill: "#3f6212", accent: "#84cc16" },
  },
  // Smaller than a phone hero in both axes.
  "hero-tiny-fixture": {
    title: "Tiny hero fixture",
    image: { width: 96, height: 64, fill: "#456d0f", accent: "#bef264" },
  },
  // A headline block tall enough to reach well up into the photograph, where
  // a scrim anchored to a percentage of the *hero* is at its weakest. This is
  // the case the headline's own fixed-offset scrim exists for.
  "hero-longtitle-fixture": {
    title:
      "A deliberately very long headline that wraps onto four or five lines " +
      "on a phone so that the top of the title sits high up inside the " +
      "photograph rather than down in the strong part of the hero scrim",
    image: { width: 2400, height: 1350, fill: "#fdfdfb", accent: "#f7f7f2" },
  },
  // Enough headings that TableOfContents renders *and* starts collapsed
  // (`inlineOpen = items.length <= 6`), so a test can expand it. Expanding
  // moves the article down the document without changing the article's own
  // size — the case a ResizeObserver on the article alone cannot see.
  "hero-outline-fixture": {
    title: "Outline hero fixture",
    image: { width: 2400, height: 1350, fill: "#2a2a30", accent: "#84cc16" },
    headings: 16,
  },
  // No featured image at all: the hero must degrade to a clean title, not to a
  // broken or empty band.
  "hero-none-fixture": { title: "No image hero fixture", image: null },
  // Subscriber-only, with an image. The hero renders; the body must not.
  "hero-gated-fixture": {
    title: "Gated hero fixture",
    image: { width: 2400, height: 1350, fill: "#1c1c20", accent: "#65a30d" },
    gated: true,
  },
  // zPage -> zPage client navigation. Two pages whose cover AND
  // creator avatar are flat, saturated, mutually exclusive colours, so a
  // screenshot can say which page's pixels are on screen. Nothing else in the
  // app paints pure red or pure blue.
  "hero-nav-a-fixture": {
    title: "Navigation origin fixture",
    image: { width: 2400, height: 1350, fill: "#ff0000", accent: "#ff0000" },
    avatar: { fill: "#ff0000" },
    links: [
      {
        label: "Go to the navigation target",
        href: "/hero-user/hero-nav-b-fixture",
      },
    ],
    // At the END of a long body: the reader leaves from far down the page,
    // and Back has to bring them there again.
    trailingLinks: [
      {
        label: "Continue to the navigation target",
        href: "/hero-user/hero-nav-b-fixture",
      },
    ],
  },
  "hero-nav-b-fixture": {
    title: "Navigation target fixture",
    image: { width: 2400, height: 1350, fill: "#0000ff", accent: "#0000ff" },
    avatar: { fill: "#0000ff" },
    links: [
      // A navigation that lands on the SAME zPage but re-runs its load.
      {
        label: "Reload this navigation target",
        href: "/hero-user/hero-nav-b-fixture?lang=en",
      },
      {
        label: "Back to the navigation origin",
        href: "/hero-user/hero-nav-a-fixture",
      },
    ],
  },
  "hero-payment-a-fixture": {
    title: "Payment navigation origin fixture",
    image: { width: 2400, height: 1350, fill: "#ff0000", accent: "#ff0000" },
    avatar: { fill: "#ff0000" },
    memberPrice: "5",
    audio: true,
    links: [
      {
        label: "Go to the navigation target",
        href: "/hero-user/hero-payment-b-fixture",
      },
    ],
    trailingLinks: [
      {
        label: "Continue to the navigation target",
        href: "/hero-user/hero-payment-b-fixture",
      },
    ],
  },
  "hero-payment-b-fixture": {
    title: "Payment navigation target fixture",
    image: { width: 2400, height: 1350, fill: "#0000ff", accent: "#0000ff" },
    avatar: { fill: "#0000ff" },
    memberPrice: "5",
  },
};

/**
 * The cover-image fixture: 1600 x 400, the shape the editor forced on every
 * upload until, with a magenta bar pinned to each extreme edge and flat
 * green between them.
 *
 * That geometry is the whole regression. `object-fit: cover` in a 382x176 card
 * keeps the centre 54% of the width, so **both bars vanish** — which is exactly
 * how a creator's wordmark rendered as "LLA". Contained, both bars land on the
 * box's own left and right edges, and a screenshot can prove it.
 */
const COVER_FIXTURE_SESSION = "featured-image-fixture-session";
/** Same pages, but the photographic cover — for looking at, not asserting on. */
const PHOTO_FIXTURE_SESSION = "featured-image-photo-session";
/**
 * The owner's actual case in: a full-height poster. Before that issue the
 * editor could not even store this shape — every upload was forced to 4:1 — so
 * there was no fixture for it and no way to look at one on the real surfaces.
 */
const POSTER_FIXTURE_SESSION = "featured-image-poster-session";
const POSTER_FIXTURE_WIDTH = 900;
const POSTER_FIXTURE_HEIGHT = 1400;
const COVER_FIXTURE_WIDTH = 1600;
const COVER_FIXTURE_HEIGHT = 400;
const COVER_FIXTURE_EDGE = "#ff00ff";
const COVER_FIXTURE_FILL = "#3f6212";

/** @param {URL} url */
function coverFixtureSvg(url) {
  const width = Number(url.searchParams.get("w")) || COVER_FIXTURE_WIDTH;
  const height = Number(url.searchParams.get("h")) || COVER_FIXTURE_HEIGHT;
  const bar = Math.max(2, Math.round(width * 0.075));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`,
    ` viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${COVER_FIXTURE_FILL}"/>`,
    `<rect width="${bar}" height="${height}" fill="${COVER_FIXTURE_EDGE}"/>`,
    `<rect x="${width - bar}" width="${bar}" height="${height}" fill="${COVER_FIXTURE_EDGE}"/>`,
    `</svg>`,
  ].join("");
}

/**
 * A *photographic* stand-in: layered gradients plus `feTurbulence`, with a
 * wordmark banked hard against the left edge the way creators actually lay a
 * title card out.
 *
 * The flat-colour fixture above is the right tool for a pixel assertion — a
 * solid bar is unambiguous — but it is the wrong thing to *look* at, because
 * blurring a solid colour just returns that colour and the pad reads as a
 * washed-out band. Real covers have tonal variation, and that is what the pad
 * is designed around.
 *
 * @param {URL} url
 */
function photoFixtureSvg(url) {
  const width = Number(url.searchParams.get("w")) || COVER_FIXTURE_WIDTH;
  const height = Number(url.searchParams.get("h")) || COVER_FIXTURE_HEIGHT;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`,
    ` viewBox="0 0 ${width} ${height}">`,
    `<defs>`,
    `<linearGradient id="sky" x1="0" y1="0" x2=".35" y2="1">`,
    `<stop offset="0" stop-color="#0b2a3a"/><stop offset=".45" stop-color="#1f6f5c"/>`,
    `<stop offset="1" stop-color="#d9a441"/></linearGradient>`,
    `<radialGradient id="sun" cx=".72" cy=".28" r=".38">`,
    `<stop offset="0" stop-color="#ffe9a8"/><stop offset="1" stop-color="#ffe9a8" stop-opacity="0"/>`,
    `</radialGradient>`,
    `<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3"/>`,
    `<feColorMatrix type="saturate" values="0"/></filter>`,
    `</defs>`,
    `<rect width="${width}" height="${height}" fill="url(#sky)"/>`,
    `<rect width="${width}" height="${height}" fill="url(#sun)"/>`,
    `<path d="M0 ${height * 0.78}L${width * 0.22} ${height * 0.52}L${width * 0.38} ${height * 0.72}`,
    `L${width * 0.61} ${height * 0.4}L${width * 0.82} ${height * 0.69}L${width} ${height * 0.55}`,
    `V${height}H0Z" fill="#08202b" opacity=".85"/>`,
    `<rect width="${width}" height="${height}" filter="url(#grain)" opacity=".12"/>`,
    // Hard against the left edge: this is the text a centre crop deletes.
    `<text x="${width * 0.02}" y="${height * 0.46}" font-family="Helvetica,Arial,sans-serif"`,
    ` font-size="${height * 0.3}" font-weight="700" fill="#f8fafc">DYNAWALLA</text>`,
    `<text x="${width * 0.02}" y="${height * 0.66}" font-family="Helvetica,Arial,sans-serif"`,
    ` font-size="${height * 0.11}" fill="#a3e635">a zcash wallet, end to end</text>`,
    `</svg>`,
  ].join("");
}

/**
 * @param {string} origin
 * @param {"cover" | "photo" | "poster"} [variant]
 */
function coverFixturePages(origin, variant = "cover") {
  const poster = variant === "poster";
  const width = poster ? POSTER_FIXTURE_WIDTH : COVER_FIXTURE_WIDTH;
  const height = poster ? POSTER_FIXTURE_HEIGHT : COVER_FIXTURE_HEIGHT;
  const imageUrl =
    `${origin}/fixture-${poster ? "photo" : variant}.svg` +
    `?w=${width}&h=${height}`;
  return Array.from({ length: 6 }, (_, index) => ({
    id: 4200 + index,
    free2zaddr: `cover-fixture-${index}`,
    vanity: `cover-fixture-${index}`,
    title: `Cover fixture page ${index + 1}`,
    description: "A cover whose meaning lives at its two edges.",
    created_at: "2026-08-14T12:00:00Z",
    updated_at: "2026-08-14T12:00:00Z",
    is_published: true,
    is_subscriber_only: false,
    category: "Technology",
    f2z_score: "1",
    creator: {
      username: "coverfixture",
      full_name: "Cover Fixture",
      avatar_image: {},
    },
    featured_image: { url: imageUrl, thumbnail: imageUrl, title: "Cover" },
    get_url: `/coverfixture/cover-fixture-${index}`,
    tags: [],
    source_language: "en",
    requested_language: "en",
    actual_language: "en",
  }));
}

/** A deterministic SVG of the requested size — the fixture "photograph". */
function heroFixtureSvg(url) {
  const width = Number(url.searchParams.get("w")) || 1200;
  const height = Number(url.searchParams.get("h")) || 800;
  const fill = url.searchParams.get("fill") || "#888888";
  const accent = url.searchParams.get("accent") || fill;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`,
    ` viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${fill}"/>`,
    // Some structure, so a blur has something to blur and a crop has something
    // to crop. Kept high-contrast against `fill` on purpose.
    `<circle cx="${width * 0.5}" cy="${height * 0.45}" r="${Math.min(width, height) * 0.3}" fill="${accent}"/>`,
    `<rect y="${height * 0.72}" width="${width}" height="${height * 0.06}" fill="${accent}"/>`,
    `</svg>`,
  ].join("");
}

function heroFixturePayload(vanity, origin) {
  const fixture = HERO_FIXTURES[vanity];
  if (!fixture) return null;

  const image = fixture.image;
  const imageUrl = !image
    ? null
    : fixture.source
      ? `${origin}/fixture-${fixture.source === "photo" ? "photo" : "cover"}.svg` +
        `?w=${image.width}&h=${image.height}`
      : `${origin}/fixture-hero.svg?w=${image.width}&h=${image.height}` +
        `&fill=${encodeURIComponent(image.fill)}&accent=${encodeURIComponent(image.accent)}`;
  const avatarUrl = fixture.avatar
    ? `${origin}/fixture-hero.svg?w=160&h=160&role=avatar` +
      `&fill=${encodeURIComponent(fixture.avatar.fill)}`
    : null;
  /** @param {Array<{ label: string, href: string }>} [list] */
  const markdownLinks = (list) =>
    (list ?? []).map(({ label, href }) => `[${label}](${href})`);
  const body = [
    ...markdownLinks(fixture.links),
    ...(fixture.audio ? ["::embed[/uploadz/zpage-nav-audio.wav]"] : []),
    HERO_FIXTURE_CONTENT,
    ...markdownLinks(fixture.trailingLinks),
  ].join("\n\n");

  return {
    free2zaddr: vanity,
    vanity,
    p2paddr: "",
    title: fixture.title,
    description: "Fixture for the zPage parallax hero regressions.",
    content: fixture.headings
      ? [
          ...Array.from(
            { length: fixture.headings },
            (_, index) =>
              `## Outline section ${index + 1}\n\nProse under section ${index + 1}.\n`,
          ),
          HERO_FIXTURE_CONTENT,
        ].join("\n")
      : body,
    is_published: true,
    is_subscriber_only: !!fixture.gated,
    total_raised: fixture.raised ?? 0,
    total: "0",
    f2z_score: fixture.score ?? "0",
    is_verified: false,
    comments: [],
    creator: {
      id: 4201,
      username: "hero-user",
      full_name: "Hero User",
      avatar_image: avatarUrl ? { url: avatarUrl, thumbnail: avatarUrl } : {},
      member_price: fixture.memberPrice ?? (fixture.gated ? "5" : null),
    },
    // `url` and `thumbnail` are the same asset here, so the component omits the
    // narrow-viewport <source> exactly as it does for a real upload with no
    // separate thumbnail.
    featured_image: imageUrl
      ? { url: imageUrl, thumbnail: imageUrl, title: `${fixture.title} image` }
      : {},
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
    get_url: `/hero-user/${vanity}`,
    tags: [],
    source_language: "en",
    requested_language: "en",
    actual_language: "en",
    fallback_used: false,
    available_languages: ["en"],
    variant_is_published: true,
  };
}

/** @param {number} days */
function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

const converseDeadlineState = { started: false, closed: false };
const ssrEnrichmentStallState = new Map();

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");

  if (url.pathname === "/api/economy/capabilities/") {
    response.end(
      JSON.stringify({
        policy_version: 0,
        active: false,
        creator_compensation_available: false,
      }),
    );
    return;
  }

  if (url.pathname === "/__requests") {
    if (request.method === "DELETE") {
      received = [];
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.end(JSON.stringify(received));
    return;
  }

  if (url.pathname === "/__ssr-enrichment-stall" && request.method === "POST") {
    const id = url.searchParams.get("id") || "";
    ssrEnrichmentStallState.set(id, { started: false, closed: false });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/__ssr-enrichment-stall" && request.method === "GET") {
    const id = url.searchParams.get("id") || "";
    response.end(
      JSON.stringify(
        ssrEnrichmentStallState.get(id) || { started: false, closed: false },
      ),
    );
    return;
  }

  // The homepage SSR request cannot be intercepted by Playwright's browser
  // routing. This control endpoint lets a browser test make the next real
  // mock-server discovery response fail, then verify hydration recovers with
  // the following client request.
  if (url.pathname === "/__live-discovery-mode" && request.method === "POST") {
    liveDiscoveryMode = url.searchParams.get("mode") || "normal";
    liveDiscoveryFailures = 0;
    response.end(JSON.stringify({ ok: true, mode: liveDiscoveryMode }));
    return;
  }

  if (url.pathname === "/__live-discovery-mode" && request.method === "GET") {
    response.end(
      JSON.stringify({
        mode: liveDiscoveryMode,
        failures: liveDiscoveryFailures,
      }),
    );
    return;
  }

  if (url.pathname === "/__billing/balance" && request.method === "POST") {
    billingFixtureObservation += 1;
    billingFixtureBalance =
      url.searchParams.get("amount") || BILLING_FIXTURE_TUZIS;
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (
    url.pathname === "/__billing/renewal-summary" &&
    request.method === "POST"
  ) {
    billingFixtureRenewalSummary = await readJson(request);
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/__billing/reset" && request.method === "POST") {
    billingFixtureBalance = BILLING_FIXTURE_TUZIS;
    billingFixtureObservation = 1;
    billingFixtureRenewalSummary = null;
    billingFixtureSubscriptions = structuredClone(
      BILLING_FIXTURE_SUBSCRIPTIONS,
    );
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/__zpage-delete/reset" && request.method === "POST") {
    zpageDeleteFixtureMode = url.searchParams.get("mode") || "normal";
    zpageDeleteFixturePages = structuredClone(
      zpageDeleteFixtureMode === "page2"
        ? ZPAGE_DELETE_FIXTURE_PAGE2_PAGES
        : ZPAGE_DELETE_FIXTURE_PAGES,
    );
    zpageDeleteFixtureVersions = new Map();
    response.end(JSON.stringify({ ok: true, mode: zpageDeleteFixtureMode }));
    return;
  }

  if (url.pathname === "/__zpage-delete/touch" && request.method === "POST") {
    const id = url.searchParams.get("id") || "";
    zpageDeleteFixtureVersions.set(
      id,
      (zpageDeleteFixtureVersions.get(id) || 1) + 1,
    );
    response.end(
      JSON.stringify({ ok: true, etag: zpageDeleteFixtureEtag(id) }),
    );
    return;
  }

  if (url.pathname === "/__boost-score" && request.method === "POST") {
    // Accepts either the fixture vanity or the page's free2zaddr, so a
    // browser route handler that only sees the fund POST's `id` can mirror
    // the server-side score write into this fixture.
    const vanity = url.searchParams.get("vanity");
    const score = url.searchParams.get("score");
    const page =
      (vanity && BOOST_FIXTURE_PAGES[vanity]) ||
      Object.values(BOOST_FIXTURE_PAGES).find((p) => p.free2zaddr === vanity);
    if (!page || score === null) {
      response.statusCode = 400;
      response.end(JSON.stringify({ detail: "Invalid boost fixture score" }));
      return;
    }
    page.f2z_score = score;
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    received.push({
      path: url.pathname + url.search,
      method: request.method,
      cookie: request.headers.cookie ?? null,
      origin: request.headers.origin ?? null,
      csrf: request.headers["x-csrftoken"] ?? null,
      ifMatch: request.headers["if-match"] ?? null,
    });
  }

  if (url.pathname === "/healthz") {
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/api/dyte/public/discovery/") {
    if (liveDiscoveryMode === "fail-next") {
      liveDiscoveryMode = "normal";
      liveDiscoveryFailures += 1;
      response.statusCode = 503;
      response.end(
        JSON.stringify({ detail: "Live discovery fixture failure" }),
      );
      return;
    }
    response.end(JSON.stringify([]));
    return;
  }

  // The third-party media probes for, plus their own hit counters. The
  // counters are the evidence that matters: asserting from inside the browser
  // that a request was not issued is an assertion about an absence, while a
  // counter that is still 0 *at the third party* is the tracker's own view of
  // the reader — which is exactly what the issue is about.
  if (url.pathname === "/__media-probe") {
    if (request.method === "DELETE") {
      thirdPartyAudioHits = 0;
      thirdPartyVideoHits = 0;
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.end(
      JSON.stringify({
        audioHits: thirdPartyAudioHits,
        videoHits: thirdPartyVideoHits,
      }),
    );
    return;
  }

  if (url.pathname === THIRD_PARTY_AUDIO_PATH) {
    thirdPartyAudioHits += 1;
    // `<audio crossorigin="anonymous">` makes the media fetch a CORS request,
    // so without this the element would fail to decode even after play and
    // the "playing still works" half of the test would pass for the wrong
    // reason. Range is advertised because that is what a media element asks
    // for; this body is small enough that serving it whole is always valid.
    response.setHeader("content-type", "audio/wav");
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("accept-ranges", "bytes");
    response.end(silentWav());
    return;
  }

  if (url.pathname === "/uploadz/zpage-nav-audio.wav") {
    response.setHeader("content-type", "audio/wav");
    response.setHeader("accept-ranges", "bytes");
    response.end(silentWav());
    return;
  }

  if (url.pathname === THIRD_PARTY_VIDEO_PATH) {
    thirdPartyVideoHits += 1;
    response.setHeader("content-type", "video/mp4");
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("accept-ranges", "bytes");
    // A minimal MP4 file-type box is sufficient for this regression: the
    // assertion is that the media element requests the URL after consent, not
    // that Chromium can decode a particular fixture codec.
    response.end(
      Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex"),
    );
    return;
  }

  // A photographic stand-in, for judging how the pad actually looks.
  if (url.pathname === "/fixture-photo.svg") {
    response.setHeader("content-type", "image/svg+xml");
    response.setHeader("access-control-allow-origin", "*");
    response.end(photoFixtureSvg(url));
    return;
  }

  // The generated cover behind the featured-image (blur-pad) fixtures.
  if (url.pathname === "/fixture-cover.svg") {
    response.setHeader("content-type", "image/svg+xml");
    response.setHeader("access-control-allow-origin", "*");
    response.end(coverFixtureSvg(url));
    return;
  }

  // The generated "photograph" behind the parallax hero fixtures.
  if (url.pathname === "/fixture-hero.svg") {
    response.setHeader("content-type", "image/svg+xml");
    response.setHeader("access-control-allow-origin", "*");
    response.end(heroFixtureSvg(url));
    return;
  }

  const heroFixtureMatch = url.pathname.match(/^\/api\/zpage\/([^/]+)\/$/);
  if (heroFixtureMatch) {
    const payload = heroFixturePayload(
      decodeURIComponent(heroFixtureMatch[1]),
      url.origin,
    );
    if (payload) {
      // A subscriber-only page comes back wrapped, and the wrapper is what puts
      // the route on its gated branch.
      response.end(
        JSON.stringify(
          payload.is_subscriber_only
            ? { show_modal: true, page: { ...payload, content: "" } }
            : payload,
        ),
      );
      return;
    }
  }

  const boostPageMatch = url.pathname.match(/^\/api\/zpage\/(boost-[ab])\/$/);
  if (request.method === "GET" && boostPageMatch) {
    response.end(
      JSON.stringify(
        boostFixtureArticle(BOOST_FIXTURE_PAGES[boostPageMatch[1]]),
      ),
    );
    return;
  }

  const supportPageMatch = url.pathname.match(
    /^\/api\/zpage\/(support-zec(?:-t)?)\/$/,
  );
  if (request.method === "GET" && supportPageMatch) {
    response.end(
      JSON.stringify(
        supportFixtureArticle(SUPPORT_FIXTURE_PAGES[supportPageMatch[1]]),
      ),
    );
    return;
  }

  const supportSeriesPage = Object.values(SUPPORT_FIXTURE_PAGES).find(
    (page) => url.pathname === `/api/g12f/zpage/${page.free2zaddr}/series/`,
  );
  if (request.method === "GET" && supportSeriesPage) {
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: "Not found." }));
    return;
  }

  const boostSeriesPage = Object.values(BOOST_FIXTURE_PAGES).find(
    (page) => url.pathname === `/api/g12f/zpage/${page.free2zaddr}/series/`,
  );
  if (request.method === "GET" && boostSeriesPage) {
    response.end(
      JSON.stringify({
        id: "boost-fixture-series",
        name: "Boost fixture series",
        pageorder_set: Object.values(BOOST_FIXTURE_PAGES).map(
          (page, index) => ({
            order: index + 1,
            page: boostFixtureArticle(page),
          }),
        ),
      }),
    );
    return;
  }

  // Billing fixtures (issue ). Only requests carrying one of these
  // sessions are authenticated, so the anonymous-SSR assertions in  keep
  // working while the summary states remain independently testable.
  const cookie = request.headers.cookie || "";
  const isBillingFixture = cookie.includes(
    `sessionid=${BILLING_FIXTURE_SESSION}`,
  );
  const isBillingShortfall = cookie.includes(
    `sessionid=${BILLING_SHORTFALL_SESSION}`,
  );
  const isBillingEmpty = cookie.includes(`sessionid=${BILLING_EMPTY_SESSION}`);
  const isBillingUnknown = cookie.includes(
    `sessionid=${BILLING_UNKNOWN_SESSION}`,
  );
  const isBillingSession =
    isBillingFixture ||
    isBillingShortfall ||
    isBillingEmpty ||
    isBillingUnknown;
  const isBoostFixtureSession = cookie.includes(
    `sessionid=${BOOST_FIXTURE_SESSION}`,
  );
  const isRawWriteFixtureSession = cookie.includes(
    `sessionid=${RAW_WRITE_FIXTURE_SESSION}`,
  );
  const isReportBlockFixtureSession = cookie.includes(
    `sessionid=${REPORT_BLOCK_FIXTURE_SESSION}`,
  );
  const isResetPasswordSuccessSession = cookie.includes(
    `sessionid=${RESET_PASSWORD_SUCCESS_SESSION}`,
  );
  const isCursorFixtureSession = cookie.includes(
    `sessionid=${CURSOR_FIXTURE_SESSION}`,
  );
  const isStreamAudienceFixture = cookie.includes(
    `sessionid=${STREAM_AUDIENCE_FIXTURE_SESSION}`,
  );

  const profileFixture = Object.entries(PROFILE_FIXTURES).find(([session]) =>
    cookie.includes(`sessionid=${session}`),
  )?.[1];
  const isZPageDeleteFixture = cookie.includes(
    `sessionid=${ZPAGE_DELETE_FIXTURE_SESSION}`,
  );

  const zpageDeleteMatch = url.pathname.match(/^\/api\/zpage\/([^/]+)\/$/);
  if (isZPageDeleteFixture && request.method === "GET" && zpageDeleteMatch) {
    // The owner detail read: only its canonical `ETag` matters here.
    const identifier = decodeURIComponent(zpageDeleteMatch[1]);
    const row = zpageDeleteFixtureRows().find(
      (page) => page.free2zaddr === identifier || page.vanity === identifier,
    );
    if (!row) {
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: "Not found." }));
      return;
    }
    response.setHeader("ETag", zpageDeleteFixtureEtag(row.free2zaddr));
    response.end(JSON.stringify(row));
    return;
  }

  if (isZPageDeleteFixture && request.method === "DELETE" && zpageDeleteMatch) {
    // `If-Match` is evaluated exactly as `preconditions.check_if_match` does:
    // absent = unconditional, present and stale = 412. There is deliberately
    // no mode that answers 412 regardless -- a client that never sends the
    // header must not be able to pass the conflict spec.
    const ifMatch = request.headers["if-match"];
    const target = decodeURIComponent(zpageDeleteMatch[1]);
    const targetRow = zpageDeleteFixturePages.find(
      (page) => page.free2zaddr === target || page.vanity === target,
    );
    if (
      ifMatch !== undefined &&
      targetRow &&
      ifMatch !== zpageDeleteFixtureEtag(targetRow.free2zaddr)
    ) {
      response.statusCode = 412;
      response.end(
        JSON.stringify({
          detail:
            "This page changed while you were viewing it. Reload before deleting.",
        }),
      );
      return;
    }
    if (zpageDeleteFixtureMode === "protected") {
      // What Django returns when legacy on-chain Transaction/PageComment rows
      // PROTECT the page: a permanent 409 refusal with an actionable detail.
      response.statusCode = 409;
      response.end(
        JSON.stringify({
          detail:
            "This page has on-chain payments or comments recorded against it, so it cannot be deleted. You can unpublish it instead.",
        }),
      );
      return;
    }
    if (zpageDeleteFixtureMode === "failure") {
      response.statusCode = 503;
      response.end(JSON.stringify({ detail: "Fixture delete failure" }));
      return;
    }
    const identifier = decodeURIComponent(zpageDeleteMatch[1]);
    const index = zpageDeleteFixturePages.findIndex(
      (page) => page.free2zaddr === identifier || page.vanity === identifier,
    );
    if (index < 0) {
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: "Not found." }));
      return;
    }
    zpageDeleteFixturePages.splice(index, 1);
    response.statusCode = 204;
    response.end();
    return;
  }

  // --- /tag/<slug> hub fixtures  -------------------------------------
  //
  // Keyed on the SLUG, not on a session: the tag hub deliberately forwards no
  // cookie (a topic hub is public, shared content), so a session-keyed fixture
  // could not reach it and neither can a browser-side `page.route` — the route
  // is server-rendered, which is the entire point of the feature.
  if (url.pathname.startsWith("/api/tagging/hub/")) {
    const slug = decodeURIComponent(
      url.pathname.slice("/api/tagging/hub/".length),
    );
    const hub = TAG_HUB_FIXTURES[slug];
    if (!hub) {
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: "No such tag." }));
      return;
    }
    response.end(JSON.stringify(hub));
    return;
  }

  if (
    url.pathname === "/api/zpage/" &&
    (url.searchParams.has("any_tags") || url.searchParams.has("hub_slug"))
  ) {
    // Hub pages use one bounded public slug. Keep the legacy any_tags fixture
    // path too, because it is still a supported API contract for other clients.
    const names = url.searchParams.getAll("any_tags");
    const hub = url.searchParams.has("hub_slug")
      ? TAG_HUB_FIXTURES[url.searchParams.get("hub_slug")]
      : Object.values(TAG_HUB_FIXTURES).find(
          (entry) =>
            entry.names.length === names.length &&
            entry.names.every((name, index) => name === names[index]),
        );
    const rows = hub ? TAG_HUB_PAGES[hub.slug] || [] : [];
    const page = Number(url.searchParams.get("page") || "1");
    const pageSize = Number(url.searchParams.get("page_size") || "12");
    const slice = rows.slice((page - 1) * pageSize, page * pageSize);
    if (page > 1 && slice.length === 0) {
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: "Invalid page." }));
      return;
    }
    response.end(
      JSON.stringify({
        count: rows.length,
        next: page * pageSize < rows.length ? "next" : null,
        previous: page > 1 ? "previous" : null,
        results: slice,
      }),
    );
    return;
  }

  // Homepage creator spotlight fixture. It is deliberately keyed to the
  // same updated-directory query and focused test sessions, so live-status
  // tests can render a CreatorCard without changing unrelated homepage tests.
  if (
    url.pathname === "/api/creator/" &&
    url.searchParams.get("homeSort") === "updated" &&
    (cookie.includes("sessionid=homepage-live-fallback-session") ||
      cookie.includes("sessionid=homepage-live-empty-session") ||
      cookie.includes("sessionid=homepage-live-ssr-failure-session"))
  ) {
    response.end(
      JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            username: "homepage-live-fallback",
            full_name: "Homepage Live Fallback",
            avatar_image: null,
            banner_image: null,
            is_verified: false,
            zpages: 1,
            total: "0.00000000",
            member_price: null,
            is_live: false,
          },
        ],
      }),
    );
    return;
  }

  if (
    url.pathname === "/api/tagging/autocomplete" &&
    url.searchParams.get("type") === "zpage" &&
    url.searchParams.get("username")?.toLowerCase() === TAG_FILTER_FIXTURE_USER
  ) {
    const mine = url.searchParams.get("mine") === "true";
    const isOwner = cookie.includes(`sessionid=${TAG_FILTER_OWNER_SESSION}`);
    if (mine && !isOwner) {
      response.statusCode = 401;
      response.end(JSON.stringify({ detail: "Not authenticated" }));
      return;
    }

    const query = (url.searchParams.get("query") || "").trim().toLowerCase();
    const vocabulary = mine ? TAG_FILTER_OWNER : TAG_FILTER_PUBLIC;
    const results = query
      ? vocabulary.filter((tag) => tag.name.toLowerCase().includes(query))
      : vocabulary.slice(0, 100);

    // Hold one response long enough for the browser to issue a newer query.
    // The component must ignore this response even if the transport cannot be
    // cancelled after the mock has started writing it.
    if (query === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    response.end(JSON.stringify(results));
    return;
  }

  // --- /trending mobile-layout fixture --------------------------------------
  // Also keyed on a session, for the same reason as the cover fixture below:
  // /trending is server-rendered, so a browser-side `page.route` cannot reach
  // it. The titles are the point — a 96-character sentence and a 61-character
  // unbreakable single token, because a compact card that only ever sees
  // "Cover fixture page 3" proves nothing about wrapping. The spec hardcodes
  // this session name.
  if (
    url.pathname === "/api/zpage/" &&
    cookie.includes("sessionid=trending-mobile-session")
  ) {
    const titles = [
      "How a shielded payment memo becomes a credit on your Free2Z balance, end to end",
      "Supercalifragilisticexpialidociousunbreakabletitletokenwithnospaces",
      "Short one",
      "Notes from the field: what six months of publishing taught us about audiences",
    ];
    response.end(
      JSON.stringify({
        count: titles.length,
        next: null,
        previous: null,
        results: titles.map((title, index) => ({
          id: 7100 + index,
          free2zaddr: `trending-mobile-${index}`,
          vanity: `trending-mobile-${index}`,
          title,
          description:
            "A description long enough to be clamped rather than shown whole, which is the point of the compact row.",
          created_at: "2026-08-14T12:00:00Z",
          updated_at: "2026-08-14T12:00:00Z",
          is_published: true,
          category: "Technology",
          tags: ["zcash", "privacy"],
          creator: {
            username: "trendingmobilefixturecreatorwithalongname",
            full_name: "A Creator Whose Display Name Runs Well Past The Column",
            avatar_image: {},
          },
          get_url: `/trendingmobilefixturecreatorwithalongname/trending-mobile-${index}`,
        })),
      }),
    );
    return;
  }

  // Keyed on a session cookie rather than on a query parameter, because
  // /trending is server-rendered and forwards the cookie — so this is one of
  // the few handles a browser test has on an SSR list. Every other fixture in
  // this file is untouched by it.
  if (
    url.pathname === "/api/zpage/" &&
    (cookie.includes(`sessionid=${COVER_FIXTURE_SESSION}`) ||
      cookie.includes(`sessionid=${PHOTO_FIXTURE_SESSION}`) ||
      cookie.includes(`sessionid=${POSTER_FIXTURE_SESSION}`))
  ) {
    const variant = cookie.includes(`sessionid=${POSTER_FIXTURE_SESSION}`)
      ? "poster"
      : cookie.includes(`sessionid=${PHOTO_FIXTURE_SESSION}`)
        ? "photo"
        : "cover";
    const results = coverFixturePages(url.origin, variant);
    response.end(
      JSON.stringify({
        count: results.length,
        next: null,
        previous: null,
        results,
      }),
    );
    return;
  }

  const socialImageFixture =
    /^\/api\/creator\/social-image-(webp|jpg|unknown|malformed|public)\/?$/.exec(
      url.pathname,
    );
  if (socialImageFixture) {
    const extension = socialImageFixture[1];
    response.end(
      JSON.stringify({
        username: `social-image-${extension}`,
        full_name: "Social Image Fixture",
        description: "A public profile with a custom cover.",
        avatar_image: null,
        banner_image: {
          url:
            extension === "malformed"
              ? "https://[broken"
              : extension === "public"
                ? "https://free2z.cash/uploadz/public/fixture/cover.webp?generation=123&v=one%2Btwo"
                : `https://media.free2z.example/cover.${extension}`,
          thumbnail:
            extension === "malformed"
              ? "https://[broken"
              : extension === "public"
                ? "https://free2z.cash/uploadz/public/fixture/cover.webp?generation=123&v=one%2Btwo"
                : `https://media.free2z.example/cover.${extension}`,
        },
      }),
    );
    return;
  }

  // Live-stream viewer fixture. The username the API returns is
  // deliberately LOWER-CASE while the tests request mixed case, because the
  // real `/api/creator/{u}/` looks up `username__iexact` and answers with the
  // stored casing — that is what the page's canonical must echo, not whatever
  // the visitor typed.
  if (
    url.pathname.toLowerCase() === `/api/creator/${LIVE_FIXTURE_USER}/` ||
    url.pathname.toLowerCase() === `/api/creator/${LIVE_FIXTURE_USER}`
  ) {
    response.end(
      JSON.stringify({
        username: LIVE_FIXTURE_USER,
        full_name: "Live Fixture Creator",
        description: "A creator who streams on Free2Z.",
        avatar_image: null,
        banner_image: null,
      }),
    );
    return;
  }

  if (
    url.pathname.toLowerCase() ===
      `/api/creator/${PAID_STREAM_FIXTURE_USER}/` ||
    url.pathname.toLowerCase() === `/api/creator/${PAID_STREAM_FIXTURE_USER}`
  ) {
    response.end(
      JSON.stringify({
        username: PAID_STREAM_FIXTURE_USER,
        full_name: "Paid Stream Creator",
        description: "Members-only and pay-per-view streams on Free2Z.",
        avatar_image: {
          url: PAID_STREAM_FIXTURE_AVATAR,
          thumbnail: PAID_STREAM_FIXTURE_AVATAR,
        },
        banner_image: null,
      }),
    );
    return;
  }

  if (
    url.pathname.toLowerCase() === `/api/creator/${TAG_FILTER_FIXTURE_USER}/` ||
    url.pathname.toLowerCase() === `/api/creator/${TAG_FILTER_FIXTURE_USER}`
  ) {
    response.end(
      JSON.stringify({
        username: TAG_FILTER_FIXTURE_USER,
        full_name: "Tag Filter Fixture Creator",
        description: "A profile with a long-tail tag vocabulary.",
        avatar_image: null,
        banner_image: null,
        is_verified: false,
        zpages: 12,
        member_price: null,
        p2paddr: "",
      }),
    );
    return;
  }

  //creators `legacy-route-redirects.spec.ts` needs `[username]` to
  // RENDER, not merely reach. Against the catch-all list body below the creator
  // page 500s, so that spec could only assert "not 410/301/302" -- which a
  // crash satisfies. A well-formed creator lets it assert a 200 carrying this
  // creator's name instead.
  const routingCreator = url.pathname
    .toLowerCase()
    .match(/^\/api\/creator\/([^/]+)\/?$/)?.[1];
  if (routingCreator && ROUTING_FIXTURE_CREATORS.has(routingCreator)) {
    response.end(
      JSON.stringify({
        username: routingCreator,
        full_name: `Routing fixture ${routingCreator}`,
        description: "A creator the legacy-route spec must reach.",
        avatar_image: null,
        banner_image: null,
        is_verified: false,
        zpages: 0,
        member_price: null,
        p2paddr: "",
      }),
    );
    return;
  }

  if (
    url.pathname.toLowerCase() === `/api/creator/${CURSOR_FIXTURE_USER}/` ||
    url.pathname.toLowerCase() === `/api/creator/${CURSOR_FIXTURE_USER}`
  ) {
    response.end(JSON.stringify(CURSOR_FIXTURE_CREATOR));
    return;
  }

  //  Stage-4 deploy-gate negative control. The real Django creator
  // lookup answers 404 for an unknown username; keep one explicit miss so the
  // browser suite proves SvelteKit preserves that status instead of rendering
  // a classic-style soft-404 shell.
  if (
    url.pathname === "/api/creator/stage-cutover-missing-1502/" ||
    url.pathname === "/api/creator/stage-cutover-missing-1502"
  ) {
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: "Not found." }));
    return;
  }

  if (url.pathname === "/api/auth/user/") {
    if (isZPageDeleteFixture) {
      response.end(
        JSON.stringify({
          id: 9700,
          username: ZPAGE_DELETE_FIXTURE_USER,
          full_name: "zPage deletion fixture creator",
        }),
      );
      return;
    }
    if (isCursorFixtureSession) {
      response.end(JSON.stringify(CURSOR_FIXTURE_CREATOR));
      return;
    }
    if (isStreamAudienceFixture) {
      response.end(
        JSON.stringify({
          username: STREAM_AUDIENCE_FIXTURE_USER,
          full_name: "Stream Audience Fixture Creator",
          can_stream: true,
          tuzis: "150.000",
          member_price: "50",
          p2paddr: "",
          description: "A creator fixture for the Go Live audience controls.",
        }),
      );
      return;
    }
    if (profileFixture) {
      response.end(
        JSON.stringify({
          id:
            4498 +
            Object.values(PROFILE_FIXTURES).findIndex(
              (item) => item.username === profileFixture.username,
            ),
          username: profileFixture.username,
          // 128 unbroken characters: `full_name` is max_length=128 and there is
          // nothing for the browser to wrap on.
          full_name: "W".repeat(128),
          tuzis: profileFixture.tuzis ?? PROFILE_FIXTURE_TUZIS,
          // The old stat read this. It is a ZEC-equivalent page-support cache
          // (Creator.cache_total), not 2Z — kept in the fixture precisely so a
          // regression that goes back to it shows a different number.
          total: "3.45372709",
          member_price: "50",
          p2paddr: PROFILE_FIXTURE_ADDRESS,
          description: "",
          // A plain integer, DB-counted. This used to be `fans`, a 2468-element
          // array of usernames whose only reader was `.length`. The
          // fixture keeps the same magnitude so the tile still asserts "2,468"
          // and a regression back to the roster would fail to render at all.
          fans_count: 2468,
        }),
      );
      return;
    }
    if (isBillingSession) {
      response.end(
        JSON.stringify({
          id: 4301,
          username: BILLING_FIXTURE_USER,
          // A DRF decimal STRING, which is what the real API sends. It used to
          // be the number 100000, and that is precisely why  survived:
          // `String.prototype.toLocaleString` is a no-op, but a *number*
          // formats fine, so the fixture rendered "100,000" and hid the bug.
          tuzis: isBillingShortfall ? "20.500" : billingFixtureBalance,
          balance_snapshot: `${8123 + billingFixtureObservation}:0`,
          member_price: BILLING_FIXTURE_CREATOR_PRICE,
        }),
      );
      return;
    }
    // First-party card readers  are REAL signed-in users, so the
    // browser runs the `user:` identity path, not anonymous (review F1).
    const cardSession = (request.headers.cookie || "").match(
      /sessionid=(fp-card-(?:owner|subscriber|stranger))\b/,
    )?.[1];
    if (cardSession) {
      response.end(JSON.stringify(FP_CARD_USERS[cardSession]));
      return;
    }
    response.statusCode = 401;
    response.end(JSON.stringify({ detail: "Not authenticated" }));
    return;
  }

  if (
    url.pathname === "/api/stripe/create-checkout-session/" &&
    request.method === "POST" &&
    isBillingFixture
  ) {
    if (
      request.headers.origin !== trustedAppOrigin ||
      request.headers["x-csrftoken"] !== BILLING_FIXTURE_CSRF ||
      !(request.headers.cookie || "").includes(
        `csrftoken=${BILLING_FIXTURE_CSRF}`,
      )
    ) {
      response.statusCode = 403;
      response.end(JSON.stringify({ detail: "CSRF Failed" }));
      return;
    }
    const body = await readJson(request);
    if (!Number.isInteger(body.quantity) || body.quantity < 1) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Invalid quantity" }));
      return;
    }
    response.end(
      JSON.stringify({
        id: "cs_test_authoritative_quote",
        url:
          body.quantity === 14
            ? "https://checkout.stripe.com.attacker.example/c/pay/test"
            : "https://checkout.stripe.com/c/pay/cs_test_authoritative_quote#fidkdWxOYHwnPyd1",
        quote: {
          checkout_intent_id: "00000000-0000-4000-8000-000000000125",
          // Quantity 13 is the focused malformed-contract fixture.
          tuzis: body.quantity === 13 ? 14 : body.quantity,
          // Deliberately not derivable from the entered quantity: the browser
          // assertion proves it displays the server contract, not local math.
          amount_cents: 777,
          currency: "usd",
          pricing_version: "card-v2-test",
        },
      }),
    );
    return;
  }

  // zPage fixture for the direct-media consent boundary. Audio and
  // video each have a cross-origin tracker and a same-origin hosted upload:
  //
  //   1. cross-origin  — this mock server's own origin, which differs from the
  //      app origin by port, so the browser treats it as third party exactly
  //      like a real tracker host would be. Reachable, so the "did it fetch?"
  //      assertion is about the browser's preload behaviour and never about
  //      DNS or the network.
  //   2. same-origin   — `/uploadz/` paths, which are what hosted uploads
  //      actually looks like in production (`PUBLIC_API_BASE_URL` is "" there,
  //      see k8s/new-ui/deployment.yaml). It must KEEP fetching metadata on
  //      mount; nothing leaks to a third party and the duration in the native
  //      controls is a real affordance.
  if (url.pathname === "/api/zpage/audio-preload-fixture/") {
    response.end(
      JSON.stringify({
        free2zaddr: "audio-preload-fixture",
        vanity: "audio-preload-fixture",
        p2paddr: "",
        title: "Audio preload fixture",
        description: "Rendered only by the focused browser regression.",
        content: [
          `::embed[http://127.0.0.1:${port}${THIRD_PARTY_AUDIO_PATH}]`,
          "",
          `::embed[http://127.0.0.1:${port}${THIRD_PARTY_VIDEO_PATH}]`,
          "",
          `::embed[${SAME_ORIGIN_AUDIO_PATH}]`,
          "",
          `::embed[${SAME_ORIGIN_VIDEO_PATH}]`,
          "",
        ].join("\n"),
        is_published: true,
        is_subscriber_only: false,
        total_raised: 0,
        total: "0",
        f2z_score: "0",
        is_verified: false,
        comments: [],
        creator: {
          username: "audio-preload-user",
          full_name: "Audio Preload User",
          avatar_image: {},
          member_price: null,
        },
        featured_image: {},
        created_at: "2026-08-16T00:00:00Z",
        updated_at: "2026-08-16T00:00:00Z",
        get_url: "/audio-preload-user/audio-preload-fixture",
        tags: [],
        source_language: "en",
        requested_language: "en",
        actual_language: "en",
        fallback_used: false,
        available_languages: ["en"],
        variant_is_published: true,
      }),
    );
    return;
  }

  const legacyCollisionFixtures = {
    "a-published-story": {
      creator: "storytime",
      vanity: "a-published-story",
      free2zaddr: "storytime-published-address",
    },
  };
  const legacyCollisionId = url.pathname.match(
    /^\/api\/zpage\/([^/]+)\/$/,
  )?.[1];
  const legacyCollision = legacyCollisionFixtures[legacyCollisionId];
  if (legacyCollision) {
    response.end(
      JSON.stringify({
        ...legacyCollision,
        p2paddr: "",
        title: "Legacy collision fixture",
        description: "Proves the historic redirect resolves the real page.",
        content: "Legacy collision fixture body.",
        is_published: true,
        is_subscriber_only: false,
        total_raised: 0,
        total: "0",
        f2z_score: "0",
        is_verified: false,
        comments: [],
        creator: {
          username: legacyCollision.creator,
          full_name: "Legacy Collision Owner",
          avatar_image: {},
          member_price: null,
        },
        featured_image: {},
        created_at: "2026-08-03T00:00:00Z",
        updated_at: "2026-08-03T00:00:00Z",
        get_url: `/${legacyCollision.creator}/zpage/${legacyCollision.free2zaddr}`,
        tags: [],
        source_language: "en",
        requested_language: "en",
        actual_language: "en",
        fallback_used: false,
        available_languages: ["en"],
        variant_is_published: true,
      }),
    );
    return;
  }

  // zPage fixture for same-origin embeds. Every first-party
  // `::embed[]` below must render natively with no consent card and no
  // Iframely request; the YouTube embed is the control proving the gate still
  // fires on the same page. The upload bytes are served (or refused) by the
  // spec's own `page.route`, not by this server.
  if (url.pathname === "/api/zpage/first-party-embed-fixture/") {
    response.end(
      JSON.stringify({
        free2zaddr: "first-party-embed-fixture",
        vanity: "first-party-embed-fixture",
        p2paddr: "",
        title: "First-party embed fixture",
        description: "Rendered only by the focused browser regression.",
        content: [
          "::embed[https://free2z.cash/uploadz/public/fp-embed-user/talk.mp4]",
          "",
          "::embed[https://free2z.cash/uploadz/public/fp-embed-user/episode.mp3]",
          "",
          "::embed[https://free2z.cash/uploadz/public/fp-embed-user/w-9.pdf]",
          "",
          "::embed[https://free2z.cash/uploadz/public/fp-embed-user/photo.png]",
          "",
          "::embed[https://free2z.cash/uploadz/fp-embed-user/members-only.png]",
          "",
          "::embed[https://free2z.cash/fp-embed-user/another-article]",
          "",
          "::embed[https://www.youtube.com/watch?v=dQw4w9WgXcQ]",
          "",
        ].join("\n"),
        is_published: true,
        is_subscriber_only: false,
        total_raised: 0,
        total: "0",
        f2z_score: "0",
        is_verified: false,
        comments: [],
        creator: {
          username: "fp-embed-user",
          full_name: "First Party Embed User",
          avatar_image: {},
          member_price: null,
        },
        featured_image: {},
        created_at: "2026-09-21T00:00:00Z",
        updated_at: "2026-09-21T00:00:00Z",
        get_url: "/fp-embed-user/first-party-embed-fixture",
        tags: [],
        source_language: "en",
        requested_language: "en",
        actual_language: "en",
        fallback_used: false,
        available_languages: ["en"],
        variant_is_published: true,
      }),
    );
    return;
  }

  // Tweet embed fixture for the consent/CSP browser regression. The
  // actual platform iframe is routed by the spec so its request, resize
  // message, and revocation lifecycle stay deterministic and local.
  if (url.pathname === "/api/zpage/tweet-embed-fixture/") {
    response.end(
      JSON.stringify({
        free2zaddr: "tweet-embed-fixture",
        vanity: "tweet-embed-fixture",
        p2paddr: "",
        title: "Tweet embed fixture",
        description: "Rendered only by the focused browser regression.",
        content:
          "::embed[https://x.com/tweetfixture/status/1234567890123456789]",
        is_published: true,
        is_subscriber_only: false,
        total_raised: 0,
        total: "0",
        f2z_score: "0",
        is_verified: false,
        comments: [],
        creator: {
          username: "tweet-embed-user",
          full_name: "Tweet Embed User",
          avatar_image: {},
          member_price: null,
        },
        featured_image: {},
        created_at: "2026-09-24T00:00:00Z",
        updated_at: "2026-09-24T00:00:00Z",
        get_url: "/tweet-embed-user/tweet-embed-fixture",
        tags: [],
        source_language: "en",
        requested_language: "en",
        actual_language: "en",
        fallback_used: false,
        available_languages: ["en"],
        variant_is_published: true,
      }),
    );
    return;
  }

  // First-party content CARDS ( part 2). The host articles embed other
  // zPages and converse threads; the embedded targets answer the way the real
  // API does for three kinds of reader, keyed on the session cookie that SSR
  // forwards (anonymous = no cookie). The gating RULE is the backend's and is
  // pinned against Postgres in test_first_party_embed_card_contract.py; here
  // it only has to depend on the cookie the SvelteKit loader forwards.
  {
    const cardCookie = request.headers.cookie || "";
    const cardReader = /sessionid=fp-card-owner\b/.test(cardCookie)
      ? "owner"
      : /sessionid=fp-card-subscriber\b/.test(cardCookie)
        ? "subscriber"
        : "public";
    const cardPage = (vanity, title, content, extra = {}) => ({
      free2zaddr: `${vanity}-addr`,
      vanity,
      p2paddr: "",
      title,
      description: "",
      content,
      is_published: true,
      is_subscriber_only: false,
      total_raised: 0,
      total: "0",
      f2z_score: "0",
      is_verified: false,
      comments: [],
      creator: {
        username: "fp-card-user",
        full_name: "First Party Card User",
        avatar_image: {},
        member_price: null,
      },
      featured_image: {},
      created_at: "2026-09-21T00:00:00Z",
      updated_at: "2026-09-21T00:00:00Z",
      get_url: `/fp-card-user/${vanity}`,
      tags: [],
      source_language: "en",
      requested_language: "en",
      actual_language: "en",
      fallback_used: false,
      available_languages: ["en"],
      variant_is_published: true,
      ...extra,
    });
    const E = (path) => `::embed[https://free2z.cash${path}]`;
    const CARD_COMMENT_PUBLIC = "0b7a3c1e-1111-4222-8333-944455556666";
    const CARD_COMMENT_GATED = "1c8b4d2f-2222-4333-8444-a55566667777";
    const hosts = {
      "fp-card-matrix": [
        "Intro paragraph.",
        E("/fp-card-user/fp-card-public"),
        E("/fp-card-user/fp-card-subonly"),
        E("/fp-card-user/fp-card-draft"),
        E(`/converse/${CARD_COMMENT_GATED}`),
      ],
      "fp-card-extra": [
        E(`/converse/${CARD_COMMENT_PUBLIC}`),
        // Lookalikes: the logout route (username `accounts`), an edit route,
        // another environment's host, a redirect route with `?next=`.
        E("/accounts/logout/?next=//evil.example"),
        E("/fp-card-user/fp-card-public/edit"),
        "::embed[https://stage.free2z.cash/fp-card-user/fp-card-public]",
        E("/login?next=//evil.example"),
      ],
      "fp-card-cap": Array.from({ length: 6 }, (_, i) =>
        E(`/fp-card-user/fp-card-cap-${i}`),
      ),
      "fp-card-self": ["Self intro.", E("/fp-card-user/fp-card-self")],
      "fp-card-a": ["A body.", E("/fp-card-user/fp-card-b")],
      //hosts whose COMMENTS carry the embeds (the body carries none).
      "fp-card-comments": ["Comments host body."],
      "fp-card-fanout": ["Fan-out host body."],
      "fp-card-rerender": ["Re-render host body."],
    };
    const zpageMatch = url.pathname.match(/^\/api\/zpage\/([^/]+)\/$/);
    const name = zpageMatch ? decodeURIComponent(zpageMatch[1]) : null;
    let body = null;
    if (name && hosts[name]) {
      body = cardPage(
        name,
        `Card host ${name}`,
        hosts[name].join("\n\n") + "\n",
      );
    } else if (name === "fp-card-public") {
      body = cardPage(name, "Public card title", "Public card **body** text.");
    } else if (name === "fp-card-subonly") {
      body =
        cardReader === "public"
          ? {
              show_modal: true,
              page: cardPage(
                name,
                "Members card title",
                "Subscribe for exclusive content",
                {
                  is_subscriber_only: true,
                },
              ),
            }
          : cardPage(name, "Members card title", "MEMBERS-ONLY-BODY", {
              is_subscriber_only: true,
            });
    } else if (name === "fp-card-draft") {
      body =
        cardReader === "owner"
          ? cardPage(name, "Draft card title", "DRAFT-ONLY-BODY", {
              is_published: false,
            })
          : null;
    } else if (name === "fp-card-slow") {
      // Answers late, so a card lands while other bodies are on screen.
      await new Promise((done) => setTimeout(done, 2_000));
      body = cardPage(name, "Slow card title", "Slow body.");
    } else if (name === "fp-card-shared") {
      body = cardPage(name, "Shared card title", "Shared body.");
    } else if (name && /^fp-card-fan-\d+$/.test(name)) {
      body = cardPage(name, `Fan card ${name.slice(12)}`, "Fan body.");
    } else if (name && /^fp-card-cap-\d$/.test(name)) {
      body = cardPage(name, `Cap card ${name.slice(-1)}`, "Cap body.");
    } else if (name === "fp-card-self") {
      body = cardPage(
        name,
        "Self card title",
        hosts["fp-card-self"].join("\n\n"),
      );
    } else if (name === "fp-card-b") {
      body = cardPage(
        name,
        "B card title",
        ["B body.", E("/fp-card-user/fp-card-a")].join("\n\n"),
      );
    } else if (name === "logout") {
      // Whoever owns a `logout` vanity must not lend it to `/accounts/logout`.
      body = cardPage(name, "Borrowed card title", "Not accounts' page.", {
        creator: {
          username: "someone-else",
          full_name: "",
          avatar_image: {},
          member_price: null,
        },
      });
    }
    if (name && (body || name.startsWith("fp-card-"))) {
      if (!body) {
        response.statusCode = 404;
        response.end(JSON.stringify({ detail: "Not found." }));
      } else {
        response.end(JSON.stringify(body));
      }
      return;
    }
    //the same targets embedded from comments, converse and a bio.
    // Every comment/post/bio here is AUTHORED BY the owner (who can open
    // everything); what renders must depend only on the VIEWER's cookie.
    const CARD_CONVERSE_ROOT = "2d9c5e30-3333-4444-8555-b66677778888";
    const cardComment = (uuid, content, extra = {}) => ({
      uuid,
      parent: null,
      headline: "",
      content,
      tuzis: 0,
      num_children: "0",
      tags: [],
      content_url: null,
      created_at: "2026-09-21T00:00:00Z",
      updated_at: "2026-09-21T00:00:00Z",
      author: { username: "fp-card-user", avatar_image: null },
      ...extra,
    });
    const commentUuid = (n) =>
      `3e0d6f41-4444-4555-8666-${String(n).padStart(12, "0")}`;
    const MATRIX_EMBEDS = [
      E("/fp-card-user/fp-card-public"),
      E("/fp-card-user/fp-card-subonly"),
      E("/fp-card-user/fp-card-draft"),
      E(`/converse/${CARD_COMMENT_GATED}`),
    ];
    const listOf = (results) => ({
      count: results.length,
      next: null,
      previous: null,
      results,
    });
    if (url.pathname === "/api/comments/zpage/fp-card-comments-addr/") {
      response.end(
        JSON.stringify(
          listOf(
            MATRIX_EMBEDS.map((embed, i) =>
              cardComment(commentUuid(i), `Comment ${i}.\n\n${embed}\n`),
            ),
          ),
        ),
      );
      return;
    }
    if (url.pathname === "/api/comments/zpage/fp-card-rerender-addr/") {
      // One body with media and no card; one whose card lands late.
      response.end(
        JSON.stringify(
          listOf([
            cardComment(
              commentUuid(700),
              "Video comment.\n\n::embed[https://free2z.cash/uploadz/public/fp-card-user/clip.mp4]\n",
            ),
            cardComment(
              commentUuid(701),
              `Slow comment.\n\n${E("/fp-card-user/fp-card-slow")}\n`,
            ),
            cardComment(
              commentUuid(702),
              `Quick comment.\n\n${E("/fp-card-user/fp-card-public")}\n`,
            ),
          ]),
        ),
      );
      return;
    }
    if (url.pathname === "/api/comments/zpage/fp-card-fanout-addr/") {
      // 30 comments × 3 embeds = 90 embeds: two shared by every comment, one
      // of its own. The page budget, not the comment count, bounds the calls.
      response.end(
        JSON.stringify(
          listOf(
            Array.from({ length: 30 }, (_, i) =>
              cardComment(
                commentUuid(100 + i),
                [
                  `Fan comment ${i}.`,
                  E("/fp-card-user/fp-card-public"),
                  E("/fp-card-user/fp-card-shared"),
                  E(`/fp-card-user/fp-card-fan-${i}`),
                ].join("\n\n") + "\n",
              ),
            ),
          ),
        ),
      );
      return;
    }
    if (url.pathname === `/api/comments/${CARD_CONVERSE_ROOT}/`) {
      // Server-rendered root: public + members. Its replies (browser-loaded)
      // carry the draft and the gated thread, and repeat the public page.
      response.end(
        JSON.stringify(
          cardComment(
            CARD_CONVERSE_ROOT,
            [
              "Converse root.",
              E("/fp-card-user/fp-card-public"),
              E("/fp-card-user/fp-card-subonly"),
            ].join("\n\n") + "\n",
            { headline: "Card converse root", num_children: "2" },
          ),
        ),
      );
      return;
    }
    if (url.pathname === `/api/comments/${CARD_CONVERSE_ROOT}/replies/`) {
      response.end(
        JSON.stringify(
          listOf([
            cardComment(
              commentUuid(900),
              ["Reply one.", E("/fp-card-user/fp-card-draft")].join("\n\n"),
              { parent: CARD_CONVERSE_ROOT },
            ),
            cardComment(
              commentUuid(901),
              [
                "Reply two.",
                E(`/converse/${CARD_COMMENT_GATED}`),
                E("/fp-card-user/fp-card-public"),
              ].join("\n\n"),
              { parent: CARD_CONVERSE_ROOT },
            ),
          ]),
        ),
      );
      return;
    }
    if (
      url.pathname === "/api/creator/fp-card-user/" ||
      url.pathname === "/api/creator/fp-card-user"
    ) {
      response.end(
        JSON.stringify({
          username: "fp-card-user",
          full_name: "First Party Card User",
          avatar_image: {},
          banner_image: {},
          member_price: null,
          description: [
            "---",
            "website: https://example.com",
            "---",
            "Bio intro.",
            "",
            ...MATRIX_EMBEDS.slice(0, 3).flatMap((embed) => [embed, ""]),
          ].join("\n"),
        }),
      );
      return;
    }
    const commentMatch = url.pathname.match(
      /^\/api\/comments\/([0-9a-f-]{36})\/$/,
    );
    if (commentMatch && commentMatch[1] === CARD_COMMENT_PUBLIC) {
      response.end(
        JSON.stringify({
          uuid: CARD_COMMENT_PUBLIC,
          headline: "Public thread headline",
          content: "Public thread body.",
          author: { username: "fp-card-commenter" },
          parent: null,
        }),
      );
      return;
    }
    if (commentMatch && commentMatch[1] === CARD_COMMENT_GATED) {
      if (cardReader === "public") {
        response.statusCode = 404;
        response.end(JSON.stringify({ detail: "Not found." }));
      } else {
        response.end(
          JSON.stringify({
            uuid: CARD_COMMENT_GATED,
            headline: "Members thread headline",
            content: "MEMBERS-THREAD-BODY",
            author: { username: "fp-card-commenter" },
            parent: null,
          }),
        );
      }
      return;
    }
  }

  // zPage fixture carrying a real third-party embed, for the one-time consent
  // scope regression. The embed host is never contacted: the consent
  // gate is what the test asserts on.
  if (url.pathname === "/api/zpage/embed-consent-fixture/") {
    response.end(
      JSON.stringify({
        free2zaddr: "embed-consent-fixture",
        vanity: "embed-consent-fixture",
        p2paddr: "",
        title: "Embed consent fixture",
        description: "Rendered only by the focused browser regression.",
        content: "::embed[https://www.youtube.com/watch?v=dQw4w9WgXcQ]\n",
        is_published: true,
        is_subscriber_only: false,
        total_raised: 0,
        total: "0",
        f2z_score: "0",
        is_verified: false,
        comments: [],
        creator: {
          username: "embed-consent-user",
          full_name: "Embed Consent User",
          avatar_image: {},
          member_price: null,
        },
        featured_image: {},
        created_at: "2026-08-03T00:00:00Z",
        updated_at: "2026-08-03T00:00:00Z",
        get_url: "/embed-consent-user/embed-consent-fixture",
        tags: [],
        source_language: "en",
        requested_language: "en",
        actual_language: "en",
        fallback_used: false,
        available_languages: ["en"],
        variant_is_published: true,
      }),
    );
    return;
  }

  // zPage fixture for the bottom-dock / Sonner geometry regression.
  if (url.pathname === "/api/zpage/toaster-fixture/") {
    response.end(
      JSON.stringify({
        free2zaddr: "toaster-fixture",
        vanity: "toaster-fixture",
        p2paddr: "",
        title: "Toaster dock fixture",
        description: "Rendered only by the focused browser regression.",
        content: "A short article keeps its page actions in the viewport.",
        is_published: true,
        is_subscriber_only: false,
        total_raised: 0,
        total: "0",
        f2z_score: "0",
        is_verified: false,
        comments: [],
        creator: {
          username: "toaster-fixture-user",
          full_name: "Toaster Fixture User",
          avatar_image: {},
          member_price: null,
        },
        featured_image: {},
        created_at: "2026-08-03T00:00:00Z",
        updated_at: "2026-08-03T00:00:00Z",
        get_url: "/toaster-fixture-user/toaster-fixture",
        tags: [],
        source_language: "en",
        requested_language: "en",
        actual_language: "en",
        fallback_used: false,
        available_languages: ["en"],
        variant_is_published: true,
      }),
    );
    return;
  }

  // --- published translations a reader has to be able to REACH  ------
  //
  // Two fixtures, and the thing that makes them worth having is that they
  // mirror the REAL backend's contract exactly: `?lang=` is matched as an
  // EXACT tag. `?lang=zh` on the first one gets English from the API, verified
  // against production -- so a spec that renders Chinese from `?lang=zh` is
  // proving the SvelteKit tier resolved the range and asked again, not that a
  // lenient mock was generous.
  const translatedFixture = url.pathname.match(
    /^\/api\/zpage\/(zh-variant-fixture|zh-scripts-fixture|regional-variant-fixture)\/$/,
  );
  if (translatedFixture) {
    const [, slug] = translatedFixture;
    const variants = {
      en: {
        title: "Fund Zcash Development Forever. Entitle Nobody.",
        content: "zh-fixture-english-body",
      },
      "zh-Hans": {
        title:
          "\u6c38\u8fdc\u8d44\u52a9Zcash\u5f00\u53d1\u3002\u4e0d\u8d4b\u4e88\u4efb\u4f55\u4eba\u7279\u6743\u3002",
        content: "zh-fixture-simplified-body",
      },
    };
    if (slug === "zh-scripts-fixture") {
      variants["zh-Hant"] = {
        title:
          "\u6c38\u9060\u8cc7\u52a9Zcash\u958b\u767c\u3002\u4e0d\u8ce6\u4e88\u4efb\u4f55\u4eba\u7279\u6b0a\u3002",
        content: "zh-fixture-traditional-body",
      };
    }
    // Source Spanish, and the only English text is REGIONAL: `?lang=en` matches
    // nothing here, so the reader route has to resolve the range to `en-US`.
    if (slug === "regional-variant-fixture") {
      delete variants.en;
      variants.es = {
        title: "Financiar el desarrollo de Zcash para siempre.",
        content: "regional-fixture-spanish-body",
      };
      variants["en-US"] = {
        title: "Fund Zcash Development Forever, y'all.",
        content: "regional-fixture-american-body",
      };
      delete variants["zh-Hans"];
    }
    // `getAll`-equivalent: the API reads the FIRST `lang`, like SvelteKit.
    const requested = url.searchParams.getAll("lang")[0] || "en";
    // The real API validates against the IANA registry, so a tag that is merely
    // well-formed is a 400 -- and a 400 over a `?lang=` must degrade to the
    // canonical view, never become a 500 on a shared link.
    if (/^(zz|qqq)(-|$)/i.test(requested)) {
      response.statusCode = 400;
      response.end(JSON.stringify({ lang: ["Unsupported language."] }));
      return;
    }
    // EXACT match only. This is the backend behaviour the range resolution
    // exists to work around; making the mock lenient would delete the test.
    const sourceLanguage = slug === "regional-variant-fixture" ? "es" : "en";
    const actual = Object.hasOwn(variants, requested)
      ? requested
      : sourceLanguage;
    const variant = variants[actual];
    response.end(
      JSON.stringify({
        free2zaddr: slug,
        vanity: slug,
        p2paddr: "",
        title: variant.title,
        description: "Rendered only by the focused browser regression.",
        content: variant.content,
        is_published: true,
        is_subscriber_only: false,
        total_raised: 0,
        total: "0",
        f2z_score: "0",
        is_verified: false,
        comments: [],
        creator: {
          username: "zh-fixture-user",
          full_name: "ZH Fixture User",
          avatar_image: {},
          member_price: null,
        },
        featured_image: {},
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
        get_url: `/zh-fixture-user/${slug}`,
        tags: [],
        source_language: slug === "regional-variant-fixture" ? "es" : "en",
        requested_language: requested,
        actual_language: actual,
        fallback_used: actual !== requested,
        available_languages: Object.keys(variants),
        variant_is_published: true,
      }),
    );
    return;
  }

  // --- direction, bidi and script fixtures  --------------------------
  //
  // We sell `ar`/`he`/`fa`/`ur` today and the content container had no `dir`.
  // `az-Arab` / `az-Latn` are here because they are the case a language list
  // gets wrong: same language, opposite directions. `und` is here because
  // "unknown" has to stay unknown rather than being asserted left-to-right.
  const bidiFixture = url.pathname.match(
    /^\/api\/zpage\/(bidi-fixture|bidi-und-fixture)\/$/,
  );
  if (bidiFixture) {
    const [, slug] = bidiFixture;
    // Sentence-final punctuation is the whole point of the Arabic and Hebrew
    // rows: in an LTR container it renders at the RIGHT end of the line, which
    // is where the spec measures it.
    const variants = {
      en: {
        title: "Hello world!",
        content: "First paragraph.\n\nbidi-fixture-english-body",
      },
      ar: {
        title:
          "\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645!",
        content:
          "\u0647\u0630\u0627 \u0646\u0635 \u0639\u0631\u0628\u064a \u0637\u0648\u064a\u0644 \u0644\u0644\u0627\u062e\u062a\u0628\u0627\u0631." +
          "\n\nbidi-fixture-arabic-body" +
          // Program text inside an RTL article: it must NOT inherit the
          // article's direction, or the semicolon renders on the left.
          "\n\n```js\nconst total = 1;\n```" +
          //...and mathematics, for the same reason: KaTeX lays an expression
          // out as a row of inline-block groups and declares no direction of
          // its own, so it reverses under an inherited RTL.
          "\n\n$$a + b = c$$" +
          //...and an external embed, whose consent card is PRODUCT chrome
          // mounted inside the article body.
          "\n\n::embed[https://www.youtube.com/watch?v=dQw4w9WgXcQ]\n",
      },
      he: {
        title: "\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd!",
        content: "bidi-fixture-hebrew-body",
      },
      // Same language, opposite directions -- decided by the script subtag.
      "az-Arab": {
        title: "\u0633\u0627\u0644\u0627\u0645 \u062f\u0648\u0646\u06cc\u0627!",
        content: "bidi-fixture-azerbaijani-arabic-body",
      },
      "az-Latn": {
        title: "Salam dunya!",
        content: "bidi-fixture-azerbaijani-latin-body",
      },
      // No inter-word spaces: the line-breaking guard reads this one.
      th: {
        title: "\u0e1b\u0e23\u0e30\u0e40\u0e17\u0e28\u0e44\u0e17\u0e22",
        content:
          "\u0e1b\u0e23\u0e30\u0e40\u0e17\u0e28\u0e44\u0e17\u0e22\u0e40\u0e1b\u0e47\u0e19\u0e1b\u0e23\u0e30\u0e40\u0e17\u0e28\u0e17\u0e35\u0e48\u0e21\u0e35\u0e1b\u0e23\u0e30\u0e27\u0e31\u0e15\u0e34\u0e28\u0e32\u0e2a\u0e15\u0e23\u0e4c\u0e22\u0e32\u0e27\u0e19\u0e32\u0e19\u0e41\u0e25\u0e30\u0e21\u0e35\u0e27\u0e31\u0e12\u0e19\u0e18\u0e23\u0e23\u0e21\u0e17\u0e35\u0e48\u0e2b\u0e25\u0e32\u0e01\u0e2b\u0e25\u0e32\u0e22" +
          "\n\nbidi-fixture-thai-body",
      },
      km: {
        title: "\u1794\u17d2\u179a\u1791\u17c1\u179f\u1780\u1798\u17d2\u1796",
        content:
          "\u1794\u17d2\u179a\u1791\u17c1\u179f\u1780\u1798\u17d2\u1796\u17bb\u1787\u17b6\u1798\u17b6\u1793\u1794\u17d2\u179a\u179c\u178f\u17d2\u178f\u17b7\u179f\u17b6\u179f\u17d2\u178f\u17d2\u179a\u1799\u17bc\u179a\u179b\u1784\u17cb\u178e\u17b6\u179f\u17cb\u17a0\u17be\u1799\u1798\u17b6\u1793\u179c\u1794\u17d2\u1794\u1792\u1798\u17cc\u1785\u1798\u17d2\u179a\u17bb\u17c7\u1793\u17b7\u1784\u179f\u1798\u17d2\u1794\u17bc\u179a\u1794\u17c2\u1794\u1799\u17c9\u17b6\u1784\u1781\u17d2\u179b\u17b6\u17c6\u1784\n\nbidi-fixture-khmer-body",
      },
      // Han is unified: these two share code points and print them
      // differently, which is what the font-selection assertions read.
      "zh-Hant": {
        title: "\u9aa8\u76f4\u4ee4\u9ad8\u9752",
        content: "bidi-fixture-traditional-body",
      },
      // An explicit script with a region that disagrees with it. CSS `:lang()`
      // does extended matching, so this tag matches `:lang(zh-HK)` too.
      "zh-Hans-HK": {
        title: "\u9aa8\u76f4\u4ee4\u9ad8\u9752",
        content: "bidi-fixture-simplified-hk-body",
      },
      ja: {
        title: "\u9aa8\u76f4\u4ee4\u9ad8\u9752",
        content: "bidi-fixture-japanese-body",
      },
    };
    const requested = url.searchParams.getAll("lang")[0] || "en";
    const actual = Object.hasOwn(variants, requested) ? requested : "en";
    // The unknown-language fixture serves HEBREW text, and that is load-bearing
    //. It used to serve English, which made `dir="auto"` and an omitted
    // `dir` render identically on it — so a spec could not tell the two policies
    // apart. An unlabelled article whose text runs right-to-left is the case that
    // distinguishes them, and it is the bug `auto` exists to fix: omission
    // inherits the chrome's left-to-right and lays the Hebrew out backwards.
    const variant =
      slug === "bidi-und-fixture" ? variants.he : variants[actual];
    response.end(
      JSON.stringify({
        free2zaddr: slug,
        vanity: slug,
        p2paddr: "",
        title: variant.title,
        description: variant.title,
        content: variant.content,
        is_published: true,
        is_subscriber_only: false,
        total_raised: 0,
        total: "0",
        f2z_score: "0",
        is_verified: false,
        comments: [],
        creator: {
          // A display name in an RTL script, sitting in LTR chrome: what the
          // `<bdi>` boundaries exist for.
          username: "bidi-fixture-user",
          full_name: "\u0645\u0631\u062d\u0628\u0627!",
          avatar_image: {},
          member_price: null,
        },
        featured_image: {},
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
        get_url: `/bidi-fixture-user/${slug}`,
        // One tag in each direction, so the isolation markup is exercised.
        tags: ["\u0639\u0631\u0628\u064a", "zcash"],
        source_language: "en",
        requested_language: requested,
        // The `und` fixture is the "we do not know" case: the route must omit
        // `dir` entirely rather than assert left-to-right.
        actual_language: slug === "bidi-und-fixture" ? "und" : actual,
        fallback_used: actual !== requested,
        available_languages:
          slug === "bidi-und-fixture" ? ["und"] : Object.keys(variants),
        variant_is_published: true,
      }),
    );
    return;
  }

  // --- an article whose text runs right-to-left  ---------------------
  //
  // MIXED on purpose, and every line of the body earns its place:
  //
  //   * `أول Zcash آخر` is the ordering assertion. Between a right-to-left base
  //     and a left-to-right one, the LEFT-TO-RIGHT SCREEN ORDER of those three
  //     tokens inverts — RTL puts `أول` rightmost, LTR puts it leftmost — so a
  //     spec measuring their x coordinates distinguishes the two
  //     implementations rather than merely observing that Arabic renders.
  //   * a bare URL, an inline code span and a fenced block are the three things
  //     that must stay left-to-right INSIDE that Arabic prose, which is why a
  //     blanket `dir` on the container is not the fix.
  //   * pure-Arabic content would pass under `dir="auto"`, which gets this body
  //     wrong. That is the point of using this one.
  const rtlFixture = url.pathname.match(
    /^\/api\/zpage\/(rtl-direction-fixture|rtl-direction-light-fixture)\/$/,
  );
  if (rtlFixture) {
    const [, slug] = rtlFixture;
    // TWO fixtures, and the split is about SSR COST rather than coverage.
    //
    // The heavy body renders highlight.js, KaTeX and an autolink on every request,
    // and one zPage render is three backend calls — so a spec file that navigates
    // to it eight times issues ~24 backend requests, and a burst like that is what
    // saturates SSR here rather than SSR being slow. Only two assertions in
    // `article-direction.spec.ts` are ABOUT code and math; the rest are about
    // prose direction, the chrome and bidi ordering, and those take the light
    // body.
    //
    // The light body is the heavy body's FIRST PARAGRAPH, so the three tokens the
    // ordering assertion measures are identical in both and the cheap tests pay
    // nothing for constructs they make no claim about.
    const light = slug === "rtl-direction-light-fixture";
    const firstParagraph = (heavy) => (light ? heavy.split("\n\n")[0] : heavy);
    const arabicBody = [
      "أول Zcash آخر",
      "",
      "اقرأ https://example.com/a?b=1&c=2 هنا",
      "",
      "العلامة `--flag=value` و `2Z`",
      "",
      // Rendered math, which KaTeX lays out as nested inline-BLOCK groups with
      // no `direction` of its own — so under an RTL base those atomic boxes
      // reorder and the equation on screen is a different equation.
      "المعادلة $$a = b + c$$ هنا",
      "",
      "```sh",
      "npm run build && echo done",
      "```",
    ].join("\n");
    const variants = {
      en: {
        title: "Fund Zcash Development Forever. Entitle Nobody.",
        description: "An English subtitle.",
        content: firstParagraph(
          "First Zcash last\n\nRead https://example.com/a?b=1&c=2 here",
        ),
      },
      ar: {
        // "Fund Zcash development forever." in Arabic — Latin "Zcash" inside it.
        title: "تمويل تطوير Zcash إلى الأبد",
        description: "عنوان فرعي بالعربية",
        content: firstParagraph(arabicBody),
      },
      he: {
        title: "ממן את פיתוח Zcash",
        description: "כתורת משנה",
        content: firstParagraph(arabicBody),
      },
      // The variant that tells a LANGUAGE-DERIVED direction apart from
      // `dir="auto"`, and the reason `auto` is not the fix. Its Farsi title and
      // body both OPEN with a Latin run — "Zcash", exactly as a real article
      // about this product does — so first-strong-character detection reads the
      // whole thing as left-to-right and lays out Farsi prose LTR, left-aligned,
      // with its trailing punctuation misplaced. The language tag knows better.
      //
      // Without this fixture the suite passes under `dir="auto"`: the Arabic
      // variant above opens with `أول`, which `auto` happens to get right.
      fa: {
        title: "Zcash برای همیشه",
        description: "Zcash زیرعنوان",
        content: firstParagraph(
          [
            "Zcash اول آخر",
            "",
            "```sh",
            "npm run build && echo done",
            "```",
          ].join("\n"),
        ),
      },
    };
    // EXACT tag, exactly as the real API and the  fixtures above.
    const requested = url.searchParams.getAll("lang")[0] || "en";
    const actual = Object.hasOwn(variants, requested) ? requested : "en";
    const variant = variants[actual];
    response.end(
      JSON.stringify({
        free2zaddr: slug,
        vanity: slug,
        p2paddr: "",
        title: variant.title,
        description: variant.description,
        content: variant.content,
        is_published: true,
        is_subscriber_only: false,
        total_raised: 0,
        total: "0",
        f2z_score: "0",
        is_verified: false,
        comments: [],
        creator: {
          username: "rtl-fixture-user",
          full_name: "RTL Fixture User",
          avatar_image: {},
          member_price: null,
        },
        featured_image: {},
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
        get_url: `/rtl-fixture-user/${slug}`,
        tags: [],
        source_language: "en",
        requested_language: requested,
        actual_language: actual,
        fallback_used: actual !== requested,
        available_languages: Object.keys(variants),
        variant_is_published: true,
      }),
    );
    return;
  }
  // zPage fixture for the server-rendered article body. The content
  // deliberately exercises every construct MarkdownContent enhances after
  // hydration — heading, table, highlighted code, mermaid, QR code, image,
  // third-party embed — so the spec can prove the prose is in the SSR markup
  // AND that each client-side enhancement still runs over it.
  const enrichmentArticle = url.pathname.match(
    /^\/api\/zpage\/(ssr-enrichment-(?:related-headers|series-body|success))\/$/,
  );
  const enrichmentRequest = url.pathname.match(
    /^\/api\/(?:g12f\/)?zpage\/(ssr-enrichment-(?:related-headers|series-body|success))\/(related|series)\/$/,
  );
  if (enrichmentRequest) {
    const [, id, kind] = enrichmentRequest;
    if (id === `ssr-enrichment-${kind}-headers`) {
      const state = { started: true, closed: false };
      ssrEnrichmentStallState.set(id, state);
      response.on("close", () => {
        state.closed = true;
      });
      return;
    }
    if (id === `ssr-enrichment-${kind}-body`) {
      const state = { started: true, closed: false };
      ssrEnrichmentStallState.set(id, state);
      response.on("close", () => {
        state.closed = true;
      });
      response.write("{");
      return;
    }
    const page = {
      free2zaddr: id,
      vanity: id,
      title: "Related enrichment sentinel",
      creator: { username: "ssr-body-user" },
    };
    response.end(
      JSON.stringify(
        kind === "related"
          ? [page]
          : {
              id: "series-fixture",
              name: "Series enrichment sentinel",
              pageorder_set: [{ page, order: 0 }],
            },
      ),
    );
    return;
  }
  //no article owns this vanity, so the classic `/creator/<username>`
  // profile link falls back to the profile (vanity first, then profile).
  if (url.pathname === "/api/zpage/creator-legacy-profile-fixture/") {
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: "Not found." }));
    return;
  }
  if (url.pathname === "/api/zpage/ssr-body-fixture/" || enrichmentArticle) {
    response.end(
      JSON.stringify({
        free2zaddr: enrichmentArticle?.[1] || "ssr-body-fixture",
        vanity: enrichmentArticle?.[1] || "ssr-body-fixture",
        p2paddr: "",
        title: "Server-rendered body fixture",
        description: "Rendered only by the focused browser regression.",
        content: enrichmentArticle
          ? "# Core article sentinel\n\nComplete article tail sentinel."
          : SSR_BODY_FIXTURE_CONTENT,
        is_published: true,
        is_subscriber_only: false,
        total_raised: 0,
        total: "0",
        f2z_score: "0",
        is_verified: false,
        comments: [],
        creator: {
          username: "ssr-body-user",
          full_name: "SSR Body User",
          avatar_image: {},
          member_price: null,
        },
        featured_image: {},
        created_at: "2026-08-08T00:00:00Z",
        updated_at: "2026-08-08T00:00:00Z",
        get_url: "/ssr-body-user/ssr-body-fixture",
        tags: [],
        source_language: "en",
        requested_language: "en",
        actual_language: "en",
        fallback_used: false,
        available_languages: ["en"],
        variant_is_published: true,
      }),
    );
    return;
  }

  if (url.pathname === "/api/zpage/markdown-image-lightbox-fixture/") {
    response.end(
      JSON.stringify({
        free2zaddr: "markdown-image-lightbox-fixture",
        vanity: "markdown-image-lightbox-fixture",
        p2paddr: "",
        title: "Markdown image lightbox fixture",
        description: "Focused browser fixture for Markdown image enhancement.",
        content: MARKDOWN_IMAGE_LIGHTBOX_FIXTURE_CONTENT,
        is_published: true,
        is_subscriber_only: false,
        total_raised: 0,
        total: "0",
        f2z_score: "0",
        is_verified: false,
        comments: [],
        creator: {
          username: "lightbox-user",
          full_name: "Lightbox Fixture User",
          avatar_image: {},
          member_price: null,
        },
        featured_image: {},
        created_at: "2026-08-30T00:00:00Z",
        updated_at: "2026-08-30T00:00:00Z",
        get_url: "/lightbox-user/markdown-image-lightbox-fixture",
        tags: [],
        source_language: "en",
        requested_language: "en",
        actual_language: "en",
        fallback_used: false,
        available_languages: ["en"],
        variant_is_published: true,
      }),
    );
    return;
  }

  // An article past the SSR cost ceilings (nesting depth, here). The snapshot
  // is skipped, so this is the branch where the body is built client-side —
  // exactly the pre- path. It has to still render perfectly for a human.
  if (url.pathname === "/api/zpage/ssr-overcap-fixture/") {
    response.end(
      JSON.stringify({
        free2zaddr: "ssr-overcap-fixture",
        vanity: "ssr-overcap-fixture",
        p2paddr: "",
        title: "Over-ceiling body fixture",
        description: "Too deeply nested to server-render.",
        content: SSR_OVERCAP_FIXTURE_CONTENT,
        is_published: true,
        is_subscriber_only: false,
        total_raised: 0,
        total: "0",
        f2z_score: "0",
        is_verified: false,
        comments: [],
        creator: {
          username: "ssr-body-user",
          full_name: "SSR Body User",
          avatar_image: {},
          member_price: null,
        },
        featured_image: {},
        created_at: "2026-08-08T00:00:00Z",
        updated_at: "2026-08-08T00:00:00Z",
        get_url: "/ssr-body-user/ssr-overcap-fixture",
        tags: [],
        source_language: "en",
        requested_language: "en",
        actual_language: "en",
        fallback_used: false,
        available_languages: ["en"],
        variant_is_published: true,
      }),
    );
    return;
  }

  if (
    url.pathname === "/api/tuzis/my-subscriptions" &&
    request.method === "GET" &&
    isBillingSession
  ) {
    const results = billingFixtureSubscriptions.map((row) => ({
      fan: { username: BILLING_FIXTURE_USER, is_active: true },
      star: {
        username: row.username,
        member_price: row.memberPrice,
        is_active: !row.inactive,
        ...(row.inactive
          ? { p2paddr: "", full_name: "", avatar_image: null }
          : {}),
      },
      max_price: row.maxPrice,
      expires: row.expired ? isoDaysFromNow(-2) : isoDaysFromNow(31),
    }));
    response.end(
      JSON.stringify({
        count: results.length,
        next: null,
        previous: null,
        results,
      }),
    );
    return;
  }

  const subscriptionMatch = url.pathname.match(
    /^\/api\/tuzis\/subscribe\/([^/]+)$/,
  );
  if (
    subscriptionMatch &&
    (request.method === "PATCH" || request.method === "DELETE") &&
    isBillingFixture
  ) {
    if (
      request.headers.origin !== trustedAppOrigin ||
      request.headers["x-csrftoken"] !== BILLING_FIXTURE_CSRF ||
      !(request.headers.cookie || "").includes(
        `csrftoken=${BILLING_FIXTURE_CSRF}`,
      )
    ) {
      response.statusCode = 403;
      response.end(JSON.stringify({ detail: "CSRF Failed" }));
      return;
    }

    const username = decodeURIComponent(subscriptionMatch[1]);
    const row = billingFixtureSubscriptions.find(
      (candidate) => candidate.username === username,
    );
    const body = await readJson(request);
    if (request.method === "DELETE") {
      // CreatorSubscribeView.delete: max_price -> 0, no `is_active` gate --
      // the one control a deactivated creator's row must keep.
      if (!row) {
        response.statusCode = 404;
        response.end(JSON.stringify({ detail: "Not found." }));
        return;
      }
      row.maxPrice = "0";
      response.end(JSON.stringify("OK"));
      return;
    }
    if (!row || !/^\d+$/.test(String(body.max_price || ""))) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Invalid maximum" }));
      return;
    }
    row.maxPrice = String(body.max_price);
    response.end(
      JSON.stringify({
        fan: { username: BILLING_FIXTURE_USER },
        star: { username: row.username, member_price: row.memberPrice },
        max_price: row.maxPrice,
        expires: row.expired ? isoDaysFromNow(-2) : isoDaysFromNow(31),
      }),
    );
    return;
  }

  if (
    url.pathname === "/api/tuzis/my-subscriptions-summary" &&
    isBillingSession
  ) {
    if (isBillingUnknown) {
      response.statusCode = 503;
      response.end(JSON.stringify({ detail: "summary unavailable" }));
      return;
    }

    if (billingFixtureRenewalSummary !== null) {
      response.end(JSON.stringify(billingFixtureRenewalSummary));
      return;
    }

    const summary = isBillingEmpty
      ? {
          status: "none",
          balance: "100000.000",
          total_upcoming: "0.000",
          shortfall: "0.000",
          next_renewal: null,
          horizon_days: 29,
        }
      : isBillingShortfall
        ? {
            // A FRACTIONAL deficit on purpose. `tuzis` carries three decimals
            // while `member_price` is whole, so this is the ordinary shape of
            // a shortfall — and truncating it (43.5 -> "43") understates what
            // the fan must add. The banner has to say 44.
            status: "shortfall",
            balance: "20.500",
            total_upcoming: "64.000",
            shortfall: "43.500",
            next_renewal: isoDaysFromNow(31),
            horizon_days: 29,
          }
        : {
            // Unpriced and over-ceiling rows are not chargeable next renewals;
            // the three eligible fixture rows total 10 + 4 + 50 = 64.
            status: "ok",
            balance: "100000.000",
            total_upcoming: "64.000",
            shortfall: "0.000",
            next_renewal: isoDaysFromNow(31),
            horizon_days: 29,
          };
    response.end(JSON.stringify(summary));
    return;
  }

  if (url.pathname === "/api/tuzis/my-subscribers" && isBillingSession) {
    const results = BILLING_FIXTURE_SUBSCRIBERS.map((row) => ({
      fan: {
        username: row.username,
        is_active: !row.inactive,
        ...(row.inactive
          ? {
              p2paddr: "",
              full_name: "",
              avatar_image: null,
              member_price: null,
            }
          : {}),
      },
      // Same serializer as my-subscriptions: `star` is the caller, so the
      // caller's own price is what each fan's ceiling is measured against.
      star: {
        username: BILLING_FIXTURE_USER,
        member_price: BILLING_FIXTURE_CREATOR_PRICE,
      },
      max_price: row.maxPrice,
      expires: isoDaysFromNow(31),
    }));
    response.end(
      JSON.stringify({
        count: results.length,
        next: null,
        previous: null,
        results,
      }),
    );
    return;
  }

  if (
    url.pathname === "/api/zpage/" &&
    isZPageDeleteFixture &&
    url.searchParams.get("mine") === "true"
  ) {
    const allResults = zpageDeleteFixtureRows();
    const requestedPage = Number(url.searchParams.get("page") || "1");
    const results =
      zpageDeleteFixtureMode === "page2"
        ? allResults.slice((requestedPage - 1) * 12, requestedPage * 12)
        : allResults;
    response.end(
      JSON.stringify({
        count: allResults.length,
        next: null,
        previous: null,
        published_count: allResults.filter((page) => page.is_published).length,
        draft_count: allResults.filter((page) => !page.is_published).length,
        results,
      }),
    );
    return;
  }

  if (
    url.pathname === "/api/zpage/" &&
    profileFixture &&
    url.searchParams.get("mine") === "true"
  ) {
    // Exactly what DRF sends: one PAGE_SIZE=12 page of `results`, plus the
    // whole-queryset totals injected by zPageListPagination. Counting
    // `results` instead of reading these caps every stat at 12.
    response.end(
      JSON.stringify({
        count: PROFILE_FIXTURE_PUBLISHED_COUNT + PROFILE_FIXTURE_DRAFT_COUNT,
        next: null,
        previous: null,
        published_count: PROFILE_FIXTURE_PUBLISHED_COUNT,
        draft_count: PROFILE_FIXTURE_DRAFT_COUNT,
        results: profileFixturePages(
          profileFixture.mix,
          profileFixture.username,
        ),
      }),
    );
    return;
  }

  if (
    url.pathname === "/api/zpage/" &&
    url.searchParams.get("username")?.toLowerCase() === TAG_FILTER_FIXTURE_USER
  ) {
    const results = profileFixturePages("published", TAG_FILTER_FIXTURE_USER);
    response.end(
      JSON.stringify({
        count: results.length,
        next: null,
        previous: null,
        results,
      }),
    );
    return;
  }

  if (
    url.pathname === "/api/zpage/" &&
    url.searchParams.get("homeSort") === "updated"
  ) {
    response.end(
      JSON.stringify({
        next: `${url.origin}/api/zpage/?homeSort=updated&pagination=cursor&cursor=browser-test`,
        previous: null,
        results: [],
      }),
    );
    return;
  }

  if (
    url.pathname === "/api/zpage/" &&
    isBillingSession &&
    ["score", "popular"].includes(url.searchParams.get("homeSort") || "")
  ) {
    response.end(
      JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [AUTHENTICATED_HOMEPAGE_DRAFT],
      }),
    );
    return;
  }

  // The Converse stream, page one. `/converse` is server-rendered
  // now: `converse/+page.server.ts` fetches the unfiltered cursor stream from
  // THIS server, so a `page.route()` in the spec cannot answer it. Serve the
  // same five posts the spec's browser-side route serves for every later
  // request (filters, load-more, a reload after a revoked session) -- one
  // shared module, so the two halves cannot drift apart.
  if (url.pathname === "/__test/converse-deadline") {
    response.end(JSON.stringify(converseDeadlineState));
    return;
  }
  if (
    url.pathname === "/api/comments/" &&
    request.method === "GET" &&
    (request.headers.cookie || "").includes("fp-card-stream=1")
  ) {
    //a browser-loaded stream (no server seed) whose posts embed 20
    // distinct first-party pages — more than one page view's budget.
    const E = (path) => `::embed[https://free2z.cash${path}]`;
    response.end(
      JSON.stringify({
        next: null,
        previous: null,
        results: Array.from({ length: 20 }, (_, i) => ({
          uuid: `4f1e7052-5555-4666-8777-${String(i).padStart(12, "0")}`,
          parent: null,
          headline: "",
          content: `Stream post ${i}.\n\n${E(`/fp-card-user/fp-card-fan-${i}`)}\n`,
          tuzis: 0,
          num_children: "0",
          tags: [],
          content_url: null,
          created_at: "2026-09-21T00:00:00Z",
          updated_at: "2026-09-21T00:00:00Z",
          author: { username: "fp-card-user", avatar_image: null },
        })),
      }),
    );
    return;
  }
  if (url.pathname === "/api/comments/" && request.method === "GET") {
    if ((request.headers.cookie || "").includes("converse-deadline=body")) {
      converseDeadlineState.started = true;
      converseDeadlineState.closed = false;
      response.on("close", () => {
        converseDeadlineState.closed = true;
      });
      response.write("{");
      // Deliberately never finish: only consumer cancellation closes this body.
      return;
    }
    const payload = converseStreamPageOne();
    if (
      (request.headers.cookie || "").includes("sessionid=alice-ssr-session")
    ) {
      payload.results = [
        {
          ...payload.results[0],
          content: "ALICE-PRIVATE-SSR-SENTINEL",
          headline: "Alice private draft discussion",
        },
      ];
      payload.count = 1;
    }
    response.end(JSON.stringify(payload));
    return;
  }

  // Converse thread fixtures for the title-derivation regression.
  // `/converse/<uuid>` is server-rendered, so its loader fetches THIS server —
  // a page.route() in the spec cannot see that request.
  //
  //   - `converse-titled-fixture`  a historic post with a real headline, which
  //     must still be what the browser tab and og:title say;
  //   - `converse-untitled-fixture` a post written since the composer stopped
  //     asking for one, which must be named after its opening line rather than
  //     the literal word "Conversation".
  const converseFixture = url.pathname.match(
    /^\/api\/comments\/(converse-(?:un)?titled-fixture)\/$/,
  );
  if (converseFixture) {
    const untitled = converseFixture[1] === "converse-untitled-fixture";
    response.end(
      JSON.stringify({
        uuid: converseFixture[1],
        parent: null,
        headline: untitled ? "" : "Shielded notes from 2023",
        content: untitled
          ? "the shielded pool is bigger than it was last month\n\nand nobody is talking about it"
          : "a post from back when the composer asked for a title",
        tuzis: 3,
        num_children: "0",
        tags: [],
        content_url: null,
        created_at: "2026-08-20T12:00:00Z",
        updated_at: "2026-08-20T12:00:00Z",
        author: { username: "converse-fixture", avatar_image: null },
      }),
    );
    return;
  }

  // The language catalog. The editor fetches it on open. Without a
  // handler the request falls through to the `{count: 0, results: []}` default
  // below, which the client correctly reads as a failure and answers from the
  // compiled-in seed — so every spec would pass while the served path went
  // entirely unexercised. Serving exactly the seed set keeps the picker's
  // contents identical to what they were before the endpoint existed, so this
  // exercises the new code path without moving any existing assertion.
  if (url.pathname === "/api/languages/") {
    const locale = url.searchParams.get("locale") || "en";
    const named = (tag) => {
      try {
        return (
          new Intl.DisplayNames([locale, "en"], {
            type: "language",
            fallback: "none",
          }).of(tag) || tag
        );
      } catch {
        return tag;
      }
    };
    response.setHeader("ETag", '"mock-language-catalog"');
    response.end(
      JSON.stringify({
        locale,
        languages: TRANSLATABLE_LANGUAGES.map((tag) => ({
          tag,
          name: named(tag),
          autonym: named(tag),
          script: null,
          direction: "ltr",
          translatable: true,
        })),
      }),
    );
    return;
  }

  if (
    url.pathname === "/api/events/" &&
    url.searchParams.get("recovery") === "payments"
  ) {
    response.end(
      JSON.stringify({
        count: 0,
        results: [],
        next: null,
        recovery_boundary: "mock-empty-receipt-scan",
      }),
    );
    return;
  }

  if (url.pathname === "/api/events/unread_count/") {
    // Keep both endpoint shapes faithful: existing clients receive a number,
    // while the Svelte store opts into the ownership envelope so a late
    // response cannot move another account's badge.
    const cookie = request.headers.cookie || "";
    const cardSession = cookie.match(
      /sessionid=(fp-card-(?:owner|subscriber|stranger))\b/,
    )?.[1];
    let recipient = null;
    if (isZPageDeleteFixture) recipient = ZPAGE_DELETE_FIXTURE_USER;
    else if (isCursorFixtureSession) recipient = CURSOR_FIXTURE_USER;
    else if (isStreamAudienceFixture) recipient = STREAM_AUDIENCE_FIXTURE_USER;
    else if (profileFixture) recipient = profileFixture.username;
    else if (isBillingSession) recipient = BILLING_FIXTURE_USER;
    else if (isBoostFixtureSession) recipient = BOOST_FIXTURE_USER;
    else if (isRawWriteFixtureSession) recipient = RAW_WRITE_FIXTURE_USER;
    else if (isReportBlockFixtureSession) recipient = REPORT_BLOCK_FIXTURE_USER;
    else if (isResetPasswordSuccessSession)
      recipient = RESET_PASSWORD_SUCCESS_USER;
    else if (cardSession) recipient = FP_CARD_USERS[cardSession].username;
    if (!recipient) {
      response.statusCode = 401;
      response.end(JSON.stringify({ detail: "Not authenticated" }));
      return;
    }
    response.end(
      JSON.stringify(
        url.searchParams.get("include_recipient") === "1"
          ? { unread_count: 0, recipient_username: recipient }
          : 0,
      ),
    );
    return;
  }

  response.end(JSON.stringify({ count: 0, results: [] }));
});

// A port taken out from under us is the one failure here that has to explain
// itself, because the run that hits it is usually another agent's, in another
// worktree, and the symptom (refused connections from every spec) reads as a
// broken branch. Name the port, name the likely cause, and give the way out --
// never a bare EADDRINUSE stack.
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      [
        `mock-api: port ${port} is already in use on 127.0.0.1.`,
        ``,
        `Another agent's browser run on this machine may have taken it between`,
        `the config's free-port check and this bind. Re-running usually picks a`,
        `different pair; if you set PLAYWRIGHT_MOCK_API_PORT, unset it and let`,
        `the suite derive a pair from this worktree's path, or choose another:`,
        `  PLAYWRIGHT_APP_PORT=<n> PLAYWRIGHT_MOCK_API_PORT=<n+1> npm run test:browser`,
        `To see the holder: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
        ``,
        `Do NOT run \`pkill -f playwright\` or \`pkill -f node\`: those patterns`,
        `are machine-wide, not worktree-scoped, and kill every other agent's`,
        `browser run. Their specs then fail in ways indistinguishable from a`,
        `regression on their branch. See #1920.`,
      ].join("\n"),
    );
    process.exit(2);
  }
  throw error;
});

server.listen(port, "127.0.0.1");

function close() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
