<script lang="ts">
  // @ts-ignore: workaround for "svelte/types/index.d.ts is not a module" in some TS setups
  import { onMount, tick } from "svelte";
  import { browser } from "$app/env";
  import { page } from "$lib/kit-stores";
  import * as env from "$app/env/public";
  import { sanitizeEmbedHtml } from "$lib/utils/embed-sanitize";
  import { getSafeHttpUrl } from "$lib/utils/safe-url";
  import { getTweetEmbedUrl } from "$lib/utils/tweet-embed";
  import {
    classifyFirstPartyEmbed,
    firstPartyFileBadge,
    firstPartyUploadSrc,
  } from "$lib/utils/first-party-embed";
  import {
    privacyStore,
    canLoadUrlFromState,
    embedConsentScope,
    extractDomain,
    isExternalEmbed,
  } from "$lib/stores/privacy";
  import { locale, tStore as t, loading } from "$lib/i18n";
  import { contentDirection } from "$lib/content-direction.js";
  import { Button } from "$lib/components/ui/button";
  import { ShieldCheck } from "@lucide/svelte";
  import MarkdownAudio from "./MarkdownAudio.svelte";
  import MarkdownVideo from "./MarkdownVideo.svelte";

  export let url: string;
  export let title: string | undefined = undefined;
  export let lazy = true; // Use IntersectionObserver for lazy loading
  // Direct third-party media uses this component so it shares the exact same
  // consent, domain trust, dismissal and logical-page scope as every other
  // external embed. The media element itself is not mounted until consent.
  export let mediaType: "audio" | "video" | undefined = undefined;

  /**
   * SECURITY  — `url` arrives from a `data-*-url` attribute that
   * MarkdownContent reads off sanitized markdown, and DOMPurify does NOT apply
   * its URI policy to `data-*`. So a `javascript:` URL can reach this component
   * intact, and this component owns several live URL sinks after consent.
   * `javascript://evil.example/…` even parses with `hostname ===
   * "evil.example"`, so a domain-based grant is not itself URL validation.
   *
   * Everything below therefore uses `safeUrl`, never `url`. Anything that is
   * not an absolute http(s) URL renders nothing at all.
   */
  $: safeUrl = getSafeHttpUrl(url) ?? "";

  /**
   *  our OWN content never reaches the consent card or Iframely. The
   * markdown renderer already renders first-party embeds natively, so this is
   * the second line: pre-rendered HTML, or any future caller that hands this
   * component a first-party URL, still gets the native rendering. Decided by
   * the exact classifier only; everything it refuses stays on the gated path.
   */
  $: firstParty = classifyFirstPartyEmbed(url);
  $: firstPartySrc =
    firstParty && "path" in firstParty
      ? firstPartyUploadSrc(firstParty.path)
      : "";

  let isVisible = false;
  let hasConsent = false;
  let showConsentDialog = false;
  let embedElement: HTMLDivElement;
  let domain = "";
  let consentScope = "";
  let dismissedConsentKey = "";
  let currentUrl = "";
  let isDestroyed = false;
  let iframelyContainer: HTMLDivElement;
  let iframelyLoadKey = "";
  let iframelyLoading = false;
  let iframelyError = false;
  let tweetTheme: "dark" | "light" = "light";
  // X answers a deleted, protected or otherwise missing post with
  // `twttr.private.no_results` and an empty frame. Swap that blank box for
  // the direct link instead of leaving the reader a 600px hole.
  let tweetUnavailable = false;

  const TWEET_FRAME_ORIGIN = "https://platform.twitter.com";
  const MIN_TWEET_FRAME_HEIGHT = 150;
  const MAX_TWEET_FRAME_HEIGHT = 2400;

  type TweetResizeMessage = {
    method?: unknown;
    params?: Array<{ height?: unknown }>;
  };

  /**
   * X's iframe reports its content height over JSON-RPC. Accept resize events
   * only from this exact frame and origin, and clamp provider-controlled
   * dimensions so the embed cannot take over the page. The shell scrolls when
   * the frame exceeds its visible area, keeping the rest of a tall tweet
   * reachable.
   */
  function resizeTweetFrame(node: HTMLIFrameElement) {
    function handleMessage(event: MessageEvent<unknown>) {
      if (
        event.origin !== TWEET_FRAME_ORIGIN ||
        event.source !== node.contentWindow
      ) {
        return;
      }

      if (!event.data || typeof event.data !== "object") return;
      const rpc = (event.data as { "twttr.embed"?: unknown })["twttr.embed"];
      if (!rpc || typeof rpc !== "object") return;

      const message = rpc as TweetResizeMessage;
      if (message.method === "twttr.private.no_results") {
        tweetUnavailable = true;
        return;
      }
      if (message.method !== "twttr.private.resize") return;

      const height = message.params?.[0]?.height;
      if (
        typeof height !== "number" ||
        !Number.isFinite(height) ||
        height <= 0
      ) {
        return;
      }

      node.style.height = `${Math.min(
        Math.max(Math.ceil(height), MIN_TWEET_FRAME_HEIGHT),
        MAX_TWEET_FRAME_HEIGHT,
      )}px`;
    }

    window.addEventListener("message", handleMessage);
    return {
      destroy() {
        window.removeEventListener("message", handleMessage);
      },
    };
  }

  onMount(() => {
    const syncTweetTheme = () => {
      tweetTheme = document.documentElement.classList.contains("dark")
        ? "dark"
        : "light";
    };
    syncTweetTheme();

    const observer = new MutationObserver(syncTweetTheme);
    observer.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });
    return () => observer.disconnect();
  });

  // This is the same browser-visible key used by the classic UI. Deployments
  // can replace it without code changes via PUBLIC_IFRAMELY_API_KEY.
  const iframelyApiKey =
    env.PUBLIC_IFRAMELY_API_KEY || "c7c62b2d895d05ffeb410c4d535e6823";

  $: if (safeUrl && safeUrl !== currentUrl) {
    currentUrl = safeUrl;
    showConsentDialog = false;
    tweetUnavailable = false;
    iframelyLoadKey = "";
    iframelyLoading = false;
    iframelyError = false;
  }

  $: consentScope = embedConsentScope($page.url);
  $: consentKey = `${consentScope}\n${safeUrl}`;

  $: if (safeUrl && consentScope && !firstParty) {
    domain = extractDomain(safeUrl);

    // Reading $privacyStore makes every mounted embed react to consent changes.
    hasConsent = canLoadUrlFromState($privacyStore, safeUrl, consentScope);
    if (!hasConsent) {
      // A revoked Iframely embed unmounts its container. Clear request state so
      // granting consent again populates the newly mounted container.
      iframelyLoadKey = "";
      iframelyLoading = false;
      iframelyError = false;
      // Likewise let a re-grant retry a tweet X once reported missing (a
      // protected post can become public); otherwise only a reload would.
      tweetUnavailable = false;
    }

    // Show consent dialog if no consent and it's an external embed
    showConsentDialog =
      !hasConsent &&
      dismissedConsentKey !== consentKey &&
      isExternalEmbed(safeUrl);
  }

  onMount(() => {
    isDestroyed = false;
    if (!lazy || hasConsent) {
      isVisible = true;
      return () => {
        isDestroyed = true;
      };
    }

    // Use IntersectionObserver for lazy loading
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            isVisible = true;
            observer.disconnect();
          }
        });
      },
      {
        rootMargin: "50px",
      },
    );

    if (embedElement) {
      observer.observe(embedElement);
    }

    return () => {
      isDestroyed = true;
      observer.disconnect();
    };
  });

  async function handleLoadOnce() {
    privacyStore.allowDomainOnce(domain, consentScope);
    isVisible = true;
    await tick();
  }

  async function handleAlwaysAllow() {
    privacyStore.trustDomain(domain);
    isVisible = true;
    await tick();
  }

  function handleCancel() {
    dismissedConsentKey = consentKey;
    showConsentDialog = false;
  }

  // Path segments interpolated into a provider embed URL. Anything that is
  // not one of these characters cannot be part of a real id, and `.` / `/`
  // are exactly what turns interpolation into path traversal.
  const YOUTUBE_ID_PATTERN = /^[\w-]{1,64}$/;
  const SPOTIFY_SEGMENT_PATTERN = /^[\w-]{1,64}$/;

  /**
   * Convert regular URLs to their embed-specific URLs.
   */
  function getEmbedUrl(originalUrl: string): string {
    try {
      const urlObj = new URL(originalUrl);
      const hostname = urlObj.hostname.toLowerCase();

      // YouTube embed. The id is pattern-checked rather than interpolated
      // raw: `?v=../../foo` used to build a `youtube.com/embed/../../foo`
      // frame . Harmless — it stays on youtube.com — but a
      // traversal-shaped hole in a URL builder is the kind of thing that stops
      // being harmless the day the base changes.
      if (hostname === "youtube.com" || hostname === "www.youtube.com") {
        const videoId = urlObj.searchParams.get("v");
        if (videoId && YOUTUBE_ID_PATTERN.test(videoId)) {
          return `https://www.youtube.com/embed/${videoId}`;
        }
      }

      // YouTube short URL
      if (hostname === "youtu.be") {
        const videoId = urlObj.pathname.split("/").filter(Boolean)[0];
        if (videoId && YOUTUBE_ID_PATTERN.test(videoId)) {
          return `https://www.youtube.com/embed/${videoId}`;
        }
      }

      // Vimeo embed
      if (hostname === "vimeo.com" || hostname.endsWith(".vimeo.com")) {
        const videoId = /^\/(\d+)(?:\/|$)/.exec(urlObj.pathname)?.[1];
        if (videoId) {
          return `https://player.vimeo.com/video/${videoId}`;
        }
      }

      // SoundCloud - use oEmbed or their widget
      if (
        hostname === "soundcloud.com" ||
        hostname.endsWith(".soundcloud.com")
      ) {
        return `https://w.soundcloud.com/player/?url=${encodeURIComponent(originalUrl)}`;
      }

      // Spotify embed
      if (hostname === "open.spotify.com") {
        const pathParts = urlObj.pathname.split("/");
        const type = pathParts[1]; // track, album, playlist, etc.
        const id = pathParts[2];
        // `type &&`/`id &&` are load-bearing: `RegExp.test(undefined)` tests
        // the STRING "undefined", which matches the pattern and would build
        // `.../embed/track/undefined` for a URL with no id at all.
        if (
          type &&
          id &&
          SPOTIFY_SEGMENT_PATTERN.test(type) &&
          SPOTIFY_SEGMENT_PATTERN.test(id)
        ) {
          return `https://open.spotify.com/embed/${type}/${id}`;
        }
      }

      // For other URLs, return as-is
      return originalUrl;
    } catch (e) {
      console.error("[ExternalEmbed] Error converting URL:", e);
      return originalUrl;
    }
  }

  async function renderIframelyEmbed() {
    const requestedUrl = safeUrl;
    if (
      !browser ||
      firstParty ||
      !hasConsent ||
      !isVisible ||
      !usesIframely ||
      iframelyLoadKey === requestedUrl
    ) {
      return;
    }

    iframelyLoadKey = requestedUrl;
    iframelyLoading = true;
    iframelyError = false;

    try {
      const endpoint = new URL("https://cdn.iframe.ly/api/iframely");
      endpoint.searchParams.set("url", requestedUrl);
      endpoint.searchParams.set("key", iframelyApiKey);
      endpoint.searchParams.set("iframe", "1");
      endpoint.searchParams.set("omit_script", "1");

      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(`Iframely returned ${response.status}`);
      const payload = await response.json();
      if (isDestroyed || iframelyLoadKey !== requestedUrl) return;
      if (!payload?.html) {
        throw new Error(payload?.message || "No embeddable content returned");
      }

      iframelyLoading = false;
      await tick();
      if (!iframelyContainer || isDestroyed) return;

      // `sanitizeEmbedHtml` does what DOMPurify alone cannot: it FORCES a
      // sandbox onto every surviving iframe, drops any frame pointing back at
      // our own origin, and trims `allow=` to media features. Iframely returns
      // markup derived from the embedded page's own metadata, which the author
      // of a `::embed[…]` may control .
      iframelyContainer.innerHTML = sanitizeEmbedHtml(
        payload.html,
        window.location.origin,
      );
    } catch (error) {
      if (iframelyLoadKey !== requestedUrl) return;
      console.error("[ExternalEmbed] Iframely render failed:", error);
      iframelyLoading = false;
      iframelyError = true;
    }
  }

  // Guarded so a rejected url does not call `new URL("")` and log a parse
  // failure for every embed the sanitizer already decided against.
  $: embedUrl = safeUrl ? getEmbedUrl(safeUrl) : "";
  $: tweetEmbedUrl = mediaType ? null : getTweetEmbedUrl(safeUrl, tweetTheme);
  $: isTwitterEmbed = !!tweetEmbedUrl;
  // Known providers get a transformed player URL. Everything else goes
  // through Iframely instead of attempting to frame a provider web page.
  $: usesIframely =
    !firstParty && !mediaType && !isTwitterEmbed && embedUrl === safeUrl;
  $: if (browser && hasConsent && isVisible && usesIframely && safeUrl) {
    tick().then(renderIframelyEmbed);
  }
</script>

<!--
  A url that is not an absolute http(s) URL renders NOTHING — not a consent
  card, not a placeholder. Without this guard an unusable value would sit on the
  `{:else if !isVisible}` branch showing "Loading..." forever.
-->
{#if firstParty}
  <div class="my-6 w-full" data-first-party-embed={firstParty.kind}>
    {#if firstParty.kind === "audio"}
      <MarkdownAudio src={firstPartySrc} />
    {:else if firstParty.kind === "video"}
      <MarkdownVideo src={firstPartySrc} />
    {:else if firstParty.kind === "image"}
      <img
        src={firstPartySrc}
        alt=""
        class="markdown-embed-image"
        loading="lazy"
        decoding="async"
      />
    {:else if !("path" in firstParty)}
      <div class="first-party-embed first-party-embed-{firstParty.kind}">
        <a class="first-party-embed-card" href={firstParty.href}
          ><span class="first-party-embed-name" dir="ltr"
            >{firstParty.href}</span
          ></a
        >
      </div>
    {:else}
      <div class="first-party-embed first-party-embed-{firstParty.kind}">
        <a class="first-party-embed-card" href={firstPartySrc} rel="external"
          ><span class="first-party-embed-kind" dir="ltr"
            >{firstPartyFileBadge(firstParty.name)}</span
          ><span class="first-party-embed-name" dir="auto"
            >{firstParty.name}</span
          ></a
        >
      </div>
    {/if}
  </div>
{:else if safeUrl}
  <!--
    This card is PRODUCT CHROME that happens to be mounted inside the article
    body, and that body carries the article's direction. Without
    this boundary an English consent warning inside an Arabic article inherits
    RTL: its full stop moves to the wrong end and the Cancel/Allow pair swaps
    visual order (codex adversarial review). `lang`/`dir` from the reader's UI
    locale, not from a literal `ltr` -- all four UI locales are left-to-right
    today, and when a UI locale is not left-to-right, this stays correct.
  -->
  <div
    bind:this={embedElement}
    lang={$locale}
    dir={contentDirection($locale) ?? undefined}
    class="my-6 w-full"
  >
    {#if showConsentDialog}
      <section
        class="external-consent relative z-10 mx-auto flex max-w-2xl flex-col gap-2.5 rounded-lg border border-border bg-card p-4 text-card-foreground sm:p-5"
        aria-labelledby="external-content-title"
        aria-describedby="external-content-description"
      >
        <div class="flex items-center gap-3">
          <span
            class="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <ShieldCheck class="size-4.5" strokeWidth={1.8} />
          </span>
          <div class="min-w-0 pt-0.5">
            <h3
              id="external-content-title"
              class="!m-0 text-base leading-tight font-semibold tracking-tight"
            >
              {!$loading
                ? $t("privacy.embedBlocked", "External content blocked")
                : "External content blocked"}
            </h3>
            <p class="!mt-1 !mb-0 text-sm leading-5 text-muted-foreground">
              {!$loading ? $t("privacy.from", "From") : "From"}
              <code
                class="rounded-sm bg-background px-1.5 py-0.5 font-mono text-[0.8125rem] font-medium break-all text-foreground"
                >{domain}</code
              >
            </p>
          </div>
        </div>

        <p
          id="external-content-description"
          class="!m-0 text-sm leading-5.5 text-muted-foreground"
        >
          {!$loading
            ? $t(
                "privacy.embedWarningShort",
                "Loading this embed can share your IP address and browser details with this provider.",
              )
            : "Loading this embed can share your IP address and browser details with this provider."}
        </p>

        <div>
          <a
            href="/docs/legal/privacy-policy"
            class="relative inline-flex h-8 items-center text-sm font-medium text-primary no-underline underline-offset-4 transition-colors after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] hover:text-primary/80 hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {!$loading
              ? $t("privacy.learnMore", "Learn more about privacy")
              : "Learn more about privacy"}
          </a>
        </div>

        <div class="flex flex-wrap items-center justify-end gap-2">
          <Button
            class="relative !h-8 px-2.5 text-xs after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']"
            variant="ghost"
            onclick={handleCancel}
          >
            {!$loading ? $t("common.cancel", "Cancel") : "Cancel"}
          </Button>
          <Button
            class="relative !h-8 min-w-0 px-3 text-xs after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']"
            variant="outline"
            onclick={handleAlwaysAllow}
            title={`Always allow embeds from ${domain}`}
          >
            <span class="truncate"
              >{!$loading
                ? $t("privacy.alwaysAllowSite", "Always allow this site")
                : "Always allow this site"}</span
            >
          </Button>
          <Button
            class="relative !h-8 px-3 text-xs after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']"
            variant="default"
            onclick={handleLoadOnce}
          >
            {!$loading ? $t("privacy.loadOnce", "Load once") : "Load once"}
          </Button>
        </div>
      </section>
    {:else if hasConsent && isVisible}
      <!-- Load the embed content -->
      {#if mediaType === "audio"}
        <MarkdownAudio src={safeUrl} preload="metadata" />
      {:else if mediaType === "video"}
        <MarkdownVideo src={safeUrl} />
      {:else if isTwitterEmbed}
        {#if !tweetUnavailable}
          <div class="tweet-embed-shell">
            <iframe
              src={tweetEmbedUrl}
              title={title || "Tweet"}
              class="tweet-embed-frame"
              use:resizeTweetFrame
              sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              loading="lazy"
              referrerpolicy="no-referrer"
            ></iframe>
          </div>
        {/if}
        <!--
          Always present: X can be down or blocked by an extension, in which
          case the frame never sends a message and stays blank. The direct link
          is the reader's way out either way.
        -->
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="tweet-embed-fallback text-sm text-primary hover:underline"
        >
          {!$loading
            ? $t("privacy.viewTweet", "View post on X")
            : "View post on X"}
        </a>
      {:else if usesIframely}
        <div class="iframely-embed-shell">
          {#if iframelyLoading}
            <div class="embed-status">Loading embedded content…</div>
          {:else if iframelyError}
            <div class="embed-status">
              This provider could not be embedded.
              <a href={safeUrl} target="_blank" rel="noopener noreferrer"
                >Open it directly</a
              >
            </div>
          {:else}
            <div
              bind:this={iframelyContainer}
              class="iframely-embed-target"
            ></div>
          {/if}
        </div>
      {:else}
        <div
          class="relative h-0 w-full overflow-hidden rounded-md bg-card pb-[56.25%]"
        >
          <iframe
            src={embedUrl}
            {title}
            class="absolute inset-0 h-full w-full rounded-md border-0"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
            loading="lazy"
            referrerpolicy="no-referrer-when-downgrade"
            allowfullscreen
          ></iframe>
        </div>
      {/if}
    {:else if !isVisible}
      <!-- Placeholder while waiting for visibility -->
      <div
        class="flex w-full items-center justify-center rounded-md border border-dashed border-border bg-card px-6 py-12"
      >
        <div class="text-center text-muted-foreground">
          <svg
            class="mx-auto mb-3 h-12 w-12 opacity-50"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path
              d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"
            />
          </svg>
          <p>
            {!$loading ? $t("privacy.loading", "Loading...") : "Loading..."}
          </p>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .tweet-embed-shell {
    width: 100%;
    max-width: 550px;
    margin-inline: auto;
    max-height: 85vh;
    overflow: auto;
    contain: paint;
    border-radius: var(--f2z-radius-xl);
    background: var(--background);
  }

  .tweet-embed-fallback {
    display: inline-block;
    margin-top: 0.5rem;
  }

  .tweet-embed-frame {
    display: block;
    width: 100%;
    max-width: 550px;
    min-height: 150px;
    height: 600px;
    border: 0;
    border-radius: var(--f2z-radius-xl);
    background: var(--background);
  }

  /*
   * `contain: paint` is load-bearing security, not styling .
   *
   * Iframely's HTML is derived from the embedded page's own metadata, so an
   * author who controls that page controls the `style=` attributes that come
   * back — and `position: fixed; inset: 0` is a full-viewport phishing overlay
   * on a free2z.cash page. Paint containment makes this element the containing
   * block for `absolute` AND `fixed` descendants and clips them to it, so the
   * worst an embed can do is fill its own box. `overflow: hidden` alone does
   * not do this: a `fixed` descendant ignores it entirely, and an `absolute`
   * one escapes whenever its containing block is outside this element.
   */
  .iframely-embed-shell {
    width: 100%;
    /*
     * Paint containment clips to the BOX, and the provider controls the box's
     * height — an in-flow `height: 300vh` element makes the shell taller than
     * the viewport and the clip stops mattering. The cap is what actually
     * bounds it: no embed can ever occupy the whole screen, so page chrome
     * stays visible and a fake login screen never looks like the whole app.
     * 85vh is ~2x the tallest real embed at article width (a 16:9 player is
     * 0.5625 * width); raise it only against a measured real embed.
     */
    max-height: 85vh;
    /*
     * `auto`, not `hidden`: the cap exists to stop an embed OWNING the screen,
     * not to hide content. `omit_script=1` means Iframely's height-adjusting
     * helper never loads, so a tall widget (TikTok, Instagram, a document
     * viewer) really can exceed the cap on a short phone viewport — clipping it
     * would put the bottom of a real embed permanently out of reach.
     */
    overflow: auto;
    contain: paint;
    border-radius: 0.75rem;
  }

  .iframely-embed-target {
    width: 100%;
  }

  .iframely-embed-target :global(iframe) {
    display: block;
    width: 100%;
    max-width: 100%;
    border: 0;
  }

  .embed-status {
    border: 1px dashed var(--border);
    border-radius: 0.75rem;
    background: var(--card);
    padding: 1.5rem;
    color: var(--muted-foreground);
    text-align: center;
  }

  .embed-status a {
    margin-left: 0.35rem;
    color: var(--primary);
  }
</style>
