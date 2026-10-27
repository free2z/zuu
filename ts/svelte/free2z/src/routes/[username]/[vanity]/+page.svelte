<script lang="ts">
  import { formatDate as formatApiDate } from "$lib/utils/date";
  import { beforeNavigate, goto } from "$app/navigation";
  import { navigating, page as currentPage } from "$lib/kit-stores";
  import { match } from "$app/paths";
  import type { Navigation } from "$app/navigation";
  import * as env from "$app/env/public";
  import { onDestroy, onMount, tick } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import {
    ArrowLeft,
    BookOpen,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Coins,
    LockKeyhole,
    Sparkles,
    Tag,
  } from "@lucide/svelte";
  import type { PageData } from "./$types";
  import type { ZPageDetail } from "$lib/api/f2z.schemas";
  import {
    locale,
    setDocumentContentLanguage,
    tStore as t,
    loading,
  } from "$lib/i18n";
  import {
    contentDirectionAttribute,
    languageDisplayName,
    normalizeContentLanguage,
    resolveContentLanguageRange,
    resolveFallbackDisclosure,
  } from "$lib/zpage-language.js";
  import { tagHref } from "$lib/tags.js";
  import { processMarkdown } from "$lib/utils/markdown";
  import { useFirstPartyCards } from "$lib/first-party-card-resolver";
  import { buildVideoPosterMap } from "$lib/utils/embedded-media";
  import { buildZPageMeta } from "$lib/meta";
  import PageActions from "$lib/components/zpageActions/PageActions.svelte";
  import ProfileSubscribe from "$lib/components/profile/ProfileSubscribe.svelte";
  import { authStore } from "$lib/stores/auth";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import TableOfContents from "$lib/components/TableOfContents.svelte";
  import RelatedZpageCard from "$lib/components/RelatedZpageCard.svelte";
  import ZPageHeroMedia from "$lib/components/ZPageHeroMedia.svelte";
  import {
    afterDeferredLinkNavigation,
    clientRoutedLinkUrl,
    canReleaseFullPageNavigationFallback,
  } from "$lib/client-link-navigation";
  import { scrollScene, type HeroFit } from "$lib/utils/hero-parallax";

  export let data: PageData;

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";
  let pageMeta = buildZPageMeta(undefined);
  let jsonLdString: string | null = null;
  let scorePageId: string | null = null;
  let pageScore: string | number | null = null;
  let scoreAnnouncement = "";

  $: article = data.article;
  $: if ((article?.free2zaddr ?? null) !== scorePageId) {
    scorePageId = article?.free2zaddr ?? null;
    pageScore = article?.f2z_score ?? null;
    scoreAnnouncement = "";
  }

  function hasScore(value: string | number | null | undefined) {
    return (
      value !== null &&
      value !== undefined &&
      value !== "" &&
      Number.isFinite(Number(value))
    );
  }

  function handleScoreChange(
    score: string,
    pageId: string,
    phase: "pending" | "authoritative" = "pending",
  ) {
    // Ignore a response from a request that belongs to the page we navigated
    // away from. The identity check is what prevents score leakage between
    // reused [vanity] route instances.
    if (pageId !== scorePageId) return;
    pageScore = score;
    // The callback carries the RAW decimal string; only the announcement
    // renders it, through the same compact formatter as the hero chip, so a
    // screen reader never hears "17.50000000".
    scoreAnnouncement =
      phase === "authoritative"
        ? $t("pageActions.boost.scoreUpdated", "Score updated to {score}", {
            score: formatCompact(score),
          })
        : "";
  }

  // Every variant the API says this article has, as a canonical content tag.
  //
  // This used to be filtered against `languageOptions` — the four locales the
  // PRODUCT UI is translated into — so a published `zh-Hans` translation could
  // never appear in the switcher, on an article that visibly had two languages
  //. The set of languages an article can be written in is the ~40 the
  // editor sells a translation into, and it is not this list. `und` is kept as
  // the "original, language unknown" sentinel it has always been.
  $: availableArticleLanguages = (
    (article as any)?.available_languages || []
  ).reduce((languages: string[], value: unknown) => {
    const tag = value === "und" ? "und" : normalizeContentLanguage(value);
    if (tag && !languages.includes(tag)) languages.push(tag);
    return languages;
  }, [] as string[]);
  // The poster map is derived from the SAME `article.media` the JSON-LD
  // uses, so a video can never be given a `poster=` the structured data
  // disagrees with.
  $: videoPosters = buildVideoPosterMap((article as any)?.media);
  // The article's own cards also seed the page resolver: a comment
  // embedding the same page reuses the server's answer, and the server's
  // calls count against the one page budget.
  const pageFirstPartyCards = useFirstPartyCards();
  $: pageFirstPartyCards.seed(data.firstPartyCardSeed);
  $: processedContent = article?.content
    ? processMarkdown(article.content, {
        videoPosters,
        firstPartyCards: data.firstPartyCards,
      })
    : "";
  // The language the body is actually written in, for `lang` on the content
  // itself. The page chrome keeps the reader's UI language (`<html lang>`),
  // so a screen reader switches voice for the article and nothing else.
  $: articleContentLanguage =
    normalizeContentLanguage((article as any)?.actual_language) ?? undefined;
  //...and which way that language runs. Derived from the SCRIPT, so an article
  // stored as `az-Arab` is right-to-left and one stored as `az-Latn` is not
  //  and `lang`/`dir` are independent attributes, so  setting the
  // first left a published Arabic translation correctly LABELLED and still laid
  // out left-to-right.
  //
  // On the CONTENT, never on `<html>`. The reader opening the Arabic version may
  // well be reading the product UI in English, and an Arabic article does not
  // entitle us to flip their navbar — the same reason `<html lang>` was the
  // wrong single knob for language. The chrome keeps the UI locale's direction
  // ( P8; RTL product UI is ), and only the article's text follows the
  // article.
  //
  // `contentDirectionAttribute`, not `contentDirection` directly: the unknown
  // case must become `dir="auto"` rather than an omitted attribute. See its
  // docstring — an unlabelled legacy Hebrew article would otherwise inherit the
  // chrome's left-to-right.
  $: articleContentDirection = contentDirectionAttribute(
    (article as any)?.actual_language,
  );
  // `<html lang>` arrives from the server already naming this variant; keep it
  // naming it after hydration and across a client-side language switch, both
  // of which would otherwise hand the attribute back to the UI locale.
  $: setDocumentContentLanguage(articleContentLanguage ?? null);
  //...and hand it back when this page goes away, or the next route inherits a
  // language that is no longer on screen.
  onDestroy(() => setDocumentContentLanguage(null));
  // What the READER asked for, which is not always what the response was asked
  // for. When a language range resolves (`?lang=zh` -> `zh-Hans`) the loader
  // fetches a second time, and that response's `requested_language` is the
  // RESOLVED tag with `fallback_used: false` — so reading the disclosure out of
  // the response alone makes it structurally unreachable for every
  // range-resolved request, including the ones where the range could not be
  // honoured. The reader's own tag survives in `data.requestedArticleLanguage`.
  $: readerRequestedLanguage =
    data.requestedArticleLanguage ?? (article as any)?.requested_language;
  // Did the variant on screen actually answer that request? `?lang=zh` served
  // as `zh-Hans` did (it is the one Chinese variant); `?lang=zh-TW` served as
  // `zh-Hans` did NOT, and that is the case the note exists for. Asked of the
  // same resolver the loader uses, against the served variant alone.
  $: servedAnswersRequest =
    !readerRequestedLanguage ||
    !articleContentLanguage ||
    resolveContentLanguageRange(readerRequestedLanguage, [
      articleContentLanguage,
    ]) === articleContentLanguage;
  // Quiet, inline, and null unless every condition in `resolveFallbackDisclosure`
  // holds — in particular it yields language *names*, never a raw subtag.
  $: fallbackDisclosure = resolveFallbackDisclosure({
    fallbackUsed: (article as any)?.fallback_used || !servedAnswersRequest,
    requestedLanguage: readerRequestedLanguage,
    actualLanguage: (article as any)?.actual_language,
    reflectsReaderChoice:
      Boolean(data.requestedArticleLanguage) ||
      availableArticleLanguages.length > 1,
    viewerLocale: $locale,
  });

  let reloadComments = 0;
  let CommentFormComponent:
    | (typeof import("$lib/components/comments/CommentForm.svelte"))["default"]
    | null = null;
  let DisplayThreadedCommentsComponent:
    | (typeof import("$lib/components/comments/DisplayThreadedComments.svelte"))["default"]
    | null = null;
  let commentsLoadPromise: Promise<void> | null = null;
  let relatedScroller: HTMLDivElement | null = null;
  let canScrollRelatedPrev = false;
  let canScrollRelatedNext = false;
  let relatedScrollFrame: number | null = null;

  function handleCommentSuccess() {
    reloadComments++;
  }

  function loadComments() {
    if (!commentsLoadPromise) {
      commentsLoadPromise = Promise.all([
        import("$lib/components/comments/CommentForm.svelte"),
        import("$lib/components/comments/DisplayThreadedComments.svelte"),
      ]).then(([commentFormModule, commentsModule]) => {
        CommentFormComponent = commentFormModule.default;
        DisplayThreadedCommentsComponent = commentsModule.default;
      });
    }
    return commentsLoadPromise;
  }

  function deferComments(node: HTMLElement) {
    if (typeof IntersectionObserver === "undefined") {
      void loadComments();
      return {};
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadComments();
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);

    return {
      destroy() {
        observer.disconnect();
      },
    };
  }

  function normalizeMediaUrl(image?: string | null) {
    if (!image) return null;
    if (/^https?:\/\//.test(image)) return image;
    return `${apiBase}${image.startsWith("/") ? "" : "/"}${image}`;
  }

  // These four take `article` as an explicit argument rather than closing over
  // it. A `$:` statement only re-runs when a reactive variable it *references*
  // changes, so `$: imageUrl = buildImageUrl()` registered no dependency at all
  // and ran exactly once — leaving the previous zpage's hero image, avatar and
  // author name on screen after a client-side zpage->zpage navigation, next to
  // the new title and body. Keep the parameter.
  function buildImageUrl(page: ZPageDetail | undefined) {
    return normalizeMediaUrl(
      page?.featured_image?.url || page?.featured_image?.thumbnail,
    );
  }

  function buildThumbnailUrl(page: ZPageDetail | undefined) {
    return normalizeMediaUrl(page?.featured_image?.thumbnail);
  }

  function buildAvatarUrl(page: ZPageDetail | undefined) {
    const avatar =
      page?.creator?.avatar_image?.url ||
      page?.creator?.avatar_image?.thumbnail;
    if (!avatar) return null;
    if (/^https?:\/\//.test(avatar)) return avatar;
    return `${apiBase}${avatar.startsWith("/") ? "" : "/"}${avatar}`;
  }

  function formatDate(dateString: string) {
    return formatApiDate(dateString, "en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  function formatCompact(value: string | number) {
    const num = Number(value);
    if (!isFinite(num)) return String(value);
    return new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(num);
  }

  function buildAuthorName(page: ZPageDetail | undefined) {
    const creator = page?.creator as
      { username?: string; full_name?: string } | undefined;
    return creator?.full_name || creator?.username || "Unknown Author";
  }

  function goBack() {
    goto("/");
  }

  async function chooseArticleLanguage(event: Event) {
    const language = (event.currentTarget as HTMLSelectElement).value;
    const next = new URL(window.location.href);
    if (language === "und") {
      // `und` is legacy metadata, not a selectable platform locale. The clean
      // article URL resolves to the original canonical content.
      next.searchParams.delete("lang");
    } else {
      // Deliberately does NOT touch the product-UI language. Reading one
      // article in Spanish used to re-skin the navbar, the buttons and the
      // footer — and persist that in a cookie — because the article's language
      // and the reader's UI language were the same knob ( §1.6f).
      // `?lang=` stays the shareable deep link to this variant, and nothing
      // else moves.
      next.searchParams.set("lang", language);
    }
    await goto(`${next.pathname}${next.search}`, {
      refreshAll: true,
      replace: true,
      // Keyboard and screen-reader users keep their place on the control they
      // just operated instead of being dumped back at the top of the document.
      reset: false,
    });
  }

  function updateRelatedScrollState() {
    if (!relatedScroller) {
      canScrollRelatedPrev = false;
      canScrollRelatedNext = false;
      return;
    }

    const maxScrollLeft = Math.max(
      0,
      relatedScroller.scrollWidth - relatedScroller.clientWidth,
    );
    canScrollRelatedPrev = relatedScroller.scrollLeft > 1;
    canScrollRelatedNext = relatedScroller.scrollLeft < maxScrollLeft - 1;
  }

  function scheduleRelatedScrollStateUpdate() {
    if (typeof requestAnimationFrame === "undefined") {
      updateRelatedScrollState();
      return;
    }

    if (relatedScrollFrame !== null) {
      cancelAnimationFrame(relatedScrollFrame);
    }

    relatedScrollFrame = requestAnimationFrame(() => {
      relatedScrollFrame = null;
      updateRelatedScrollState();
    });
  }

  function trackRelatedScroller(node: HTMLDivElement) {
    relatedScroller = node;
    let destroyed = false;
    const handleScrollerChange = () => scheduleRelatedScrollStateUpdate();
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(handleScrollerChange)
        : null;

    node.addEventListener("scroll", handleScrollerChange, { passive: true });
    resizeObserver?.observe(node);
    window.addEventListener("resize", handleScrollerChange);

    tick().then(() => {
      if (!destroyed) handleScrollerChange();
    });

    return {
      destroy() {
        destroyed = true;
        node.removeEventListener("scroll", handleScrollerChange);
        resizeObserver?.disconnect();
        window.removeEventListener("resize", handleScrollerChange);

        if (relatedScrollFrame !== null) {
          cancelAnimationFrame(relatedScrollFrame);
          relatedScrollFrame = null;
        }
        if (relatedScroller === node) relatedScroller = null;
        updateRelatedScrollState();
      },
    };
  }

  function scrollRelated(direction: -1 | 1) {
    if (!relatedScroller) return;

    const firstCard = relatedScroller.firstElementChild as HTMLElement | null;
    const columnGap = Number.parseFloat(
      getComputedStyle(relatedScroller).columnGap || "0",
    );
    const gap = Number.isFinite(columnGap) ? columnGap : 0;
    const scrollStep = firstCard
      ? firstCard.getBoundingClientRect().width + gap
      : relatedScroller.clientWidth * 0.85;

    relatedScroller.scrollBy({
      left: direction * scrollStep,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    scheduleRelatedScrollStateUpdate();
  }

  // Scroll updates only the progress bar; the hero stays static.
  let articleEl: HTMLElement;
  let progressEl: HTMLElement;

  // The hero's measured fit, bound UP from ZPageHeroMedia (`bind:fit`) and
  // mirrored onto the `.zhero` section as `data-hero-fit`. Mechanism,
  // chosen over a `:global()` reach into another component's subtree: only
  // this component's scoped stylesheet can style `.zhero__headline`, so the
  // decision has to arrive as a plain attribute here. Defaults to "contain" —
  // what SSR renders — so the headline's glyph pad below is present from first
  // paint and only the rare cover flip re-renders it.
  let heroFit: HeroFit = "contain";

  // zPage -> zPage navigation. SvelteKit REUSES this component when
  // only the params change, and it keeps the old `data` until the new load has
  // resolved — so, left alone, the page being left stays on screen for the
  // whole load. After that, an `<img>` whose `src` is swapped keeps painting
  // its PREVIOUS bitmap until the new bytes arrive (Chromium, measured: the
  // new `src` is set, `complete` is false, and the old picture is still
  // there), so the new title sat next to the old cover and the old creator's
  // face. And `heroFit`, bound up from the hero, carried the old page's
  // measurement into the new one.
  //
  // Three parts, each for one of those:
  //   1. While a navigation to ANOTHER zPage is pending, render a skeleton of
  //      this layout and hide the old article.
  //   2. Key the hero media and the avatar image on the page's identity, so
  //      they are fresh elements with no bitmap to hold on to — including
  //      when a preloaded load resolves too fast to paint (1). ONLY those:
  //      the rest of the article keeps its component instances exactly as
  //      before, because several of them own in-flight paid requests.
  //   3. Reset the bound fit to the SSR default when the identity changes.
  // A same-page navigation (`?lang=`, a hash) keeps the identity, so it
  // neither shows the skeleton nor re-mounts anything, and neither does
  // hydration.
  //
  // Once the skeleton is up it stays up for as long as SOME navigation away
  // from this zPage is pending: a reader who clicks Home while B is loading
  // supersedes the B navigation, and dropping the skeleton then would bring
  // A back for the length of Home's load. Only a navigation back to this
  // very page, or none at all, takes it down.
  function isAnotherZPage(
    to: { route: { id: string | null }; params: Record<string, string> | null },
    routeId: string | null,
    vanity: string | undefined,
  ) {
    return !!routeId && to.route.id === routeId && to.params?.vanity !== vanity;
  }

  function isLeavingForAnotherZPage(
    navigation: Navigation | null,
    routeId: string | null,
    vanity: string | undefined,
    alreadyLeaving: boolean,
  ) {
    const to = navigation?.to;
    if (!to || !routeId) return false;
    if (to.route.id !== routeId) return alreadyLeaving;
    return isAnotherZPage(to, routeId, vanity);
  }

  let leavingZPage = false;
  let settledFullPageNavigation: Navigation | null = null;
  let pendingFullPageNavigation: Navigation | null = null;
  let fullPageNavigationTimer: ReturnType<typeof setTimeout> | null = null;
  let pageIsUnloading = false;
  const FULL_PAGE_NAVIGATION_SETTLE_GRACE_MS = 3000;
  $: leavingZPage = isLeavingForAnotherZPage(
    $navigating === settledFullPageNavigation ? null : $navigating,
    $currentPage.route.id,
    $currentPage.params.vanity,
    leavingZPage,
  );
  // SvelteKit's intent-backed routed navigation keeps willUnload=false even
  // when a failed server load later calls native_navigation(). That native
  // fallback fires beforeunload without changing the navigation store. A
  // download response can then leave this document alive, with no browser API
  // event that says the response has settled. Wait a conservative grace period
  // after beforeunload, then use the bounded same-document heuristic below.
  $: if (
    pendingFullPageNavigation &&
    $navigating !== pendingFullPageNavigation
  ) {
    if (fullPageNavigationTimer !== null) {
      clearTimeout(fullPageNavigationTimer);
      fullPageNavigationTimer = null;
    }
    pendingFullPageNavigation = null;
    settledFullPageNavigation = null;
  }

  // A LINK click enters the loading state in the click itself.
  // SvelteKit defers a link navigation past the next frame (it waits for
  // requestAnimationFrame + setTimeout(0) before it even resolves the route,
  // to keep the click cheap for INP), and `$navigating` and `beforeNavigate`
  // both only happen after that — so the frame painted right after the click
  // was always this page, and on a busy main thread it stayed up for a
  // quarter of a second. `clientRoutedLinkUrl` predicts, synchronously, the
  // navigation SvelteKit has just claimed; `match` resolves its route within
  // the same task (no `reroute` hook here, so it is microtasks only), and the
  // skeleton is rendered before the browser paints again.
  //
  // It is only a prediction, so it is held for exactly as long as it takes
  // SvelteKit to confirm it: `$navigating` taking a value hands over to the
  // latch above, and `afterDeferredLinkNavigation` drops it once SvelteKit's
  // deferred `navigate()` has had its chance to run. A click that another
  // handler intercepted, or a navigation a `beforeNavigate` callback
  // cancelled, therefore shows this page again one frame later — it can
  // never leave the skeleton up.
  let predictedLinkNavigation: object | null = null;
  // Keyed by the click itself, which SvelteKit hands to beforeNavigate as
  // `navigation.event`: a later click in the frame before the router starts
  // its deferred navigation must not release this one, and a `goto()` the
  // handler makes itself (no event) must not be cancelled in its place.
  const latePreventedLinkClicks = new WeakSet<Event>();
  beforeNavigate((navigation) => {
    if (
      navigation.type === "link" &&
      latePreventedLinkClicks.has(navigation.event)
    ) {
      latePreventedLinkClicks.delete(navigation.event);
      navigation.cancel();
    }
  });
  $: if ($navigating) predictedLinkNavigation = null;
  $: switchingZPage = leavingZPage || predictedLinkNavigation !== null;

  // MarkdownContent mounts media controls imperatively inside the retained
  // article component. Pause them before the article is hidden so playback
  // cannot continue underneath the loading placeholder. Keep the query
  // scoped to this article so unrelated portals (such as media previews) keep
  // working.
  $: if (leavingZPage && typeof document !== "undefined") {
    articleEl
      ?.querySelectorAll<HTMLMediaElement>("audio, video")
      .forEach((media) => {
        media.pause();
      });
  }

  async function predictZPageLinkNavigation(event: MouseEvent) {
    const from = window.location.href;
    const url = clientRoutedLinkUrl(event, from, document.baseURI);
    if (!url) return;
    const routeId = $currentPage.route.id;
    const vanity = $currentPage.params.vanity;
    const navigationAtClick = $navigating;
    const target = await match(url);
    // Nothing may have moved in between: this is still the page the click
    // was on, and no navigation has started or ended since.
    if (
      !target ||
      window.location.href !== from ||
      $navigating !== navigationAtClick
    ) {
      return;
    }
    const to = { route: { id: target.id }, params: target.params };
    if (!isAnotherZPage(to, routeId, vanity)) return;
    const prediction = {};
    predictedLinkNavigation = prediction;
    await afterDeferredLinkNavigation();
    if (predictedLinkNavigation === prediction) predictedLinkNavigation = null;
  }

  onMount(() => {
    // Capture sees handlers that prevented the click during capture. Svelte 5
    // delegated onclick handlers run in the bubble phase at their event root;
    // the body listener observes those handlers before SvelteKit's `<html>`
    // router listener claims the link. When a portaled handler only reaches
    // Svelte's document fallback after the router, the capture-phase wrapper
    // counts its preventDefault call and beforeNavigate cancels that route.
    const preventedBeforeRouter = new WeakSet<MouseEvent>();
    const preventDefaultCalls = new WeakMap<MouseEvent, number>();
    const captureBeforeRouter = (event: MouseEvent) => {
      preventDefaultCalls.set(event, 0);
      const preventDefault = event.preventDefault.bind(event);
      event.preventDefault = () => {
        preventDefaultCalls.set(
          event,
          (preventDefaultCalls.get(event) ?? 0) + 1,
        );
        preventDefault();
      };
      if (event.defaultPrevented) preventedBeforeRouter.add(event);
    };
    const observeBeforeRouter = (event: MouseEvent) => {
      if (event.defaultPrevented) preventedBeforeRouter.add(event);
    };
    const afterRouter = (event: MouseEvent) => {
      if (preventedBeforeRouter.has(event)) return;
      // A portal outside Svelte's app root reaches its document fallback only
      // after SvelteKit's <html> router. When both handlers called
      // preventDefault, cancel that already-queued route in beforeNavigate.
      if ((preventDefaultCalls.get(event) ?? 0) > 1) {
        const url = clientRoutedLinkUrl(
          event,
          window.location.href,
          document.baseURI,
        );
        if (url) {
          latePreventedLinkClicks.add(event);
          return;
        }
      }
      void predictZPageLinkNavigation(event);
    };
    const markPageUnloading = () => {
      pageIsUnloading = true;
      if (fullPageNavigationTimer !== null) {
        clearTimeout(fullPageNavigationTimer);
        fullPageNavigationTimer = null;
      }
    };
    const markPageVisible = () => {
      pageIsUnloading = false;
    };
    const startFullPageNavigationGracePeriod = () => {
      const navigation = $navigating;
      if (!navigation) return;
      if (fullPageNavigationTimer !== null) {
        clearTimeout(fullPageNavigationTimer);
      }
      pendingFullPageNavigation = navigation;
      const hrefAtStart = window.location.href;
      fullPageNavigationTimer = setTimeout(() => {
        fullPageNavigationTimer = null;
        if (
          canReleaseFullPageNavigationFallback(
            navigation,
            $navigating,
            hrefAtStart,
            window.location.href,
            pageIsUnloading,
          )
        ) {
          settledFullPageNavigation = navigation;
        }
      }, FULL_PAGE_NAVIGATION_SETTLE_GRACE_MS);
    };
    document.addEventListener("click", captureBeforeRouter, true);
    document.body.addEventListener("click", observeBeforeRouter);
    window.addEventListener("click", afterRouter);
    window.addEventListener("beforeunload", startFullPageNavigationGracePeriod);
    window.addEventListener("pagehide", markPageUnloading);
    window.addEventListener("pageshow", markPageVisible);
    return () => {
      document.removeEventListener("click", captureBeforeRouter, true);
      document.body.removeEventListener("click", observeBeforeRouter);
      window.removeEventListener("click", afterRouter);
      window.removeEventListener(
        "beforeunload",
        startFullPageNavigationGracePeriod,
      );
      window.removeEventListener("pagehide", markPageUnloading);
      window.removeEventListener("pageshow", markPageVisible);
      if (fullPageNavigationTimer !== null) {
        clearTimeout(fullPageNavigationTimer);
        fullPageNavigationTimer = null;
      }
    };
  });

  // The skeleton keeps the outgoing document's height, and sits sticky inside
  // it. SvelteKit records the scroll position of the page being left only
  // AFTER the new load resolves (`update_scroll_positions` follows
  // `await load_route` in its client); a shorter document would make the
  // browser clamp scrollY first, and Back would restore that clamped value
  // instead of where the reader was. A `$:` block runs before the DOM
  // update, so this still measures the article, not the skeleton.
  let mainEl: HTMLElement | undefined;
  let heldPageHeight: number | null = null;
  $: heldPageHeight = switchingZPage ? measureOutgoingPage() : null;
  function measureOutgoingPage() {
    return mainEl ? Math.ceil(mainEl.getBoundingClientRect().height) : null;
  }

  $: pageKey = article?.free2zaddr ?? $currentPage.params.vanity ?? "";
  // Starts unset, so the first run only re-affirms the SSR default.
  let heroFitPageKey: string | undefined;
  $: if (pageKey !== heroFitPageKey) {
    heroFitPageKey = pageKey;
    heroFit = "contain";
  }

  // member_price is NOT NULL and "0" is a free membership; null
  // only arrives for a redacted (deactivated) creator.
  $: canSubscribe =
    article?.creator?.member_price != null &&
    $authStore.creator?.username !== article?.creator?.username;

  $: readingTime = article?.content
    ? Math.max(1, Math.round(article.content.trim().split(/\s+/).length / 220))
    : 0;

  $: imageUrl = buildImageUrl(article);
  $: thumbnailUrl = buildThumbnailUrl(article);
  $: avatarUrl = buildAvatarUrl(article);
  $: authorName = buildAuthorName(article);
  $: createdDate = formatDate(article?.created_at);
  $: pageMeta = buildZPageMeta(article, {
    loading: switchingZPage,
  });
  $: jsonLdString = pageMeta.jsonLdString ?? null;
  // Keep this split: svelte-eslint-parser mistakes a literal closing script
  // tag in the JSON-LD expression for the end of this component's script block.
  const jsonLdClosingTag = "</" + "script>";
</script>

<svelte:head>
  <title>{pageMeta.title}</title>
  {#if pageMeta.canonical}
    <link rel="canonical" href={pageMeta.canonical} />
  {/if}
  <!-- One entry per named variant, closing with `x-default` on the clean URL
       that serves the source variant — what a search engine falls back to when
       none of the listed languages matches the searcher. -->
  {#each pageMeta.alternates as alternate}
    <link rel="alternate" hreflang={alternate.hreflang} href={alternate.href} />
  {/each}
  <!-- Written out attribute-by-attribute rather than as `<meta {...tag.props}>`
       on purpose. A spread hides the attribute names from the compiler, so
       Svelte cannot prove the element will never match this component's scoped
       `<style>` and defensively stamps every one of these tags with the scoping
       class — production really did serve
       `<meta property="og:description" … class="svelte-pq5o27"/>`. Harmless to
       parsers, but this is about to be the *only* tier producing social cards
       ( phase 3), so it should not ship junk it does not need. -->
  {#each pageMeta.tags as tag}
    {#if tag.props.property}
      <meta property={tag.props.property} content={tag.props.content} />
    {:else}
      <meta name={tag.props.name} content={tag.props.content} />
    {/if}
  {/each}
  {#if jsonLdString}
    {@html `<script type="application/ld+json">${jsonLdString}${jsonLdClosingTag}`}
  {/if}
</svelte:head>

<main
  bind:this={mainEl}
  class="relative flex flex-1 flex-col bg-background text-foreground"
  use:scrollScene={{ article: articleEl, progress: progressEl }}
>
  <!-- Reading Progress. `scaleX` rather than `width`: the old version animated
       a layout property on every scroll frame. -->
  <div class="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5">
    <div
      bind:this={progressEl}
      class="reading-progress h-full w-full origin-left bg-primary"
      class:invisible={switchingZPage}
      aria-hidden={switchingZPage}
    ></div>
  </div>

  {#if switchingZPage}
    <!-- The same boxes as the article below — hero height, headline, byline,
         body column — so nothing jumps when the new page replaces it. Held at
         the outgoing page's height, with the boxes sticky, so the reader's
         scroll position survives (see `heldPageHeight`). -->
    <div
      data-testid="zpage-loading"
      class="flex flex-1 flex-col"
      style:min-height={heldPageHeight ? `${heldPageHeight}px` : undefined}
      role="status"
      aria-busy="true"
    >
      <span class="sr-only">{$t("article.loading", "Loading story…")}</span>
      <div class="sticky top-0">
        <section
          class="zhero zhero--media relative flex flex-col overflow-hidden"
          aria-hidden="true"
        >
          <Skeleton class="absolute inset-0 rounded-none" />
          <div
            class="relative mx-auto flex w-full max-w-5xl items-center px-4 pt-4 sm:px-6 lg:px-8"
          >
            <Skeleton
              class="size-9 rounded-full bg-foreground/10 sm:h-8 sm:w-40"
            />
          </div>
          <div
            class="relative mx-auto mt-auto w-full max-w-5xl px-4 pt-10 pb-8 sm:px-6 lg:px-8"
          >
            <Skeleton class="h-8 w-4/5 bg-foreground/10 sm:h-10" />
            <Skeleton class="mt-3 h-5 w-3/5 bg-foreground/10" />
            <div class="mt-6 flex items-center gap-3">
              <Skeleton
                data-testid="zpage-loading-avatar"
                class="size-10 shrink-0 rounded-full bg-foreground/10"
              />
              <div class="flex flex-col gap-1.5">
                <Skeleton class="h-4 w-28 bg-foreground/10" />
                <Skeleton class="h-3 w-40 bg-foreground/10" />
              </div>
            </div>
          </div>
        </section>
        <section class="relative pt-10 pb-28" aria-hidden="true">
          <div class="mx-auto max-w-[800px] px-4 sm:px-6">
            <div class="mx-auto max-w-[65ch] space-y-4">
              {#each [100, 95, 98, 70, 100, 92, 85, 60] as width}
                <Skeleton class="h-4" style={`width: ${width}%`} />
              {/each}
            </div>
          </div>
        </section>
      </div>
    </div>
  {/if}

  <!-- The outgoing article is HIDDEN during the skeleton, never unmounted:
       the comment form, the subscribe control and the action button can each
       own an in-flight paid request, and those instances have always survived
       a zPage -> zPage navigation. An inline style, so no utility-order
       question arises against `flex`. -->
  <!-- Immersive Hero -->
  <section
    data-hero-fit={heroFit}
    style:display={switchingZPage ? "none" : undefined}
    class="zhero relative flex flex-col overflow-hidden {imageUrl
      ? 'zhero--media'
      : 'w-full'}"
  >
    {#if imageUrl}
      <!-- The measured fit is bound up (see `heroFit`) so the scoped rules
           below can give the headline a treatment per fit without reaching
           across the component boundary with:global(). -->
      {#key pageKey}
        <ZPageHeroMedia
          bind:fit={heroFit}
          src={imageUrl}
          mobileSrc={thumbnailUrl && thumbnailUrl !== imageUrl
            ? thumbnailUrl
            : null}
          alt={article?.featured_image?.title || article?.title || ""}
        />
      {/key}
    {/if}

    <!-- Topbar: Back + Category.
         `z-10` is a fix, not decoration. The headline block is bottom-anchored
         but its height is its content's, so a tall headline — a five-line
         title, or one with a description and a subscribe control — starts high
         enough to reach these controls. It is later in tree order and
         positioned, so without a z-index it paints OVER them. That was true of
         the `contain`-fit band (which additionally took them as the backdrop
         its `blur(14px)` operated on, washing them out while
         `pointer-events: none` kept them clickable) and it stays true of the
         headline's own text and of the glyph pad's halo now that the band is
         gone. Navigation wins over decoration. Comfortably below the app
         navbar (`z-50`) and the reading-progress bar (`z-[60]`). -->
    <div
      class="relative z-10 mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 pt-4 sm:px-6 lg:px-8"
    >
      <Button
        variant="ghost"
        size="sm"
        onclick={goBack}
        aria-label={!$loading
          ? $t("common.article.backToHome")
          : "Back to stories"}
        title={!$loading ? $t("common.article.backToHome") : "Back to stories"}
        class="group relative size-9 shrink-0 rounded-full border border-border bg-background/60 p-0 text-muted-foreground backdrop-blur-md after:absolute after:-inset-1 after:content-[''] hover:text-foreground sm:h-8 sm:w-auto sm:gap-2 sm:px-3 sm:after:inset-0"
      >
        <ArrowLeft
          class="size-4 transition-transform group-hover:-translate-x-0.5"
          aria-hidden="true"
        />
        <span class="hidden sm:inline">
          {!$loading ? $t("common.article.backToHome") : "Back to stories"}
        </span>
      </Button>
      {#if article?.category}
        <Badge
          variant="outline"
          class="h-6 max-w-[45vw] rounded-md bg-background/60 px-2 py-0 text-[11px] font-semibold tracking-wide text-muted-foreground backdrop-blur-md sm:h-auto sm:max-w-none sm:rounded-full sm:py-0.5 sm:text-xs sm:tracking-normal"
        >
          <span class="truncate">{article.category}</span>
        </Badge>
      {/if}
      {#if availableArticleLanguages.length > 1}
        <!-- An explicit `for`/`id` pairing rather than an `aria-label` on the
             select: the accessible name then matches the visible text, so
             "click Article language" works for voice control. The focus ring
             is restored — the old `outline-none` left keyboard users with no
             visible focus at all.  -->
        <div
          class="flex items-center gap-2 rounded-md border border-border bg-background/70 px-2 py-1 text-xs backdrop-blur-md"
        >
          <!-- `lang` on the chrome, not on the page: `<html lang>` now names the
               ARTICLE's language, so every scrap of UI text inside it has to
               declare the UI locale or be announced in the article's language
               . -->
          <label class="shrink-0" lang={$locale} for="article-language">
            {$t("article.language", "Article language")}
          </label>
          <select
            id="article-language"
            value={articleContentLanguage ||
              ((article as any).actual_language === "und" ? "und" : "") ||
              data.articleLanguage}
            onchange={chooseArticleLanguage}
            aria-describedby={fallbackDisclosure
              ? "article-language-fallback"
              : undefined}
            class="rounded-sm bg-transparent font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {#each availableArticleLanguages as language}
              <option
                value={language}
                lang={language === "und" ? undefined : language}
              >
                {language === "und"
                  ? $t(
                      "article.originalLanguageUnknown",
                      "Original (language unknown)",
                    )
                  : languageDisplayName(language, $locale) || language}
              </option>
            {/each}
          </select>
        </div>
      {/if}
    </div>

    <!-- Title Block (anchored to the bottom of the cover).
         Two elements rather than one: the outer is full-bleed so the
         headline's treatment can span the viewport instead of ending in a
         hard edge at `max-w-5xl` on a wide screen. Which treatment is keyed
         off the hero's measured fit (`data-hero-fit` above, ): in
         `cover` it keeps the gradient ramp, because there the text genuinely
         sits on a cropped photograph; in `contain` the whole cover stays
         visible and this block paints NO background at all — the contrast
         comes from a pad that hugs the glyphs on `.zhero__content`, so the
         picture is never behind a rectangle. -->
    <div class="zhero__headline relative mt-auto w-full">
      <!-- Position the headline above the isolated photographic layers. -->
      <div
        class="zhero__content relative mx-auto w-full max-w-5xl px-4 pt-10 pb-8 sm:px-6 lg:px-8"
      >
        <!-- `dir` on the headline, not only `lang`. It is also what isolates
             it: HTML's UA stylesheet gives any element with an explicit `dir`
             `unicode-bidi: isolate`, so an Arabic title inside this LTR page
             can no longer reorder against the chrome around it. -->
        <h1
          lang={articleContentLanguage}
          dir={articleContentDirection}
          data-content-lang={articleContentLanguage}
          class="text-3xl leading-[1.15] font-bold tracking-tight text-balance sm:text-4xl"
        >
          {article?.title}
        </h1>

        {#if article?.description}
          <p
            lang={articleContentLanguage}
            dir={articleContentDirection}
            data-content-lang={articleContentLanguage}
            class="mt-3 max-w-2xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg"
          >
            {article.description}
          </p>
        {/if}

        <!-- Fallback disclosure: one muted line, in the reader's UI language,
           naming both languages. Never an alert above the headline. -->
        {#if fallbackDisclosure}
          <p
            id="article-language-fallback"
            lang={$locale}
            class="mt-3 max-w-2xl text-xs text-muted-foreground"
          >
            {$t(
              "article.fallbackNotice",
              "Not available in {requested} — showing the {shown} version.",
              fallbackDisclosure,
            )}
          </p>
        {/if}

        <!-- Meta Row: Author + Date + Stats -->
        <div
          class="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3"
        >
          <div class="group flex items-center gap-3">
            <a
              href={"/" + (article?.creator?.username || "")}
              rel="author"
              title={`View ${authorName}'s profile`}
              class="block h-10 w-10 shrink-0 overflow-hidden rounded-full border border-primary/20 bg-muted ring-2 ring-transparent ring-offset-2 ring-offset-background transition-all [text-shadow:none] group-has-[a:hover]:ring-primary/40"
            >
              {#if avatarUrl}
                {#key pageKey}
                  <img
                    src={avatarUrl}
                    alt={authorName}
                    class="h-full w-full object-cover"
                  />
                {/key}
              {:else}
                <div
                  class="flex h-full w-full items-center justify-center bg-primary text-sm font-bold text-primary-foreground"
                >
                  {authorName.charAt(0).toUpperCase()}
                </div>
              {/if}
            </a>
            <div class="flex flex-col">
              <a
                href={"/" + (article?.creator?.username || "")}
                rel="author"
                title={`View ${authorName}'s profile`}
                class="zhero__author-name w-fit text-sm font-semibold text-foreground transition-colors group-has-[a:hover]:text-primary"
              >
                <!-- A display name is arbitrary user text sitting in a row
                     of LTR chrome, so it is isolated from it. Honest
                     scope: in THIS markup the name is alone in its own block,
                     and measuring it showed no reorder today. Put it next to a
                     neutral in the same inline run -- a separator, a count,
                     a second name -- and an RTL name drags that neutral across
                     with it. The PR body has the measurement. -->
                <bdi>{authorName}</bdi>
              </a>
              <span class="text-xs text-muted-foreground">
                {createdDate}{#if readingTime}
                  · {readingTime} min read{/if}
              </span>
            </div>
          </div>

          {#if article?.total_raised || hasScore(pageScore) || canSubscribe}
            <div
              class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
            >
              {#if article?.total_raised}
                <span
                  data-testid="zpage-hero-raised"
                  class="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background/60 px-3 tabular-nums backdrop-blur-md"
                >
                  <Coins class="size-4 text-primary" />
                  {formatCompact(article.total_raised)} ZEC raised
                </span>
              {/if}
              {#if hasScore(pageScore)}
                <span
                  data-testid="zpage-hero-score"
                  class="inline-flex h-8 w-28 shrink-0 items-center justify-center gap-1 rounded-md border border-border bg-background/60 px-2.5 text-xs leading-none tracking-tight whitespace-nowrap tabular-nums backdrop-blur-md sm:h-9 sm:w-32 sm:gap-1.5 sm:px-3 sm:text-sm"
                >
                  <Sparkles class="size-3.5 text-primary sm:size-4" />
                  {formatCompact(pageScore ?? 0)} score
                </span>
              {/if}
              {#if canSubscribe}
                <ProfileSubscribe
                  creator={article.creator}
                  navigationPending={leavingZPage}
                  triggerSize="sm"
                  triggerVariant="default"
                  triggerClass="[text-shadow:none] relative !h-7 !w-24 !rounded-md !bg-primary px-2 text-xs font-semibold text-primary-foreground hover:!bg-primary/90 after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] sm:!h-8 sm:!w-28 sm:px-2.5 sm:text-sm sm:after:-inset-y-1.5 [&_svg]:!size-3.5 sm:[&_svg]:!size-4 [&_svg]:text-primary-foreground"
                />
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>
  </section>

  <!-- Table of Contents -->
  <div class="contents" style:display={switchingZPage ? "none" : undefined}>
    <TableOfContents target={articleEl} />
  </div>

  <!-- Article Content -->
  <section
    class="relative pt-10 pb-28"
    style:display={switchingZPage ? "none" : undefined}
  >
    <div class="mx-auto max-w-[800px] px-4 sm:px-6">
      {#if data.gated}
        <section
          bind:this={articleEl}
          class="mb-16 rounded-lg border border-border bg-muted/30 px-5 py-10 text-center sm:px-10"
          aria-labelledby="subscriber-gate-title"
        >
          <div
            class="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10"
          >
            <LockKeyhole class="size-6 text-primary" />
          </div>
          <h2
            id="subscriber-gate-title"
            class="mt-5 text-2xl font-semibold tracking-tight"
          >
            Subscriber-only story
          </h2>
          <p
            class="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground"
          >
            Subscribe to @<bdi>{article?.creator?.username}</bdi> to read this story
            and support their ongoing work.
          </p>
          {#if article?.creator?.member_price != null}
            <p class="mt-3 text-sm font-medium tabular-nums">
              {Number(article.creator.member_price) > 0
                ? `${Number(article.creator.member_price)} 2Z per month`
                : "Free to follow"}
            </p>
          {/if}
          <div class="mt-6 flex justify-center">
            <ProfileSubscribe
              creator={article.creator}
              navigationPending={leavingZPage}
              triggerSize="default"
              triggerClass="font-medium"
            />
          </div>
        </section>
      {:else}
        <!-- The container the whole defect was about: we have been selling
             `ar`/`he`/`fa`/`ur` translations and rendering them here with no
             direction at all. Server-rendered, so the first painted
             HTML is already right — not corrected after hydration. -->
        <article
          bind:this={articleEl}
          lang={articleContentLanguage}
          dir={articleContentDirection}
          data-content-lang={articleContentLanguage}
          class="mx-auto prose prose-lg mb-16 max-w-[65ch] prose-zinc dark:prose-invert prose-h1:text-3xl prose-h1:tracking-tight prose-a:text-primary prose-a:no-underline prose-a:hover:text-primary/80 prose-a:hover:underline"
        >
          {#if processedContent}
            <MarkdownContent html={processedContent} />
          {:else}
            <p class="py-5 text-center text-sm text-muted-foreground">
              No content available for this article.
            </p>
          {/if}
        </article>
      {/if}

      <!-- Tags -->
      {#if article?.tags && article.tags.length > 0}
        <div class="mb-16 border-t border-border pt-8">
          <h3
            class="mb-4 flex items-center gap-2 text-sm font-semibold text-muted-foreground"
          >
            <Tag class="size-4" />
            {$t("article.tags", "Tags")}
          </h3>
          <div class="flex flex-wrap gap-2">
            {#each article.tags as tag}
              <!-- `?tag=` is a tag filter; the `?q=` this replaced was a
                   full-text search that merely happened to contain the word,
                   so "zcash" also returned every article that says "zcash". -->
              <a
                href={tagHref(tag)}
                data-testid="article-tag"
                class="inline-flex min-h-11 items-center rounded-md border border-border bg-muted/50 px-3 py-2 text-sm font-medium no-underline transition-colors hover:bg-accent"
              >
                <!-- The `#` is ours and stays on the left; the tag is the
                     creator's and may run the other way. Unisolated, `#` is a
                     neutral character that joins the RTL run beside it and
                     renders on the far side of the chip, so the label reads as
                     a different string than the one that was typed. -->
                #<bdi>{tag}</bdi>
              </a>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Series navigation follows the article metadata. -->
      {#await data.seriesContext}
        <Skeleton class="mb-16 h-40 w-full rounded-lg" />
      {:then series}
        {#if series}
          <!-- Series nav is chrome: UI locale, not the article's. -->
          <nav
            lang={$locale}
            class="mb-16 border-t border-border pt-8"
            aria-label={`Part ${series.position} of ${series.name}`}
          >
            <div
              class="overflow-hidden rounded-lg bg-card text-card-foreground"
            >
              <div class="p-4 sm:p-5">
                <div class="flex items-center justify-between gap-4">
                  <div class="flex min-w-0 items-center gap-3">
                    <span
                      class="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
                      aria-hidden="true"
                    >
                      <BookOpen class="size-4.5" />
                    </span>
                    <div class="min-w-0">
                      <p class="text-sm font-medium text-foreground/65">
                        In this series
                      </p>
                      <p
                        class="mt-0.5 truncate text-base font-semibold tracking-tight sm:text-lg"
                      >
                        {series.name}
                      </p>
                    </div>
                  </div>

                  <span
                    class="shrink-0 rounded-md bg-muted px-2.5 py-1 text-sm font-medium text-foreground/70 tabular-nums"
                  >
                    {series.position} of {series.count}
                  </span>
                </div>

                <div
                  class="mt-4 h-1 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label={`Series progress: part ${series.position} of ${series.count}`}
                  aria-valuemin="1"
                  aria-valuemax={series.count}
                  aria-valuenow={series.position}
                >
                  <div
                    class="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
                    style={`width: ${Math.min(100, Math.max(0, (series.position / series.count) * 100))}%`}
                  ></div>
                </div>
              </div>

              <details class="group border-t border-border" open={false}>
                <summary
                  class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium transition-colors duration-200 hover:bg-muted/70 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset active:bg-muted sm:px-5 [&::-webkit-details-marker]:hidden"
                >
                  <span>View all {series.count} parts</span>
                  <ChevronDown
                    class="size-4 shrink-0 text-foreground/60 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                </summary>

                <ol class="border-t border-border bg-background/40 p-2">
                  {#each series.pages as seriesPage, index (seriesPage.free2zaddr)}
                    <li>
                      {#if seriesPage.free2zaddr === article.free2zaddr}
                        <div
                          class="flex min-w-0 items-start gap-3 rounded-md bg-primary/10 px-3 py-2.5"
                          aria-current="page"
                        >
                          <span
                            class="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/25 text-sm font-semibold text-foreground tabular-nums"
                          >
                            {index + 1}
                          </span>
                          <span class="min-w-0 flex-1">
                            <span
                              class="line-clamp-2 block text-sm leading-snug font-semibold"
                            >
                              {seriesPage.title}
                            </span>
                            <span
                              class="mt-0.5 block text-sm font-medium text-foreground/70"
                            >
                              Current part
                            </span>
                          </span>
                        </div>
                      {:else}
                        <a
                          href={seriesPage.url}
                          class="group/part flex min-w-0 items-start gap-3 rounded-md px-3 py-2.5 transition-colors duration-200 hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:bg-muted/80"
                        >
                          <span
                            class="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-medium text-foreground/70 tabular-nums transition-colors duration-200 group-hover/part:bg-primary/15 group-hover/part:text-foreground"
                          >
                            {index + 1}
                          </span>
                          <span
                            class="min-w-0 flex-1 pt-0.5 text-sm leading-snug font-medium decoration-primary underline-offset-4 transition-colors duration-200 group-hover/part:underline"
                          >
                            {seriesPage.title}
                          </span>
                          <ChevronRight
                            class="mt-1 size-3.5 shrink-0 text-foreground/50 transition-transform duration-200 group-hover/part:translate-x-0.5 group-hover/part:text-primary motion-reduce:transition-none"
                            aria-hidden="true"
                          />
                        </a>
                      {/if}
                    </li>
                  {/each}
                </ol>
              </details>

              <div
                class="grid border-t border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 sm:divide-border"
              >
                {#if series.previous}
                  <a
                    href={series.previous.url}
                    class="group flex min-w-0 items-center gap-3 p-4 transition-colors duration-200 hover:bg-muted/70 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset active:bg-muted sm:p-5"
                  >
                    <ChevronLeft
                      class="size-4 shrink-0 text-foreground/60 transition-transform duration-200 group-hover:-translate-x-0.5 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                    <span class="min-w-0">
                      <span
                        class="block text-sm font-medium text-foreground/65"
                      >
                        Previous part
                      </span>
                      <span
                        class="mt-1 line-clamp-2 block text-sm leading-snug font-semibold decoration-primary underline-offset-4 transition-colors duration-200 group-hover:underline"
                      >
                        {series.previous.title}
                      </span>
                    </span>
                  </a>
                {:else}
                  <div
                    class="flex min-w-0 items-center gap-3 p-4 text-foreground/60 sm:p-5"
                  >
                    <BookOpen class="size-4 shrink-0" aria-hidden="true" />
                    <span>
                      <span class="block text-sm font-medium">
                        Series beginning
                      </span>
                      <span
                        class="mt-1 block text-sm font-semibold text-foreground"
                      >
                        You’re reading the first part
                      </span>
                    </span>
                  </div>
                {/if}

                {#if series.next}
                  <a
                    href={series.next.url}
                    class="group flex min-w-0 items-center justify-between gap-3 border-t border-border p-4 transition-colors duration-200 hover:bg-muted/70 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset active:bg-muted sm:border-t-0 sm:p-5 sm:text-right"
                  >
                    <span class="min-w-0 sm:ml-auto">
                      <span
                        class="block text-sm font-medium text-foreground/65"
                      >
                        Next part
                      </span>
                      <span
                        class="mt-1 line-clamp-2 block text-sm leading-snug font-semibold decoration-primary underline-offset-4 transition-colors duration-200 group-hover:underline"
                      >
                        {series.next.title}
                      </span>
                    </span>
                    <ChevronRight
                      class="size-4 shrink-0 text-foreground/60 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  </a>
                {:else}
                  <div
                    class="flex min-w-0 items-center justify-between gap-3 border-t border-border p-4 text-foreground/60 sm:border-t-0 sm:p-5 sm:text-right"
                  >
                    <span class="min-w-0 sm:ml-auto">
                      <span class="block text-sm font-medium">
                        Series complete
                      </span>
                      <span
                        class="mt-1 block text-sm font-semibold text-foreground"
                      >
                        You’ve reached the final part
                      </span>
                    </span>
                    <BookOpen class="size-4 shrink-0" aria-hidden="true" />
                  </div>
                {/if}
              </div>
            </div>
          </nav>
        {/if}
      {:catch}
        {null}
      {/await}

      {#if !data.gated}
        <!-- Comments Section -->
        <div class="mb-12 border-t border-border pt-6" use:deferComments>
          {#if CommentFormComponent && DisplayThreadedCommentsComponent}
            <div class="mb-8">
              <CommentFormComponent
                object_type="zpage"
                object_uuid={article?.free2zaddr}
                callback={handleCommentSuccess}
              />
            </div>

            <DisplayThreadedCommentsComponent
              object_type="zpage"
              object_uuid={article?.free2zaddr}
              reload={reloadComments}
            />
          {:else}
            <div
              class="space-y-4"
              aria-label="Loading discussion"
              aria-busy="true"
            >
              <Skeleton class="h-24 w-full rounded-lg" />
              <Skeleton class="h-20 w-full rounded-lg" />
            </div>
          {/if}
        </div>
      {/if}

      <!-- Related Articles -->
      {#await data.relatedArticles}
        <div lang={$locale} class="mb-12 border-t border-border pt-8">
          <h3 class="m-0 mb-4 text-xl font-semibold tracking-tight">
            {!$loading
              ? $t("common.article.relatedArticles")
              : "Related articles"}
          </h3>
          <div class="space-y-4" aria-busy="true">
            <div class="flex items-center justify-between gap-4">
              <Skeleton class="h-4 w-56" />
              <div class="flex items-center gap-2">
                <Skeleton class="size-10" />
                <Skeleton class="size-10" />
              </div>
            </div>
            <div class="-mx-1 flex gap-4 overflow-hidden px-1 pb-2">
              {#each Array.from({ length: 3 }) as _}
                <div
                  class="w-[85%] min-w-[85%] sm:w-[calc(50%_-_0.5rem)] sm:min-w-[calc(50%_-_0.5rem)]"
                >
                  <Skeleton class="h-72 w-full rounded-lg" />
                </div>
              {/each}
            </div>
          </div>
        </div>
      {:then relatedArticles}
        {#if relatedArticles.length > 0}
          <div lang={$locale} class="mb-12 border-t border-border pt-8">
            <h3 class="m-0 mb-4 text-xl font-semibold tracking-tight">
              {!$loading
                ? $t("common.article.relatedArticles")
                : "Related articles"}
            </h3>
            <div class="space-y-4">
              {#if relatedArticles.length > 1}
                <div class="flex items-center justify-between gap-4">
                  <p class="text-sm text-muted-foreground">
                    {!$loading
                      ? $t("common.article.relatedArticlesSwipeHint")
                      : "Browse more related articles."}
                  </p>
                  <div class="flex items-center gap-3">
                    <Button
                      variant="outline"
                      size="icon-sm"
                      class="relative size-8 after:absolute after:-inset-1.5 after:content-['']"
                      onclick={() => scrollRelated(-1)}
                      disabled={!canScrollRelatedPrev}
                      aria-label={!$loading
                        ? $t("common.article.previousRelatedArticles")
                        : "Previous related articles"}
                    >
                      <ChevronLeft class="size-4" aria-hidden="true" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      class="relative size-8 after:absolute after:-inset-1.5 after:content-['']"
                      onclick={() => scrollRelated(1)}
                      disabled={!canScrollRelatedNext}
                      aria-label={!$loading
                        ? $t("common.article.nextRelatedArticles")
                        : "Next related articles"}
                    >
                      <ChevronRight class="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              {/if}

              <div
                use:trackRelatedScroller
                aria-label={!$loading
                  ? $t("common.article.relatedArticlesRegion")
                  : "Related articles"}
                class="-mx-1 flex snap-x snap-mandatory scrollbar-none gap-4 overflow-x-auto px-1 pb-2"
                role="region"
              >
                {#each relatedArticles as relatedArticle (relatedArticle.free2zaddr)}
                  <div
                    class="w-[85%] min-w-[85%] snap-start sm:w-[calc(50%_-_0.5rem)] sm:min-w-[calc(50%_-_0.5rem)]"
                  >
                    <RelatedZpageCard story={relatedArticle} />
                  </div>
                {/each}
              </div>
            </div>
          </div>
        {/if}
      {:catch}
        {null}
      {/await}
    </div>
  </section>
</main>

<!-- Floating Action Button. Hidden, never unmounted, for the page being
     left: a boost started during the load would go to the wrong zPage, and
     one already in flight must keep its component. -->
<div class="contents" style:display={switchingZPage ? "none" : undefined}>
  <PageActions
    {article}
    score={pageScore}
    onScoreChange={handleScoreChange}
    navigationPending={leavingZPage}
  />
</div>

<!-- One live region owns boost announcements; visible score surfaces are not
     live so the committed score is announced once without duplicate speech. -->
<span
  data-testid="score-announcement"
  class="sr-only"
  role="status"
  aria-live="polite"
  aria-atomic="true"
>
  {scoreAnnouncement}
</span>

<style>
  .scrollbar-none {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }

  .scrollbar-none::-webkit-scrollbar {
    display: none;
  }

  .reading-progress {
    transform: scaleX(0);
    will-change: transform;
  }

  /*
   * The hero's height is reserved up front and never depends on the image, so
   * a featured image that arrives late — or never — shifts nothing. The `svh`
   * unit is load-bearing rather than stylistic: on mobile, `vh` changes when
   * the browser chrome collapses mid-scroll, which would resize the hero (and
   * so re-size the image) in the middle of a flick. `svh` is pinned to the
   * chrome-expanded viewport and does not move. The shared token has plain
   * `rem` values by default and assigns its clamps only inside an `@supports`
   * block, so engines without `svh` keep a genuine fallback instead of
   * invalidating the custom property at computed-value time.
   */
  .zhero--media {
    /* The app shell pads the page by 8px below `md` (see +layout.svelte), and
       a hero that stops 8px short of the edge is not a hero. `width` is left
       to the flex stretch, so the negative margin simply widens it. */
    margin-inline: -0.5rem;
    min-height: var(--f2z-editorial-hero-height);
  }

  @media (min-width: 768px) {
    .zhero--media {
      margin-inline: 0;
    }
  }

  /*
   * `cover` fit: the contrast guarantee, and the reason it lives here rather
   * than in the media layers. This is the one fit where the headline truly
   * sits ON the photograph (the phone-panorama case), so a text-anchored ramp
   * is load-bearing and is kept exactly as shipped. It has to be anchored to
   * the *text*, not to a percentage of the hero: the headline block is
   * bottom-anchored and its height depends on the title's length, the
   * description, the byline and whether a subscribe button is present, so any
   * percentage stop that is safe for a one-line title is far too weak for a
   * three-line one.
   *
   * Fixed `rem` stops measured down from the block's top edge make the ramp
   * independent of all of that: the `h1` starts at 4.5rem (2.5rem of padding
   * plus the 2rem added below), by which point the scrim is ~88% of the page
   * background, and everything below the `h1` is stronger still. Measured
   * end-to-end in `tests/browser/zpage-hero.spec.ts`, which screenshots the
   * pixels behind the headline over a near-white and a near-black image, in
   * both themes, at four scroll positions, and fails below 4.5:1.
   */
  .zhero--media .zhero__headline {
    padding-top: 2rem;
    background: linear-gradient(
      to bottom,
      transparent 0,
      var(--background) 4.5rem
    );
    background: linear-gradient(
      to bottom,
      transparent 0,
      color-mix(in oklab, var(--background) 45%, transparent) 1.75rem,
      color-mix(in oklab, var(--background) 78%, transparent) 3.25rem,
      color-mix(in oklab, var(--background) 88%, transparent) 4.5rem,
      var(--background) 7.5rem
    );
  }

  /*
   * `contain` fit: the whole featured image stays visible, so this
   * block paints NOTHING of its own. Not a gradient laid across the photo
   *, and — since this change — not a band either.
   *
   * The band is what  left here and what the owner reported next: a
   * full-width translucent slab, `--background` at 72% with a `blur(14px)`
   * behind it, covering the bottom of the artwork. On the reference page
   * (/ZcashInside/cypherpunk-zero-1869-benjamin-e-un-caffe-a-parigi) that is
   * the character's body, the book and the hands. Softening the slab's top
   * edge into a long ramp — which is all  did — makes the boundary
   * pleasant without making the picture visible: the lower half of the image
   * is still behind a wash either way. The band is now gone entirely and the
   * contrast it was carrying moved onto the glyphs themselves; see the
   * `.zhero__content` pad rule below.
   *
   * `background: none` is what makes "this block paints nothing" TRUE, and it
   * has to stay. The comment above has claimed that the block has
   * no background of its own in `contain` fit; until  the rule only
   * overrode `padding-top`, so the `cover` ramp above kept applying — opaque
   * `--background` from 7.5rem down, i.e. a solid slab over the bottom ~118px
   * of the photograph on a 239px headline. Deleting the band without this line
   * would put that slab straight back.
   *
   * `padding-top` drops to 1.25rem, unchanged from  and now for a
   * different reason. It used to be "there is no background ramp on this
   * element to ramp through"; it is now the clearance the pad needs. The
   * widest `drop-shadow` below is 12px and the `h1`'s own top edge sits
   * 2.5rem (40px) further down inside `.zhero__content`, so the halo above the
   * first line has ~60px of room and never reaches the block's edge — which
   * matters because the block has no box of its own to be clipped against, so
   * a halo that ran out of room would simply be cut by the hero's
   * `overflow: hidden` and read as, once again, a straight line.
   */
  .zhero--media[data-hero-fit="contain"] .zhero__headline {
    padding-top: 1.25rem;
    background: none;
  }

  /*
   * Keep the photograph visible between words and carry contrast on the glyphs.
   * Text shadows are painted with the text, so their raster can scroll as a
   * single surface. The previous nested drop-shadow filters required multiple
   * GPU render passes on every presented frame: headed Chrome at 120 Hz spent
   * 40–50 ms drawing this static hero on its first scroll. The local
   * filters on thin secondary text remain small enough to stay responsive.
   *
   * Repeated narrow shadows build an opaque core; the wider shadows soften its
   * edge. The unfiltered title and author name use six copies of the core to
   * preserve contrast with the thinner glyph rasters of Linux/Arial as well
   * as the macOS system font. Filtered secondary text keeps a lighter pad.
   * The pad follows --background in both themes. Secondary text uses the
   * stronger text token because muted text cannot keep 4.5:1 over a photograph.
   * The pixel contrast matrix guards the title, description, byline and author.
   */
  .zhero--media[data-hero-fit="contain"] .zhero__content {
    --muted-foreground: var(--f2z-text-secondary);
    --hero-glyph-core:
      0 0 4px var(--background), 0 0 4px var(--background),
      0 0 4px var(--background), 0 0 4px var(--background),
      0 0 4px var(--background), 0 0 4px var(--background),
      0 0 4px var(--background), 0 0 4px var(--background),
      0 0 4px var(--background), 0 0 4px var(--background);
    text-shadow:
      var(--hero-glyph-core),
      0 0 6px var(--background),
      0 0 6px var(--background),
      0 0 6px var(--background),
      0 0 6px var(--background),
      0 0 12px var(--background);
  }
  .zhero--media[data-hero-fit="contain"] .zhero__content h1,
  .zhero--media[data-hero-fit="contain"] .zhero__content .zhero__author-name {
    text-shadow:
      var(--hero-glyph-core),
      var(--hero-glyph-core),
      var(--hero-glyph-core),
      var(--hero-glyph-core),
      var(--hero-glyph-core),
      var(--hero-glyph-core),
      0 0 6px var(--background),
      0 0 6px var(--background),
      0 0 6px var(--background),
      0 0 6px var(--background),
      0 0 12px var(--background);
  }
  /* Thin secondary glyphs retain a local pad; unlike the whole headline
     subtree, these small surfaces do not stall the compositor. */
  .zhero--media[data-hero-fit="contain"] .zhero__content p,
  .zhero--media[data-hero-fit="contain"] .zhero__content span {
    filter: drop-shadow(0 0 1px var(--background))
      drop-shadow(0 0 1px var(--background))
      drop-shadow(0 0 2px var(--background));
  }
</style>
