<script module lang="ts">
  let markdownContentInstanceSequence = 0;
</script>

<script lang="ts">
  import { browser } from "$app/env";
  import { beforeNavigate } from "$app/navigation";
  import { tStore as t } from "$lib/i18n";
  import { onMount, afterUpdate, tick } from "svelte";
  import { mount, unmount } from "svelte";
  import DOMPurify from "isomorphic-dompurify";
  import ExternalEmbed from "./ExternalEmbed.svelte";
  import MarkdownQrCode from "./MarkdownQrCode.svelte";
  import MarkdownAudio from "./MarkdownAudio.svelte";
  import MarkdownVideo from "./MarkdownVideo.svelte";
  import MarkdownImageLightbox, {
    type MarkdownImageLightboxImage,
  } from "./MarkdownImageLightbox.svelte";
  import CodeBlockChrome, { codeWrapStore } from "./CodeBlockChrome.svelte";
  import OutboundLinkWarning, {
    type OutboundLinkDecision,
  } from "./OutboundLinkWarning.svelte";
  import { getCodeLanguageInfo } from "$lib/utils/markdown";
  import {
    isDisallowedAuthorLink,
    parseOutboundHttpUrl,
    type OutboundLinkDestination,
  } from "$lib/utils/outbound-link";
  import { outboundLinkStore } from "$lib/stores/outbound-links";
  import { getSafeMediaUrl, isThirdPartyMediaUrl } from "$lib/utils/safe-url";
  import {
    sanitizeMarkdownHtml,
    sanitizeMarkdownHtmlForMarkup,
  } from "$lib/utils/markdown-sanitize";

  export let html: string;

  //  the article body has to exist in the server-rendered markup.
  //
  // Every enhancement below is imperative DOM work that only runs after
  // `onMount`, which never fires during SSR. Before this, the markup shipped an
  // empty `<div class="markdown-content">` and the body existed only inside the
  // hydration payload, so a crawler that does not execute JavaScript (GPTBot,
  // ClaudeBot, PerplexityBot, CCBot, Bytespider, Meta-ExternalAgent — and
  // Googlebot until its render queue gets around to us) saw an article with no
  // article in it.
  //
  // The markup now emits the sanitized HTML directly. This snapshot is
  // deliberately NOT reactive: on the client the imperative pipeline below owns
  // the container (it replaces `<pre>` with code shells, swaps placeholders for
  // mounted components, wraps tables), so Svelte must never try to re-render
  // this block over nodes it no longer recognizes. `afterUpdate` handles later
  // `html` changes instead.
  //
  // `sanitizeMarkdownHtmlForMarkup` yields "" above the cost ceilings so a
  // single absurd article cannot wedge the SSR pod on a second full DOM parse;
  // see markdown-sanitize.ts. The decision is a pure function of the string, so
  // server and client always produce the same snapshot.
  const initialHtml = html;
  const initialMarkup = sanitizeMarkdownHtmlForMarkup(html || "");
  // Cleared by the first `setContent()`. While set, the container still holds
  // exactly `initialMarkup`, so the first pass can enhance that DOM in place
  // rather than tearing it down and rebuilding an identical tree.
  let pendingInitialMarkup = true;

  // Falling back is legitimate, but it must never be silent: nobody would ever
  // discover that an article quietly lost its crawler-visible body. The
  // attribute makes it visible in view-source and greppable in a fetch; the log
  // makes it greppable in the pod. Both are derived from the same pure
  // function, so the attribute is identical on both sides and cannot introduce
  // a hydration mismatch.
  const bodyDeferredToClient = !!html && initialMarkup === "";
  if (bodyDeferredToClient && !browser) {
    console.warn(
      `[MarkdownContent] body too expensive to server-render (${html.length} chars); ` +
        `deferred to the client, so crawlers will not see it. See SSR_MARKUP_MAX_* in markdown-sanitize.ts.`,
    );
  }

  let contentContainer: HTMLDivElement;
  let mountedComponents: Array<{ component: any; container: HTMLElement }> = [];
  let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
  let renderRevision = 0;
  let themeObserver: MutationObserver | null = null;
  let unsubscribeCodeWrap: (() => void) | null = null;
  let wrapCodeBlocks = false;
  let lastRenderedHtml: string | null = null;
  let lastScrolledHash = "";
  let isDestroyed = false;
  let warningOpen = false;
  let pendingOutboundDestination: OutboundLinkDestination | null = null;
  let pendingOutboundLink: HTMLAnchorElement | null = null;
  let unsubscribeOutboundStorageSync: (() => void) | null = null;
  let selectedImage: MarkdownImageLightboxImage | null = null;
  let lightboxOpen = false;
  const componentInstanceId = ++markdownContentInstanceSequence;

  function escapeHtml(content: string) {
    return content
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function sanitizeMermaidSvg(content: string) {
    return DOMPurify.sanitize(content, {
      USE_PROFILES: { svg: true, svgFilters: true },
    });
  }

  function isCurrentRender(revision: number) {
    return !isDestroyed && revision === renderRevision && !!contentContainer;
  }

  function applyCodeWrapToShells() {
    if (!contentContainer) {
      return;
    }

    contentContainer
      .querySelectorAll<HTMLElement>(".code-block-shell")
      .forEach((shell) => {
        shell.dataset.wrap = wrapCodeBlocks ? "true" : "false";
      });
  }

  function persistCodeWrap(value: boolean) {
    if (browser) {
      window.localStorage.setItem(
        "markdown-code-wrap",
        value ? "true" : "false",
      );
    }
  }

  function toggleCodeWrap() {
    // Wrapping is purely presentational (driven by the `data-wrap` CSS hook),
    // so update the shared store and let each mounted markdown instance flip
    // its existing shells in place instead of rebuilding article DOM.
    codeWrapStore.update((current) => {
      const next = !current;
      persistCodeWrap(next);
      return next;
    });
  }

  async function copyCodeBlock(source: string) {
    if (!browser) {
      return false;
    }

    try {
      await navigator.clipboard.writeText(source);
      return true;
    } catch (error) {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = source;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "absolute";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        const didCopy = document.execCommand("copy");
        document.body.removeChild(textarea);
        return didCopy;
      } catch (fallbackError) {
        console.error("Error copying code block:", fallbackError || error);
        return false;
      }
    }
  }

  function cleanupEmbeds() {
    mountedComponents.forEach(({ component }) => {
      try {
        void unmount(component).catch(() => {});
      } catch {}
    });
    mountedComponents = [];
  }

  function getAuthorLink(target: EventTarget | null): HTMLAnchorElement | null {
    if (!(target instanceof Element)) return null;

    const link = target.closest<HTMLAnchorElement>(
      'a.markdown-author-link[data-markdown-author-link="true"]',
    );
    return link && contentContainer?.contains(link) ? link : null;
  }

  function openOutboundLink(destination: OutboundLinkDestination) {
    // Keep the parsed URL as the only value reaching the navigation sink.
    window.open(destination.href, "_blank", "noopener,noreferrer");
  }

  function restoreOutboundLinkFocus(link: HTMLAnchorElement | null) {
    void tick().then(() => {
      if (link?.isConnected) link.focus();
    });
  }

  function handleOutboundLinkDecision(decision: OutboundLinkDecision) {
    const destination = pendingOutboundDestination;
    const link = pendingOutboundLink;

    warningOpen = false;
    pendingOutboundDestination = null;
    pendingOutboundLink = null;

    if (!decision.cancelled && destination) {
      if (decision.trustDomain) {
        outboundLinkStore.trustDomain(destination.hostname);
      }
      if (decision.disableWarnings) {
        outboundLinkStore.disableWarnings();
      }
      openOutboundLink(destination);
    }

    restoreOutboundLinkFocus(link);
  }

  function handleAuthorLinkActivation(
    event: MouseEvent | KeyboardEvent,
    link: HTMLAnchorElement,
  ) {
    if (
      event instanceof MouseEvent &&
      ((event.type === "click" && event.button !== 0) ||
        (event.type === "auxclick" && event.button !== 1))
    ) {
      return;
    }

    const rawHref = link.getAttribute("href");
    if (!rawHref) return;

    const destination = parseOutboundHttpUrl(rawHref, window.location.href);
    if (!destination) {
      // DOMPurify normally removes disallowed hrefs before this point. Keep a
      // point-of-use guard for pre-rendered HTML and future sanitizer changes;
      // javascript:, data:, blob:, and malformed URL values never get a chance
      // to bypass the warning policy or reach a navigation sink.
      if (isDisallowedAuthorLink(rawHref, window.location.href)) {
        event.preventDefault();
      }
      return;
    }

    // Same-origin author links still carry target/rel from SSR, but do not
    // need an external-domain warning.
    if (!destination.isExternal) return;

    event.preventDefault();

    if (!outboundLinkStore.shouldWarn(destination.hostname)) {
      openOutboundLink(destination);
      return;
    }

    pendingOutboundDestination = destination;
    pendingOutboundLink = link;
    warningOpen = true;
  }

  function handleAuthorLinkClick(event: MouseEvent) {
    const link = getAuthorLink(event.target);
    if (link) handleAuthorLinkActivation(event, link);
  }

  function handleAuthorLinkAuxClick(event: MouseEvent) {
    if (event.button !== 1) return;

    const link = getAuthorLink(event.target);
    if (link) handleAuthorLinkActivation(event, link);
  }

  function handleAuthorLinkKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.defaultPrevented) return;

    const link = getAuthorLink(event.target);
    if (link) handleAuthorLinkActivation(event, link);
  }

  function isLightboxExcluded(image: HTMLImageElement) {
    return Boolean(
      image.closest(
        "a, button, video, audio, iframe, .markdown-qrcode, .markdown-video, .markdown-audio, .external-embed, [data-markdown-no-lightbox]",
      ),
    );
  }

  function getLiveImageUrl(image: HTMLImageElement) {
    // currentSrc is the browser's selected, sanitized URL (including any
    // future srcset policy). Revalidate it at this live URL sink instead of
    // recovering a URL from author Markdown or a stale data attribute.
    return getSafeMediaUrl(image.currentSrc || image.src);
  }

  function enhanceImages() {
    if (!contentContainer) return;

    contentContainer
      .querySelectorAll<HTMLImageElement>("img")
      .forEach((image) => {
        if (
          image.closest(".markdown-image-trigger") ||
          isLightboxExcluded(image) ||
          !getLiveImageUrl(image)
        ) {
          return;
        }

        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "markdown-image-trigger";
        trigger.dataset.markdownImageTrigger = "true";
        trigger.setAttribute(
          "aria-label",
          image.alt.trim() ||
            image.title?.trim() ||
            $t("common.expandedImage", "Expanded image"),
        );
        trigger.title = $t("common.expandedImage", "Expanded image");
        image.replaceWith(trigger);
        trigger.appendChild(image);
      });
  }

  function openImageFromTrigger(trigger: HTMLButtonElement) {
    const image = trigger.querySelector<HTMLImageElement>("img");
    const url = image && getLiveImageUrl(image);
    if (
      !image ||
      !url ||
      !image.naturalWidth ||
      !image.naturalHeight ||
      !image.isConnected ||
      !contentContainer.contains(trigger)
    ) {
      return;
    }

    selectedImage = {
      url,
      alt: image.alt,
      title: image.title || "",
      trigger,
    };
    lightboxOpen = true;
  }

  function handleMarkdownImageClick(event: MouseEvent) {
    if (!(event.target instanceof Element)) return;

    const trigger = event.target.closest<HTMLButtonElement>(
      "button.markdown-image-trigger",
    );
    if (!trigger || !contentContainer.contains(trigger)) return;

    event.preventDefault();
    openImageFromTrigger(trigger);
  }

  function restoreImageFocus(trigger: HTMLButtonElement | null) {
    void tick().then(() => {
      requestAnimationFrame(() => {
        if (trigger?.isConnected) {
          trigger.focus({ preventScroll: true });
        }
      });
    });
  }

  function closeLightbox(restoreFocus = true) {
    const trigger = selectedImage?.trigger || null;
    lightboxOpen = false;
    selectedImage = null;
    if (restoreFocus) restoreImageFocus(trigger);
  }

  function handleLightboxOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      lightboxOpen = true;
      return;
    }
    if (lightboxOpen || selectedImage) closeLightbox();
  }

  // A client-side navigation can retain this component instance while its
  // article data changes. Close before SvelteKit starts that transition so a
  // portal, body scroll lock, or focus target never outlives the article that
  // opened it. The callback is automatically removed when this instance is
  // destroyed.
  beforeNavigate(() => closeLightbox(false));

  function setContent() {
    if (!contentContainer) return;

    // Hydration is an enhancement pass over real HTML, not a rebuild from
    // nothing: when the container still holds the `{@html initialMarkup}` the
    // markup emitted, re-assigning the identical string would only throw away
    // the server's nodes and re-parse them (a flash, and a pointless reflow on
    // a long article). Any later render — a changed `html`, or the theme
    // observer re-running the pipeline over already-enhanced DOM — must still
    // do the full reset.
    // Keyed on `initialMarkup`, not on whether the container has child nodes:
    // an empty snapshot (no content, or over the size ceiling) must still take
    // the write path, and a whitespace text node must not be mistaken for one.
    const canReuseInitialMarkup =
      pendingInitialMarkup && html === initialHtml && initialMarkup !== "";
    pendingInitialMarkup = false;

    if (!canReuseInitialMarkup) {
      // Every caller today passes `processMarkdown(...)` output, which is
      // already sanitized — so this pass is defence in depth, not the primary
      // filter (see the SECURITY note in markdown-sanitize.ts). It stays
      // because `html` is a plain string prop with nothing enforcing that
      // provenance. The markup snapshot above runs through the same sanitizer,
      // so the server-rendered path is filtered identically.
      contentContainer.innerHTML = sanitizeMarkdownHtml(html || "");
    }

    // The outline must describe the creator's article, not headings mounted by
    // embed consent cards or other enhancement UI after this point.
    contentContainer
      .querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
      .forEach((heading) => {
        // The footnote section is generated by marked-footnote, not part of
        // the creator's article outline. Its heading still gets a local
        // permalink below, but it must not appear in the table of contents.
        if (heading.closest(".footnotes")) return;
        heading.dataset.articleHeading = "true";
      });

    // Footnotes are generated by marked-footnote, not authored destinations.
    // Normalize them defensively in case a future marked extension adds link
    // attributes, and give delegated handling an explicit generated-link hook.
    contentContainer
      .querySelectorAll<HTMLAnchorElement>(
        "a[data-footnote-ref], a[data-footnote-backref]",
      )
      .forEach((link) => {
        link.removeAttribute("target");
        link.removeAttribute("rel");
        link.classList.add("markdown-generated-link");
      });

    // Markdown media is always below the article hero, so keep it out of the
    // critical request path. processMarkdown already emits these attributes;
    // this also covers pre-rendered HTML passed straight to this component.
    contentContainer
      .querySelectorAll<HTMLImageElement>("img")
      .forEach((image) => {
        image.loading = "lazy";
        image.decoding = "async";
        image.fetchPriority = "low";
      });
  }

  function getMermaidTheme() {
    if (!browser) {
      return "default";
    }

    return document.documentElement.classList.contains("dark")
      ? "dark"
      : "default";
  }

  async function getMermaid() {
    if (!browser) {
      return null;
    }

    if (!mermaidPromise) {
      mermaidPromise = import("mermaid")
        .then((module) => module.default)
        .catch((error) => {
          mermaidPromise = null;
          throw error;
        });
    }

    return mermaidPromise;
  }

  function mountEmbeds() {
    if (!contentContainer || !html) return;

    const placeholders = contentContainer.querySelectorAll(
      ".external-embed-placeholder",
    );

    placeholders.forEach((placeholder) => {
      const url = placeholder.getAttribute("data-embed-url");
      if (!url) return;

      const container = document.createElement("div");
      placeholder.parentNode?.replaceChild(container, placeholder);
      container.dataset.markdownNoLightbox = "true";

      const component = mount(ExternalEmbed, {
        target: container,
        props: { url, lazy: false },
      });

      mountedComponents.push({ component, container });
    });

    const audioPlaceholders = contentContainer.querySelectorAll(
      ".audio-embed-placeholder[data-audio-url]",
    );

    audioPlaceholders.forEach((placeholder) => {
      const src = placeholder.getAttribute("data-audio-url");
      if (!src) return;

      const safeSrc = getSafeMediaUrl(src);
      if (!safeSrc) return;

      const container = document.createElement("div");
      placeholder.parentNode?.replaceChild(container, placeholder);
      container.dataset.markdownNoLightbox = "true";

      // The renderer cannot know the page origin during SSR, so media crosses
      // that boundary as an inert data attribute. Classify it here, where the
      // browser's actual origin is available. Third-party media goes through
      // ExternalEmbed itself so consent and domain grants cannot drift into a
      // parallel media-specific policy.
      const component = isThirdPartyMediaUrl(safeSrc, window.location.origin)
        ? mount(ExternalEmbed, {
            target: container,
            props: {
              url: safeSrc,
              lazy: false,
              mediaType: "audio",
            },
          })
        : mount(MarkdownAudio, {
            target: container,
            props: { src: safeSrc },
          });

      mountedComponents.push({ component, container });
    });

    const videoPlaceholders = contentContainer.querySelectorAll(
      ".video-embed-placeholder[data-video-url]",
    );

    videoPlaceholders.forEach((placeholder) => {
      const src = placeholder.getAttribute("data-video-url");
      if (!src) return;

      const safeSrc = getSafeMediaUrl(src);
      if (!safeSrc) return;

      // Poster frame. Only the first-party player takes it:
      // ExternalEmbed is a consent gate for a third-party host, and a poster
      // sourced from our own origin is not the right image for it.
      const poster = placeholder.getAttribute("data-video-poster");

      const container = document.createElement("div");
      placeholder.parentNode?.replaceChild(container, placeholder);
      container.dataset.markdownNoLightbox = "true";

      const component = isThirdPartyMediaUrl(safeSrc, window.location.origin)
        ? mount(ExternalEmbed, {
            target: container,
            props: {
              url: safeSrc,
              lazy: false,
              mediaType: "video",
            },
          })
        : mount(MarkdownVideo, {
            target: container,
            props: { src: safeSrc, poster },
          });

      mountedComponents.push({ component, container });
    });
  }

  // A table is the one thing in markdown that legitimately cannot always wrap.
  // `overflow-wrap: anywhere` on the content root participates in min-content
  // sizing, which would let a table's columns collapse to a few characters
  // wide. Giving each table its own scroll container instead lets it size
  // naturally again while still keeping the horizontal scroll off the page.
  function enhanceTables() {
    if (!contentContainer) return;

    const tables = Array.from(
      contentContainer.querySelectorAll<HTMLTableElement>("table"),
    );

    tables.forEach((table) => {
      if (table.parentElement?.classList.contains("markdown-table-scroll")) {
        return;
      }

      const wrapper = document.createElement("div");
      wrapper.className = "markdown-table-scroll";
      table.replaceWith(wrapper);
      wrapper.appendChild(table);
    });
  }

  function enhanceHeadings() {
    if (!contentContainer) return;

    const headings = contentContainer.querySelectorAll<HTMLElement>(
      "h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]",
    );

    headings.forEach((heading) => {
      if (heading.querySelector(":scope > .heading-anchor")) return;

      const anchor = document.createElement("a");
      anchor.className = "heading-anchor markdown-generated-link";
      anchor.dataset.markdownGeneratedLink = "true";
      anchor.href = `#${heading.id}`;
      anchor.setAttribute(
        "aria-label",
        `Link to ${heading.textContent || "heading"}`,
      );
      anchor.textContent = "#";
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        window.history.pushState(null, "", anchor.hash);
        lastScrolledHash = anchor.hash;
        scrollArticleTarget(heading);
      });
      heading.appendChild(anchor);
    });
  }

  function scrollArticleTarget(target: HTMLElement) {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    requestAnimationFrame(() =>
      target.scrollIntoView({
        block: "start",
        behavior: reduceMotion ? "auto" : "smooth",
      }),
    );
  }

  function scrollToCurrentHash() {
    if (!browser || !window.location.hash) return;

    const hash = window.location.hash;
    if (hash === lastScrolledHash) return;

    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {}

    const target = document.getElementById(id);
    if (!target || !contentContainer.contains(target)) return;

    lastScrolledHash = hash;
    scrollArticleTarget(target);
  }

  // QR codes hydrate into a real component (image + the full encoded value,
  // both click-to-copy) rather than a bare <img>, so the encoded string is
  // readable and copyable without a scanner. See.
  function mountQrCodes() {
    if (!contentContainer) return;

    const placeholders = Array.from(
      contentContainer.querySelectorAll<HTMLElement>(
        ".qrcode-embed[data-qr-value]",
      ),
    );

    for (const placeholder of placeholders) {
      const value = placeholder.getAttribute("data-qr-value");
      if (!value) continue;

      const container = document.createElement("div");
      placeholder.parentNode?.replaceChild(container, placeholder);

      const component = mount(MarkdownQrCode, {
        target: container,
        props: { value },
      });

      mountedComponents.push({ component, container });
    }
  }

  async function enhanceCodeBlocks(revision: number) {
    if (!isCurrentRender(revision)) {
      return;
    }

    const targets = Array.from(
      contentContainer.querySelectorAll<HTMLElement>("pre > code"),
    )
      .filter(
        (codeBlock) =>
          !codeBlock.classList.contains("language-mermaid") &&
          !codeBlock.classList.contains("lang-mermaid"),
      )
      .map((codeBlock) => ({ codeBlock, pre: codeBlock.parentElement }))
      .filter(
        (entry): entry is { codeBlock: HTMLElement; pre: HTMLElement } =>
          entry.pre instanceof HTMLElement &&
          entry.pre.dataset.enhanced !== "true",
      );

    if (targets.length === 0) {
      return;
    }

    for (const { codeBlock, pre } of targets) {
      if (pre.dataset.enhanced === "true" || !isCurrentRender(revision)) {
        continue;
      }

      const languageClass =
        Array.from(codeBlock.classList).find(
          (className) =>
            className.startsWith("language-") || className.startsWith("lang-"),
        ) || "";
      const info = getCodeLanguageInfo(languageClass);

      // Highlighting happens server-side (highlight.js in processMarkdown), so
      // the DOM here is already `<span class="code-line">`-wrapped. Recover the
      // author's source from those lines for the copy button; fall back to raw
      // text for pre-rendered HTML that did not come through processMarkdown.
      const renderedLines = Array.from(
        codeBlock.querySelectorAll<HTMLElement>(":scope > .code-line"),
      );
      const source = renderedLines.length
        ? renderedLines.map((line) => line.textContent || "").join("\n")
        : codeBlock.textContent || "";

      pre.dataset.enhanced = "true";

      const shell = document.createElement("div");
      shell.className = "code-block-shell";
      shell.dataset.wrap = wrapCodeBlocks ? "true" : "false";
      // The SSR `<pre dir="ltr">` survives the `cloneNode` below, but the shell
      // this wraps it in is created here and would otherwise inherit the
      // article's direction — so in an Arabic article the copy/wrap chrome and
      // the line-number gutter jumped sides the moment the page hydrated, while
      // the code inside stayed put. A code block is left-to-right all
      // the way out, chrome included.
      shell.dir = "ltr";

      const chromeHost = document.createElement("div");
      chromeHost.className = "code-block-chrome-host";
      shell.append(chromeHost, pre.cloneNode(true));
      pre.replaceWith(shell);

      const component = mount(CodeBlockChrome, {
        target: chromeHost,
        props: {
          languageLabel:
            info.language === "plaintext"
              ? $t("markdown.plainText", "Plain text")
              : info.label,
          onToggleWrap: toggleCodeWrap,
          onCopyCode: () => copyCodeBlock(source),
        },
      });

      mountedComponents.push({ component, container: chromeHost });
    }
  }

  async function renderMermaidDiagrams(revision: number) {
    if (!isCurrentRender(revision)) {
      return;
    }

    const mermaidBlocks = Array.from(
      contentContainer.querySelectorAll<HTMLElement>(
        "pre code.language-mermaid, pre code.lang-mermaid",
      ),
    );

    if (mermaidBlocks.length === 0) {
      return;
    }

    let mermaid: typeof import("mermaid").default | null = null;
    try {
      mermaid = await getMermaid();
    } catch (error) {
      console.error("Error loading Mermaid:", error);
      mermaid = null;
    }

    if (!mermaid || !isCurrentRender(revision)) {
      return;
    }

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: getMermaidTheme(),
    });

    for (const [index, block] of mermaidBlocks.entries()) {
      if (!isCurrentRender(revision)) {
        return;
      }

      const source = block.textContent?.trim();
      const pre = block.closest("pre");

      if (!pre || !source) {
        continue;
      }

      const container = document.createElement("div");
      container.className = "mermaid-diagram";

      try {
        const diagramId = `mermaid-${componentInstanceId}-${revision}-${index}`;
        const { svg, bindFunctions } = await mermaid.render(diagramId, source);

        if (!isCurrentRender(revision)) {
          return;
        }

        container.innerHTML = sanitizeMermaidSvg(svg);
        pre.replaceWith(container);
        bindFunctions?.(container);
      } catch (error) {
        if (!isCurrentRender(revision)) {
          return;
        }

        console.error("Error rendering Mermaid diagram:", error);
        container.classList.add("mermaid-diagram-error");
        container.innerHTML = `
          <pre><code class="language-mermaid">${escapeHtml(source)}</code></pre>
          <p class="mermaid-error-message">Unable to render Mermaid diagram.</p>
        `;
        pre.replaceWith(container);
      }
    }
  }

  async function refreshContent() {
    if (!contentContainer || isDestroyed) {
      return;
    }

    renderRevision += 1;
    const currentRevision = renderRevision;
    lastRenderedHtml = html;

    // Rebuilds happen for content changes and theme changes. Close before
    // replacing the DOM so the dialog never retains a detached trigger.
    closeLightbox(false);

    cleanupEmbeds();
    setContent();
    mountEmbeds();
    enhanceHeadings();
    await enhanceCodeBlocks(currentRevision);
    enhanceTables();
    mountQrCodes();
    enhanceImages();
    await renderMermaidDiagrams(currentRevision);
    scrollToCurrentHash();
  }

  onMount(() => {
    if (!contentContainer) return;
    isDestroyed = false;

    contentContainer.addEventListener("click", handleAuthorLinkClick);
    contentContainer.addEventListener("click", handleMarkdownImageClick);
    contentContainer.addEventListener("auxclick", handleAuthorLinkAuxClick);
    contentContainer.addEventListener("keydown", handleAuthorLinkKeydown);
    unsubscribeOutboundStorageSync = outboundLinkStore.startStorageSync();

    unsubscribeCodeWrap = codeWrapStore.subscribe((value) => {
      wrapCodeBlocks = value;
      applyCodeWrapToShells();
    });

    if (browser) {
      codeWrapStore.set(
        window.localStorage.getItem("markdown-code-wrap") === "true",
      );
    }

    void refreshContent();

    if (browser) {
      themeObserver = new MutationObserver(() => {
        void refreshContent();
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }

    return () => {
      isDestroyed = true;
      renderRevision += 1;
      cleanupEmbeds();
      contentContainer?.removeEventListener("click", handleAuthorLinkClick);
      contentContainer?.removeEventListener("click", handleMarkdownImageClick);
      contentContainer?.removeEventListener(
        "auxclick",
        handleAuthorLinkAuxClick,
      );
      contentContainer?.removeEventListener("keydown", handleAuthorLinkKeydown);
      unsubscribeOutboundStorageSync?.();
      unsubscribeOutboundStorageSync = null;
      warningOpen = false;
      pendingOutboundDestination = null;
      pendingOutboundLink = null;
      closeLightbox(false);
      unsubscribeCodeWrap?.();
      unsubscribeCodeWrap = null;
      themeObserver?.disconnect();
      themeObserver = null;
    };
  });

  afterUpdate(() => {
    // Only re-render when the source HTML actually changed. Re-rendering on
    // every update (e.g. the wrap toggle) needlessly rebuilds the article DOM.
    if (contentContainer && html !== lastRenderedHtml) {
      void refreshContent();
    }
  });
</script>

<!--
  `initialMarkup` is already sanitized by `sanitizeMarkdownHtml` (see above) —
  never put an unsanitized source in this slot.
-->
<div
  bind:this={contentContainer}
  class="markdown-content"
  data-ssr-body={bodyDeferredToClient ? "deferred" : undefined}
>
  {@html initialMarkup}
</div>

<OutboundLinkWarning
  bind:open={warningOpen}
  destination={pendingOutboundDestination}
  onDecision={handleOutboundLinkDecision}
/>

<MarkdownImageLightbox
  image={selectedImage}
  open={lightboxOpen}
  onOpenChange={handleLightboxOpenChange}
/>

<style>
  /*
   *a pasted Zcash address (100+ chars, no whitespace) used to overflow
   * the content column and put a horizontal scrollbar on the whole page.
   * User-generated content must wrap, always — `overflow-wrap` is inherited,
   * so this covers every descendant except `white-space: pre` code blocks,
   * which scroll inside their own shell on purpose.
   */
  .markdown-content {
    max-width: 100%;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /*
   * Program text is left-to-right even inside a right-to-left article (   * codex adversarial review). `dir="rtl"` on the container is INHERITED by
   * `<pre>` and `<code>` -- the UA stylesheet's `pre` rules set `white-space`,
   * not `direction` -- so `const total = 1;` renders with its semicolon on the
   * left and its indent on the wrong side, while the text a reader copies is
   * unchanged. That is code that lies about itself.
   *
   * `unicode-bidi: isolate` as well as `direction`, and for a reason: an
   * inline `<code>` inside an Arabic sentence must be laid out left-to-right
   * AND must not reorder the sentence around it. `direction` alone does the
   * first and not the second.
   *
   * Mermaid and the QR embed are here for the same reason at block level:
   * both mount generated content whose internal layout assumes LTR.
   */
  .markdown-content :global(pre),
  .markdown-content :global(code),
  .markdown-content :global(.code-block-shell),
  .markdown-content :global(.mermaid-diagram),
  .markdown-content :global(.markdown-qrcode) {
    direction: ltr;
    unicode-bidi: isolate;
  }

  .markdown-content :global(.markdown-table-scroll) {
    max-width: 100%;
    overflow-x: auto;
    overscroll-behavior-x: contain;
  }

  /* Inside its own scroll container the table no longer has to shrink to fit,
     so `break-word` is enough: long tokens still wrap, but unlike `anywhere`
     it does not drag the column's min-content width down with it. */
  .markdown-content :global(.markdown-table-scroll table) {
    overflow-wrap: break-word;
  }

  .markdown-content :global(.code-block-shell) {
    position: relative;
    margin: 1.5rem 0;
    border: 1px solid var(--border);
    border-radius: var(--f2z-radius-lg);
    overflow: hidden;
    /* One coherent code surface. The syntax theme
       (highlight.js github-dark-dimmed) is always dark, so the panel is a
       fixed, slightly-lifted near-black in both themes — no harsh pure-black
       inner zone. */
    background: #16161c;
  }

  /* Let the code sit directly on the shell surface; the highlight.js theme
     paints its own background on <pre>/<code>, so override it. */
  .markdown-content :global(.code-block-shell pre),
  .markdown-content :global(.code-block-shell code) {
    background: transparent !important;
  }

  .markdown-content :global(.code-block-chrome-host) {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .markdown-content :global(.code-block-shell pre) {
    position: relative;
    margin: 0;
    max-width: 100%;
    overscroll-behavior-x: contain;
    touch-action: pan-x pan-y;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
  }

  .markdown-content :global(.code-block-shell code) {
    display: block;
    padding: 3.25rem 1rem 0.9rem;
  }

  .markdown-content :global(.code-line) {
    display: block;
    min-height: 1.5em;
    padding-inline: 0.3rem;
  }

  .markdown-content :global(.code-line-highlighted) {
    background: color-mix(in srgb, var(--primary), transparent 84%);
    box-shadow: inset 3px 0 var(--primary);
  }

  .markdown-content :global(.show-line-numbers) {
    counter-reset: markdown-code-line;
  }

  .markdown-content :global(.show-line-numbers .code-line) {
    counter-increment: markdown-code-line;
  }

  .markdown-content :global(.show-line-numbers .code-line::before) {
    content: counter(markdown-code-line);
    display: inline-block;
    width: 2.5rem;
    margin-right: 1rem;
    color: color-mix(in srgb, currentColor, transparent 55%);
    text-align: right;
    user-select: none;
  }

  .markdown-content :global(.code-block-shell[data-wrap="false"] code) {
    min-width: max-content;
    white-space: pre;
  }

  .markdown-content :global(.code-block-shell[data-wrap="true"] pre) {
    overflow-x: visible;
  }

  .markdown-content :global(.code-block-shell[data-wrap="true"] code) {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  /* Inline code: strip the backtick quotes the `prose` plugin injects via
     code::before / code::after, and render a clean monospace chip. */
  .markdown-content :global(:not(pre) > code)::before,
  .markdown-content :global(:not(pre) > code)::after {
    content: none !important;
  }

  .markdown-content :global(:not(pre) > code) {
    max-width: 100%;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85em;
    font-weight: 500;
    overflow-wrap: anywhere;
    word-break: break-word;
    color: var(--foreground);
    background: color-mix(in srgb, var(--muted), transparent 25%);
    border: 1px solid var(--border);
    border-radius: var(--f2z-radius-sm);
    padding: 0.1em 0.36em;
  }

  .markdown-content :global(a) {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .markdown-content :global(.markdown-image-trigger) {
    display: block;
    max-width: 100%;
    margin: 2rem 0;
    padding: 0;
    border: 0;
    border-radius: 0.5rem;
    background: transparent;
    cursor: zoom-in;
    text-align: start;
  }

  .markdown-content :global(.markdown-image-trigger:focus-visible) {
    outline: 2px solid var(--ring);
    outline-offset: 4px;
  }

  .markdown-content :global(.markdown-image-trigger img) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0;
  }

  .markdown-content :global(.markdown-video),
  .markdown-content :global(.markdown-embed-image) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 1.5rem 0;
  }

  /* A first-party document/file/page embed: a plain link card, never a
     frame. One hover cue only (the border), per the hover discipline. */
  .markdown-content :global(.first-party-embed) {
    margin: 1.5rem 0;
  }

  .markdown-content :global(.first-party-embed-card) {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    max-width: 100%;
    padding: 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--card);
    color: var(--card-foreground);
    text-decoration: none;
    transition: border-color 150ms ease;
  }

  .markdown-content :global(.first-party-embed-card:hover) {
    border-color: var(--primary);
  }

  .markdown-content :global(.first-party-embed-card:focus-visible) {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .markdown-content :global(.first-party-embed-kind) {
    flex-shrink: 0;
    padding: 0.2rem 0.45rem;
    border-radius: 0.375rem;
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .markdown-content :global(.first-party-embed-name) {
    min-width: 0;
    overflow-wrap: anywhere;
    font-weight: 500;
  }

  /* A zPage/converse content card ( part 2): text only — title, excerpt,
     then `@author` and the destination it links to. */
  .markdown-content :global(.first-party-embed-body) {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.35rem;
  }

  .markdown-content :global(.first-party-embed-title) {
    font-weight: 600;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .markdown-content :global(.first-party-embed-excerpt) {
    color: var(--muted-foreground);
    font-size: 0.9rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .markdown-content :global(.first-party-embed-meta) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    color: var(--muted-foreground);
    font-size: 0.8rem;
  }

  .markdown-content :global(.first-party-embed-meta .first-party-embed-name) {
    font-weight: 400;
  }

  .markdown-content :global(h1[id]),
  .markdown-content :global(h2[id]),
  .markdown-content :global(h3[id]),
  .markdown-content :global(h4[id]),
  .markdown-content :global(h5[id]),
  .markdown-content :global(h6[id]),
  .markdown-content :global(.footnotes li[id]) {
    scroll-margin-top: 6rem;
  }

  .markdown-content :global(.heading-anchor) {
    /* Logical, not `margin-left`: the anchor follows its heading's text, and in
       an RTL article that heading ends on the left. */
    margin-inline-start: 0.45em;
    color: var(--primary);
    font-weight: 500;
    text-decoration: none;
    opacity: 0;
    transition: opacity 120ms ease;
  }

  .markdown-content :global(h1:hover > .heading-anchor),
  .markdown-content :global(h2:hover > .heading-anchor),
  .markdown-content :global(h3:hover > .heading-anchor),
  .markdown-content :global(h4:hover > .heading-anchor),
  .markdown-content :global(h5:hover > .heading-anchor),
  .markdown-content :global(h6:hover > .heading-anchor),
  .markdown-content :global(.heading-anchor:focus-visible) {
    opacity: 1;
  }

  .markdown-content :global(.footnotes) {
    margin-top: 2.5rem;
    border-top: 1px solid var(--border);
    padding-top: 1rem;
    font-size: 0.9em;
  }

  .markdown-content :global(.sr-only) {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    clip-path: inset(50%);
  }
</style>
