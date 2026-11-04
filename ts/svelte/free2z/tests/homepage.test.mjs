import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  cacheAnonymousHomepage,
  createDegradedHomepageData,
  createHomepageUpstreamSignal,
  createTtlCache,
  createPublicApiOptions,
  hasUsableHomepageData,
  isLikelyMobileUserAgent,
  oneWeekAgo,
  pickHeroStory,
  resolveLatestFeed,
} from "../src/lib/server/homepage.js";
import {
  LIVE_DISCOVERY_LIMIT,
  createLiveDiscoveryOptions,
  liveStatusFromStreams,
  liveStreamsForCreator,
  resolveLiveDiscovery,
} from "../src/lib/live-discovery.js";

const img = { url: "/uploadz/a.png" };
const pageServerSource = readFileSync(
  new URL("../src/routes/+page.server.ts", import.meta.url),
  "utf8",
);
const layoutSource = readFileSync(
  new URL("../src/routes/+layout.svelte", import.meta.url),
  "utf8",
);
const footerSource = readFileSync(
  new URL("../src/lib/components/layout/Footer.svelte", import.meta.url),
  "utf8",
);
const mobileNavMenuSource = readFileSync(
  new URL("../src/lib/components/layout/MobileNavMenu.svelte", import.meta.url),
  "utf8",
);
const githubBrandIconSource = readFileSync(
  new URL("../src/lib/components/GitHubBrandIcon.svelte", import.meta.url),
  "utf8",
);
const navbarSource = readFileSync(
  new URL("../src/lib/components/layout/Navbar.svelte", import.meta.url),
  "utf8",
);
const homepageSource = readFileSync(
  new URL("../src/routes/+page.svelte", import.meta.url),
  "utf8",
);
const authStoreSource = readFileSync(
  new URL("../src/lib/stores/auth.ts", import.meta.url),
  "utf8",
);
const globalsSource = readFileSync(
  new URL("../src/styles/globals.css", import.meta.url),
  "utf8",
);
const markdownSource = readFileSync(
  new URL("../src/lib/components/MarkdownContent.svelte", import.meta.url),
  "utf8",
);
const mobileFeedSource = readFileSync(
  new URL("../src/lib/components/MobileFeed.svelte", import.meta.url),
  "utf8",
);
const apiMutatorSource = readFileSync(
  new URL("../src/lib/api/mutator.ts", import.meta.url),
  "utf8",
);
const creatorCardSource = readFileSync(
  new URL("../src/lib/components/CreatorCard.svelte", import.meta.url),
  "utf8",
);
const apiSchemasSource = readFileSync(
  new URL("../src/lib/api/f2z.schemas.ts", import.meta.url),
  "utf8",
);

test("intentional scrolling stays smooth without affecting route restoration", () => {
  assert.doesNotMatch(globalsSource, /scroll-behavior:\s*smooth/);
  assert.match(
    markdownSource,
    /behavior:\s*reduceMotion\s*\?\s*"auto"\s*:\s*"smooth"/,
  );
  assert.match(
    markdownSource,
    /anchor\.addEventListener\("click"[\s\S]*?scrollArticleTarget\(heading\)/,
  );
  assert.match(
    mobileFeedSource,
    /behavior:\s*prefersReducedMotion\s*\?\s*"auto"\s*:\s*"smooth"/,
  );
});

test("homepage decorations avoid oversized blur-filter layers", () => {
  assert.match(globalsSource, /\.glow-radial\s*\{/);
  assert.match(globalsSource, /\.glow-linear\s*\{/);
  assert.doesNotMatch(homepageSource, /blur-\[(?:90|100|120)px\]/);
});

test("the shared creator card is square from the desktop card breakpoint", () => {
  assert.match(creatorCardSource, /sm:aspect-square/);
  assert.match(creatorCardSource, /sm:h-auto/);
  assert.doesNotMatch(creatorCardSource, /sm:h-\[300px\]/);
});

test("navbar avoids backdrop recompositing at every viewport", () => {
  // Attribute ORDER is not the contract — `class` is. `<nav>` grew a
  // `lang` before it, and pinning `class` to first position turned a
  // no-behaviour-change attribute into an empty match and a green-looking
  // assertion about nothing.
  const navClass = navbarSource.match(/<nav[^>]*?\sclass="([^"]+)"/)?.[1] ?? "";
  assert.notEqual(navClass, "", "the <nav> class list must be found at all");
  assert.doesNotMatch(navClass, /transition-all/);
  assert.doesNotMatch(navClass, /backdrop-blur/);
});

test("footer wordmark does not reserve a permanent compositor layer", () => {
  assert.doesNotMatch(footerSource, /will-change:\s*background-position/);
  assert.match(
    footerSource,
    /@media \(max-width: 767px\)[\s\S]*?\.footer-wordmark[\s\S]*?animation:\s*none/,
  );
});

test("homepage footer visibility uses the CSS mobile breakpoint", () => {
  assert.match(
    layoutSource,
    /<Footer[\s\S]*?hideOnMobile=\{\$pageStore\.url\.pathname === "\/"\}/,
  );
  assert.match(footerSource, /export let hideOnMobile = false;/);
  assert.match(footerSource, /hideOnMobile[\s\S]*?'hidden md:block'/);
});

test("mobile nav menu opens as a left-side sheet", () => {
  assert.match(
    mobileNavMenuSource,
    /import \* as Sheet from "\$lib\/components\/ui\/sheet";/,
  );
  assert.doesNotMatch(mobileNavMenuSource, /\$lib\/components\/ui\/drawer/);
  assert.match(mobileNavMenuSource, /<Sheet\.Content[\s\S]*side="left"/);
  assert.match(mobileNavMenuSource, /<Sheet\.Content[\s\S]*overflow-hidden/);
});

test("mobile nav social links keep compact visual buttons inside accessible touch targets", () => {
  const openingTagWithClass = (source, tagName, classPrefix) => {
    const classIndex = source.indexOf(`class="${classPrefix}`);
    const tagStart = source.lastIndexOf(`<${tagName}`, classIndex);
    if (classIndex < 0 || tagStart < 0) return "";

    let expressionDepth = 0;
    for (let index = tagStart; index < source.length; index += 1) {
      if (source[index] === "{") expressionDepth += 1;
      if (source[index] === "}") expressionDepth -= 1;
      if (source[index] === ">" && expressionDepth === 0) {
        return source.slice(tagStart, index + 1);
      }
    }
    return "";
  };
  const socialLinkLabel = /aria-label=\{\$t\(link\.key, link\.fallback\)\}/;
  const socialLinkAnchorTag = openingTagWithClass(
    mobileNavMenuSource,
    "a",
    "group grid size-11 place-items-center rounded-full",
  );
  assert.notEqual(
    socialLinkAnchorTag,
    "",
    "the 44px social link must be found",
  );
  assert.match(socialLinkAnchorTag, socialLinkLabel);

  // A label on the aria-hidden icon wrapper is invisible to assistive
  // technology. Keep this mutation as a negative control for the anchor check.
  const movedLabelSource = mobileNavMenuSource.replace(
    "            aria-label={$t(link.key, link.fallback)}\n          >\n            <span",
    "          >\n            <span\n              aria-label={$t(link.key, link.fallback)}",
  );
  assert.notEqual(movedLabelSource, mobileNavMenuSource);
  assert.throws(() =>
    assert.match(
      openingTagWithClass(
        movedLabelSource,
        "a",
        "group grid size-11 place-items-center rounded-full",
      ),
      socialLinkLabel,
    ),
  );

  const socialLinkIconWrapperTag = openingTagWithClass(
    mobileNavMenuSource,
    "span",
    "grid size-8 place-items-center rounded-full border",
  );
  assert.notEqual(socialLinkIconWrapperTag, "");
  assert.match(socialLinkIconWrapperTag, /aria-hidden="true"/);
  assert.match(mobileNavMenuSource, /<Heart class="size-3\.5" \/>/);
  assert.match(mobileNavMenuSource, /<GitHubBrandIcon class="size-3\.5" \/>/);
  const githubSvgTag = githubBrandIconSource.match(/<svg[\s\S]*?>/)?.[0] ?? "";
  assert.notEqual(githubSvgTag, "", "the GitHub brand SVG must be present");
  assert.match(githubSvgTag, /viewBox="0 0 24 24"/);
  assert.match(githubSvgTag, /class=\{className\}/);
  assert.match(githubSvgTag, /fill="currentColor"/);
  assert.match(githubSvgTag, /aria-hidden="true"/);
  assert.match(githubBrandIconSource, /<path\s+d="[^"]+"\s*\/>/);
  assert.match(
    mobileNavMenuSource,
    /<span class="text-xs font-semibold">X<\/span>/,
  );
});

test("mobile user-agent detection gates the feed SSR request", () => {
  assert.equal(
    isLikelyMobileUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    ),
    true,
  );
  assert.equal(
    isLikelyMobileUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
    false,
  );
});

test("public homepage feed options never forward session headers", () => {
  assert.deepEqual(createPublicApiOptions("http://backend"), {
    baseURL: "http://backend",
    credentials: "omit",
  });
  assert.equal("headers" in createPublicApiOptions("http://backend"), false);
  assert.match(
    pageServerSource,
    /const latestRequest = wantsMobileFeed[\s\S]*?publicOptions,[\s\S]*?upstreamSignal/,
  );
});

test("every homepage SSR API call shares one bounded deadline", () => {
  assert.match(
    pageServerSource,
    /const upstreamSignal = createHomepageUpstreamSignal\([\s\S]*?HOMEPAGE_TIMEOUT_MS/,
  );
  assert.equal(pageServerSource.match(/,\s*upstreamSignal,\s*\)/g)?.length, 5);
  assert.doesNotMatch(pageServerSource, /dytePublicDiscoveryList|liveNow/);
});

test("homepage live discovery uses one shared list for the rail and cards", () => {
  assert.match(
    homepageSource,
    /dytePublicDiscoveryList\(\s*publicLiveOptions,\s*controller\.signal,?\s*\)/,
  );
  assert.match(homepageSource, /createLiveDiscoveryOptions\(apiBase\)/);
  assert.match(homepageSource, /setInterval\(refreshLiveNow, 45_000\)/);
  assert.match(homepageSource, /data-testid="homepage-live-now"/);
  assert.match(
    homepageSource,
    /streamWatchPath\(stream\.username, stream\.meeting_type\)/,
  );
  assert.match(homepageSource, /<Radio[\s\S]*?Free/);
  assert.match(homepageSource, /<Users[\s\S]*?Subscribers/);
  assert.match(homepageSource, /<Ticket[\s\S]*?2Z\/min/);
  assert.doesNotMatch(homepageSource, /DollarSign|\$\{?stream/);
  assert.match(homepageSource, /liveStreams=\{/);
  assert.match(
    homepageSource,
    /servedByStatic = normalized\.startsWith\("\/djstatic\/"\)/,
  );
  assert.match(creatorCardSource, /initialStatus=\{initialLiveStatus\}/);
});

test("generated meeting API keeps the stable enum export", () => {
  assert.match(apiSchemasSource, /meeting_type\?: MeetingTypeEnum;/);
  assert.match(apiSchemasSource, /export type MeetingTypeEnum =/);
  assert.match(apiSchemasSource, /export const MeetingTypeEnum =/);
  assert.doesNotMatch(apiSchemasSource, /CreatorMeetingMeetingTypeEnum/);
});

test("homepage discovery preserves unavailable state for fallback polling", () => {
  assert.doesNotMatch(pageServerSource, /dytePublicDiscoveryList|liveNow/);
  assert.match(homepageSource, /avatar_image\?\.thumb/);
  assert.doesNotMatch(
    homepageSource,
    /avatar_image\?\.thumbnail\s*\|\|\s*c\?\.avatar_image\?\.url/,
  );
});

test("live discovery helpers preserve unknown state and honest viewer counts", () => {
  const liveStream = {
    username: "live",
    meeting_type: "ppv",
    price_per_minute: "1.25",
  };
  const selected = new Map([["live", [liveStream]]]);
  const complete = {
    results: [liveStream],
    selected_creators: ["live"],
    complete: true,
  };

  assert.deepEqual(liveStatusFromStreams([liveStream]), {
    is_live: true,
    streams: [{ type: "ppv", price_per_minute: 1.25 }],
  });
  assert.equal(
    "participant_count" in liveStatusFromStreams([liveStream]),
    false,
  );
  assert.deepEqual(liveStreamsForCreator(complete, selected, "live"), [
    liveStream,
  ]);
  assert.equal(liveStreamsForCreator(complete, new Map(), "offline"), null);
  assert.equal(liveStreamsForCreator(undefined, selected, "live"), undefined);

  const incomplete = {
    results: [liveStream],
    selected_creators: ["live"],
    complete: false,
  };
  // A creator can move from a complete selected snapshot to an incomplete
  // snapshot; outside the new cap it must become unknown, not offline.
  assert.equal(
    liveStreamsForCreator(incomplete, new Map(), "outside"),
    undefined,
  );
});

test("live discovery distinguishes an unavailable response from an empty list", () => {
  assert.equal(LIVE_DISCOVERY_LIMIT, 12);
  assert.equal(resolveLiveDiscovery(null), undefined);
  assert.deepEqual(resolveLiveDiscovery([]), {
    results: [],
    selected_creators: [],
    complete: true,
  });
  assert.deepEqual(resolveLiveDiscovery({ results: [{ username: "live" }] }), {
    results: [{ username: "live" }],
    selected_creators: ["live"],
    complete: true,
  });
});

test("live discovery requests bypass browser and intermediary caches", () => {
  assert.deepEqual(createLiveDiscoveryOptions("http://backend"), {
    baseURL: "http://backend",
    credentials: "omit",
    cache: "no-store",
  });
});

test("the shared API client gives every SSR request a default deadline", () => {
  assert.match(apiMutatorSource, /const DEFAULT_SSR_API_TIMEOUT_MS = 10_000;/);
  assert.match(
    apiMutatorSource,
    /const\s+ssrRequestSignal\s*=\s*!browser\s*\?\s*createSsrApiSignal\(\s*init\?\.\s*signal\s*\)\s*:\s*undefined\s*;/,
  );
  assert.match(
    apiMutatorSource,
    // The SSR deadline comes first; the browser bound  is only armed
    // when `browser` is true, so it never displaces it.
    /const\s+requestInit[\s\S]*?signal\s*:\s*ssrRequestSignal\?\.\s*signal\s*\?\?(?:\s*browserTimeout\?\.\s*signal\s*\?\?)?\s*init\?\.\s*signal\s*,/,
  );
  assert.match(
    apiMutatorSource,
    /finally\s*\{[\s\S]*?ssrRequestSignal\?\.\s*cleanup\(\)\s*;/,
  );
});

test("homepage upstream signal enforces cancellation and timeout", async () => {
  const requestController = new AbortController();
  const requestBound = createHomepageUpstreamSignal(
    requestController.signal,
    1_000,
  );
  requestController.abort(new DOMException("client left", "AbortError"));
  assert.equal(requestBound.aborted, true);
  assert.equal(requestBound.reason?.name, "AbortError");

  const deadlineBound = createHomepageUpstreamSignal(null, 5);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(deadlineBound.aborted, true);
  assert.equal(deadlineBound.reason?.name, "TimeoutError");
});

test("mobile homepage feeds use server-provided cursor continuation", () => {
  assert.match(
    pageServerSource,
    /ordering: "-published_at,-id",[\s\S]*?pagination: "cursor"/,
  );
  assert.match(
    pageServerSource,
    /homeSort: "updated",[\s\S]*?pagination: "cursor"/,
  );
  assert.match(pageServerSource, /latestNext:[\s\S]*?relativeApiPath/);
  assert.match(pageServerSource, /trendingNext:[\s\S]*?relativeApiPath/);
  assert.match(
    pageServerSource,
    /homeSort: "updated",[\s\S]*?publicOptions,[\s\S]*?upstreamSignal/,
  );
  assert.match(
    pageServerSource,
    /trendingHasMore:[\s\S]*?trendingRes\.status === "fulfilled"[\s\S]*?: true/,
  );
});

test("a timed-out mobile feed caches healthy core data with client recovery", () => {
  const coreOutcomes = [
    { status: "fulfilled", value: { results: [{ title: "Hero" }] } },
    { status: "fulfilled", value: { results: [{ title: "Trending" }] } },
    { status: "rejected", reason: new Error("popular unavailable") },
    { status: "fulfilled", value: { results: [] } },
  ];
  const timedOutFeed = {
    status: "rejected",
    reason: new DOMException("timed out", "TimeoutError"),
  };
  const usable = hasUsableHomepageData(coreOutcomes, true, timedOutFeed);
  const latestState = resolveLatestFeed(true, timedOutFeed);
  const degraded = { trending: [{ title: "Trending" }], ...latestState };
  const cache = createTtlCache(60_000);

  assert.equal(usable, true);
  assert.deepEqual(latestState, { latest: [], latestHasMore: true });
  cacheAnonymousHomepage(cache, degraded, {
    authenticated: false,
    usable,
  });
  assert.deepEqual(cache.get(), degraded);
});

test("an authenticated render never reaches the anonymous cache", () => {
  // Sharp edge of: before it, the forwarded cookie was dropped, so every
  // SSR render was anonymous and caching one was harmless. Now an
  // authenticated render can contain the viewer's own unpublished pages, and
  // writing it to this process-wide cache would serve one user's drafts to
  // every anonymous visitor for the whole TTL.
  const cache = createTtlCache(60_000);
  const anonymous = { heroStory: { free2zaddr: "public" } };
  const personalized = { heroStory: { free2zaddr: "my-unpublished-draft" } };

  cacheAnonymousHomepage(cache, anonymous, {
    authenticated: false,
    usable: true,
  });
  assert.deepEqual(cache.get(), anonymous);

  const returned = cacheAnonymousHomepage(cache, personalized, {
    authenticated: true,
    usable: true,
  });

  // The signed-in visitor still gets their own data back...
  assert.deepEqual(returned, personalized);
  //...but the shared cache is untouched.
  assert.deepEqual(cache.get(), anonymous);
});

test("a signed-in request bypasses the cache instead of reading it", () => {
  // The read side of the same edge: the load only consults the cache when the
  // request carries no session, so a signed-in visitor can never be served a
  // stale anonymous payload as if it were their personalized view.
  assert.match(
    pageServerSource,
    /if \(!authenticated\) \{\s*const cached = cache\.get\(\);/,
  );
  assert.match(
    pageServerSource,
    /const authenticated = Boolean\(cookie && \/\(\?:\^\|;\\s\*\)sessionid=\/\.test\(cookie\)\);/,
  );
  // Cookie forwarding is gated on the same flag, so the cached branch and the
  // anonymous upstream call can never disagree about who the visitor is.
  assert.match(
    pageServerSource,
    /headers: authenticated && cookie \? \{ cookie \} : undefined/,
  );
});

test("all homepage marketing promotion variants require anonymous SSR and client state", () => {
  assert.match(
    homepageSource,
    /\{#if !data\.authenticated && \!\$isAuthenticated\}\s*<MobileIntro \/>\s*\{\/if\}/,
  );
  assert.match(
    homepageSource,
    /\{#if !data\.authenticated && \!\$isAuthenticated\}\s*<DesktopIntro \/>\s*\{\/if\}/,
  );
  assert.match(
    homepageSource,
    /\{#if !data\.authenticated && \!\$isAuthenticated\}[\s\S]*?<HomeCTA \/>[\s\S]*?\{\/if\}/,
  );
});

test("successful logout forces a new document and fences pre-logout auth checks", () => {
  // A FULL document load either way: reload on a public page, the
  // homepage otherwise. Never goto()/invalidateAll() — the homepage derives
  // its lists once on mount and an authenticated response includes private
  // drafts. The reload verdict is taken before the request and applied only
  // if the URL has not moved since.
  assert.match(
    authStoreSource,
    /const startedAt = window\.location\.href;\s*const destination = logoutDestination\(window\.location\.pathname\);/,
  );
  assert.match(
    authStoreSource,
    /authGeneration \+= 1;[\s\S]*?clearAuthState\(\);[\s\S]*?destination === "reload" &&\s*window\.location\.href === startedAt[\s\S]*?window\.location\.reload\(\);[\s\S]*?window\.location\.assign\("\/"\)/,
  );
  assert.doesNotMatch(authStoreSource, /\bgoto\(|invalidateAll\(/);
  assert.match(
    authStoreSource,
    /const checkGeneration = authGeneration;[\s\S]*?if \(checkGeneration !== authGeneration\) \{[\s\S]*?return fresh \? false : currentState\.isAuthenticated;/,
  );
  // Ordinary checks preserve the last known auth state when a stale response
  // loses the generation race; only an explicitly fresh reconciliation must
  // fail closed so a payment recovery cannot accept an older session answer.
  assert.match(
    authStoreSource,
    /if \(\s*!force &&\s*!fresh &&[\s\S]*?return currentState\.isAuthenticated;/,
  );
});

test("total upstream failure is not cached", () => {
  const rejected = { status: "rejected", reason: new Error("offline") };
  const usable = hasUsableHomepageData(
    [rejected, rejected, rejected, rejected],
    true,
    rejected,
  );
  const cache = createTtlCache(60_000);

  assert.equal(usable, false);
  cacheAnonymousHomepage(
    cache,
    { empty: true },
    {
      authenticated: false,
      usable,
    },
  );
  assert.equal(cache.get(), undefined);
});

test("total upstream failure stays locale-aware and recoverable", () => {
  assert.deepEqual(createDegradedHomepageData("es"), {
    heroStory: null,
    trending: [],
    trendingHasMore: true,
    trendingNext: null,
    popular: [],
    creators: [],
    latest: [],
    latestHasMore: true,
    latestNext: null,
    latestLang: "es",
  });
  assert.match(
    pageServerSource,
    /if \(!usable\) \{[\s\S]*?return \{ \.\.\.createDegradedHomepageData\(locale\), authenticated \};[\s\S]*?\}\s+const latestState/,
  );
});

test("oneWeekAgo returns a YYYY-MM-DD date seven days back", () => {
  assert.equal(oneWeekAgo(new Date("2026-07-19T12:00:00Z")), "2026-07-12");
});

test("hero prefers the highest-scoring image-bearing page from this week", () => {
  const hero = pickHeroStory(
    [
      {
        title: "old but huge",
        f2z_score: "900",
        created_at: "2022-01-01",
        featured_image: img,
      },
      {
        title: "this week, low",
        f2z_score: "5",
        created_at: "2026-07-15",
        featured_image: img,
      },
      {
        title: "this week, high",
        f2z_score: "50",
        created_at: "2026-07-16",
        featured_image: img,
      },
    ],
    "2026-07-12",
  );
  assert.equal(hero.title, "this week, high");
});

test("hero skips pages without a featured image", () => {
  const hero = pickHeroStory(
    [
      { title: "no image", f2z_score: "999", created_at: "2026-07-16" },
      {
        title: "thumbnail only",
        f2z_score: "1",
        created_at: "2026-07-16",
        featured_image: { thumbnail: "/t.png" },
      },
    ],
    "2026-07-12",
  );
  assert.equal(hero.title, "thumbnail only");
});

test("hero falls back to all-time when the week was quiet", () => {
  const hero = pickHeroStory(
    [
      {
        title: "old",
        f2z_score: "9",
        created_at: "2022-01-01",
        featured_image: img,
      },
    ],
    "2026-07-12",
  );
  assert.equal(hero.title, "old");
});

test("hero is null when nothing has an image", () => {
  assert.equal(
    pickHeroStory([{ title: "x", created_at: "2026-07-16" }], "2026-07-12"),
    null,
  );
  assert.equal(pickHeroStory([], "2026-07-12"), null);
  assert.equal(pickHeroStory(undefined, "2026-07-12"), null);
});

test("ttl cache serves a hit until it expires", () => {
  const cache = createTtlCache(60_000);
  assert.equal(cache.get(1_000), undefined);
  cache.set({ ok: true }, 1_000);
  assert.deepEqual(cache.get(30_000), { ok: true });
  assert.deepEqual(cache.get(60_999), { ok: true });
  assert.equal(cache.get(61_000), undefined);
});

test("ttl cache can be cleared", () => {
  const cache = createTtlCache(60_000);
  cache.set("v", 0);
  cache.clear();
  assert.equal(cache.get(1), undefined);
});
