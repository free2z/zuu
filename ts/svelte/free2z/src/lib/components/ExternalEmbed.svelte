<script lang="ts">
  // @ts-ignore: workaround for "svelte/types/index.d.ts is not a module" in some TS setups
  import { onMount, tick } from "svelte";
  import { browser } from "$app/environment";
  import {
    privacyStore,
    extractDomain,
    isExternalEmbed,
  } from "$lib/stores/privacy";
  import { tStore as t, loading } from "$lib/i18n";
  import { Button } from "$lib/components/ui/button";
  import { Checkbox } from "$lib/components/ui/checkbox";

  export let url: string;
  export let title: string | undefined = undefined;
  export let lazy = true; // Use IntersectionObserver for lazy loading

  let isVisible = false;
  let hasConsent = false;
  let showConsentDialog = false;
  let alwaysAllow = false;
  let embedElement: HTMLDivElement;
  let tweetContainer: HTMLDivElement;
  let domain = "";
  let manualConsent = false; // Track if user manually granted consent
  let tweetRenderKey = "";
  let tweetRenderFailed = false;
  let currentUrl = "";
  let embedTheme: "light" | "dark" = "light";
  let isDestroyed = false;

  type TwitterWidgets = {
    widgets?: {
      load?: (element?: HTMLElement) => void;
      createTweet?: (
        tweetId: string,
        target: HTMLElement,
        options?: Record<string, unknown>,
      ) => Promise<HTMLElement | undefined>;
    };
  };

  type TwitterWindow = Window & {
    twttr?: TwitterWidgets;
  };

  function syncThemeFromDocument() {
    embedTheme =
      browser && document.documentElement.classList.contains("dark")
        ? "dark"
        : "light";
  }

  $: if (url && url !== currentUrl) {
    currentUrl = url;
    alwaysAllow = false;
    manualConsent = false;
    showConsentDialog = false;
    tweetRenderKey = "";
    tweetRenderFailed = false;
  }

  $: if (url) {
    domain = extractDomain(url);

    // Only check store consent if user hasn't manually granted consent
    if (!manualConsent) {
      hasConsent = privacyStore.canLoadUrl(url);

      // Show consent dialog if no consent and it's an external embed
      showConsentDialog = !hasConsent && isExternalEmbed(url);
    }
  }

  onMount(() => {
    isDestroyed = false;
    syncThemeFromDocument();

    const themeObserver = new MutationObserver(() => {
      syncThemeFromDocument();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    if (!lazy || hasConsent) {
      isVisible = true;
      return () => {
        isDestroyed = true;
        themeObserver.disconnect();
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
      themeObserver.disconnect();
    };
  });

  async function handleLoadOnce() {
    manualConsent = true; // Prevent reactive statement from overwriting
    hasConsent = true;
    showConsentDialog = false;
    isVisible = true;
    await tick();
  }

  async function handleAlwaysAllow() {
    // "Load & Remember" should ALWAYS trust the domain (that's what "remember" means)
    privacyStore.trustDomain(domain);

    // Additionally, if user checked "Always load all external content", enable global consent
    if (alwaysAllow) {
      privacyStore.enableGlobalConsent();
    }

    manualConsent = true; // Prevent reactive statement from overwriting
    hasConsent = true;
    showConsentDialog = false;
    isVisible = true;
    await tick();
  }

  function handleCancel() {
    showConsentDialog = false;
  }

  /**
   * Convert regular URLs to their embed-specific URLs
   */
  function getEmbedUrl(originalUrl: string): string {
    try {
      const urlObj = new URL(originalUrl);
      const hostname = urlObj.hostname.toLowerCase();

      // Twitter/X embed
      if (
        hostname === "twitter.com" ||
        hostname === "x.com" ||
        hostname.endsWith(".twitter.com") ||
        hostname.endsWith(".x.com")
      ) {
        // Extract tweet ID from URL
        const match = originalUrl.match(/status\/(\d+)/);
        if (match) {
          const tweetId = match[1];
          return `https://platform.twitter.com/embed/Tweet.html?id=${tweetId}`;
        }
      }

      // YouTube embed
      if (hostname === "youtube.com" || hostname === "www.youtube.com") {
        const videoId = urlObj.searchParams.get("v");
        if (videoId) {
          return `https://www.youtube.com/embed/${videoId}`;
        }
      }

      // YouTube short URL
      if (hostname === "youtu.be") {
        const videoId = urlObj.pathname.slice(1);
        if (videoId) {
          return `https://www.youtube.com/embed/${videoId}`;
        }
      }

      // Vimeo embed
      if (hostname === "vimeo.com" || hostname.endsWith(".vimeo.com")) {
        const videoId = urlObj.pathname.split("/")[1];
        if (videoId) {
          return `https://player.vimeo.com/video/${videoId}`;
        }
      }

      // Instagram embed
      if (hostname === "instagram.com" || hostname === "www.instagram.com") {
        return `${originalUrl}embed/`;
      }

      // TikTok embed
      if (hostname === "tiktok.com" || hostname === "www.tiktok.com") {
        return `https://www.tiktok.com/embed/${urlObj.pathname}`;
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
        if (type && id) {
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

  function getTweetId(originalUrl: string): string | null {
    const match = originalUrl.match(/status\/(\d+)/);
    return match?.[1] ?? null;
  }

  function isTwitterEmbedUrl(originalUrl: string): boolean {
    try {
      const urlObj = new URL(originalUrl);
      const hostname = urlObj.hostname.toLowerCase();
      return (
        hostname === "twitter.com" ||
        hostname === "x.com" ||
        hostname.endsWith(".twitter.com") ||
        hostname.endsWith(".x.com")
      );
    } catch {
      return false;
    }
  }

  async function ensureTwitterWidgets(): Promise<TwitterWidgets | undefined> {
    if (!browser) {
      return undefined;
    }

    const twitterWindow = window as TwitterWindow;

    if (twitterWindow.twttr?.widgets?.createTweet) {
      return twitterWindow.twttr;
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://platform.twitter.com/widgets.js"]',
    );

    if (existingScript) {
      await new Promise<void>((resolve) => {
        if (twitterWindow.twttr?.widgets?.createTweet) {
          resolve();
          return;
        }

        existingScript.addEventListener("load", () => resolve(), {
          once: true,
        });
        existingScript.addEventListener("error", () => resolve(), {
          once: true,
        });
      });

      return twitterWindow.twttr;
    }

    await new Promise<void>((resolve) => {
      const script = document.createElement("script");
      script.src = "https://platform.twitter.com/widgets.js";
      script.async = true;
      script.charset = "utf-8";
      script.onload = () => resolve();
      script.onerror = () => resolve();
      document.head.appendChild(script);
    });

    return twitterWindow.twttr;
  }

  async function renderTweetEmbed() {
    if (!browser || !isTwitterEmbed || !tweetId || !tweetContainer) {
      return;
    }

    const renderKey = `${tweetId}:${embedTheme}`;
    if (tweetRenderKey === renderKey && tweetContainer.childElementCount > 0) {
      return;
    }

    tweetRenderFailed = false;
    tweetRenderKey = renderKey;
    tweetContainer.innerHTML = "";

    const twttr = await ensureTwitterWidgets();
    if (isDestroyed || !twttr?.widgets?.createTweet) {
      tweetRenderFailed = true;
      return;
    }

    try {
      await twttr.widgets.createTweet(tweetId, tweetContainer, {
        align: "center",
        dnt: true,
        theme: embedTheme,
      });
      if (isDestroyed) {
        return;
      }
    } catch (error) {
      console.error("[ExternalEmbed] Error rendering tweet embed:", error);
      tweetRenderFailed = true;
    }
  }

  $: embedUrl = getEmbedUrl(url);
  $: tweetId = getTweetId(url);
  $: isTwitterEmbed = isTwitterEmbedUrl(url) && !!tweetId;
  $: if (browser && hasConsent && isVisible && isTwitterEmbed && embedTheme) {
    tick().then(renderTweetEmbed);
  }
</script>

<div bind:this={embedElement} class="my-6 w-full">
  {#if showConsentDialog}
    <!-- Consent Dialog -->
    <div
      class="relative z-10 mx-auto max-w-2xl rounded-lg border-2 border-border bg-card p-6 shadow-lg sm:p-8"
    >
      <div class="mb-6 flex items-center gap-3">
        <svg
          class="h-8 w-8 shrink-0 text-primary"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        </svg>
        <h3 class="m-0 text-xl font-bold text-card-foreground">
          {!$loading
            ? $t("privacy.embedTitle", "External Content")
            : "External Content"}
        </h3>
      </div>

      <div class="mb-6">
        <p class="mb-4 leading-relaxed text-card-foreground">
          {!$loading
            ? $t(
                "privacy.embedMessage",
                "This content is hosted by an external provider.",
              )
            : "This content is hosted by an external provider."}
        </p>

        <div class="mb-4 rounded-md bg-background p-3">
          <strong class="mb-1 block text-sm text-foreground"
            >{!$loading ? $t("privacy.domain", "Domain:") : "Domain:"}</strong
          >
          <code class="font-mono text-sm break-all text-primary">{domain}</code>
        </div>

        <p class="mb-4 text-sm leading-normal text-muted-foreground">
          {!$loading
            ? $t(
                "privacy.embedWarning",
                "Loading this content may share your IP address, browser information, and other data with the provider.",
              )
            : "Loading this content may share your IP address, browser information, and other data with the provider."}
        </p>

        <div class="mb-4 flex flex-col gap-3">
          <label
            for="alwaysAllow"
            class="flex cursor-pointer items-center gap-2 text-sm text-foreground"
          >
            <Checkbox id="alwaysAllow" bind:checked={alwaysAllow} />
            <span>
              {!$loading
                ? $t("privacy.alwaysAllow", "Always load all external content")
                : "Always load all external content"}
            </span>
          </label>
        </div>

        <a
          href="/docs/legal/privacy-policy"
          class="inline-flex items-center text-sm text-primary no-underline transition-colors hover:text-primary/80 hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          {!$loading
            ? $t("privacy.learnMore", "Learn more about privacy")
            : "Learn more about privacy"}
        </a>
      </div>

      <div
        class="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-end"
      >
        <Button variant="outline" onclick={handleCancel}>
          {!$loading ? $t("common.cancel", "Cancel") : "Cancel"}
        </Button>
        <Button variant="secondary" onclick={handleLoadOnce}>
          {!$loading ? $t("privacy.loadOnce", "Load Once") : "Load Once"}
        </Button>
        <Button variant="default" onclick={handleAlwaysAllow}>
          {!$loading
            ? $t("privacy.loadAndRemember", "Load & Remember")
            : "Load & Remember"}
        </Button>
      </div>
    </div>
  {:else if hasConsent && isVisible}
    <!-- Load the embed content -->
    {#if isTwitterEmbed}
      <div class="tweet-embed-shell">
        <div bind:this={tweetContainer} class="tweet-embed-target"></div>
        {#if tweetRenderFailed}
          <div
            class="rounded-md border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground"
          >
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              class="text-primary hover:underline"
            >
              View tweet
            </a>
          </div>
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
        <p>{!$loading ? $t("privacy.loading", "Loading...") : "Loading..."}</p>
      </div>
    </div>
  {/if}
</div>

<style>
  .tweet-embed-shell {
    position: relative;
    width: 100%;
    overflow: hidden;
    border-radius: 18px;
    background: var(--background);
  }

  .tweet-embed-shell::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    border-radius: 18px;
    box-shadow: inset 0 0 0 2px var(--background);
    z-index: 2;
  }

  .tweet-embed-target {
    display: flex;
    justify-content: center;
    width: 100%;
    overflow: hidden;
    border-radius: 18px;
    background: var(--background);
  }

  .tweet-embed-target :global(iframe) {
    display: block;
    background: transparent !important;
    border-radius: 16px !important;
    clip-path: inset(2px round 16px);
  }

  .tweet-embed-target :global(.twitter-tweet),
  .tweet-embed-target :global(.twitter-tweet-rendered) {
    margin: 0 auto !important;
    max-width: min(550px, 100%) !important;
    width: 100% !important;
    overflow: hidden !important;
    border-radius: 16px !important;
    clip-path: inset(2px round 16px);
  }
</style>
