<script module lang="ts">
  let markdownContentInstanceSequence = 0;
</script>

<script lang="ts">
  import { browser } from "$app/environment";
  import { onMount, afterUpdate } from "svelte";
  import { mount, unmount } from "svelte";
  import QRCode from "qrcode";
  import ExternalEmbed from "./ExternalEmbed.svelte";
  import MarkdownAudio from "./MarkdownAudio.svelte";
  import CodeBlockChrome from "./CodeBlockChrome.svelte";
  import { getCodeLanguageInfo } from "$lib/utils/markdown";
  import { sanitizeMarkdownHtml } from "$lib/utils/markdown-sanitize";

  export let html: string;

  let contentContainer: HTMLDivElement;
  let mountedComponents: Array<{ component: any; container: HTMLElement }> = [];
  let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
  let renderRevision = 0;
  let themeObserver: MutationObserver | null = null;
  let wrapCodeBlocks = false;
  let lastScrolledHash = "";
  const componentInstanceId = ++markdownContentInstanceSequence;

  function escapeHtml(content: string) {
    return content
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function toggleCodeWrap() {
    wrapCodeBlocks = !wrapCodeBlocks;

    if (browser) {
      window.localStorage.setItem(
        "markdown-code-wrap",
        wrapCodeBlocks ? "true" : "false",
      );
    }

    void refreshContent();
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
        unmount(component);
      } catch {}
    });
    mountedComponents = [];
  }

  function setContent() {
    if (!contentContainer) return;
    // processMarkdown already sanitizes. Keep a second pass here as defense in
    // depth because callers may also pass pre-rendered HTML to this component.
    contentContainer.innerHTML = sanitizeMarkdownHtml(html || "");
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
      mermaidPromise = import("mermaid").then((module) => module.default);
    }

    return mermaidPromise;
  }

  function mountEmbeds() {
    cleanupEmbeds();
    if (!contentContainer || !html) return;

    const placeholders = contentContainer.querySelectorAll(
      ".external-embed-placeholder",
    );

    placeholders.forEach((placeholder) => {
      const url = placeholder.getAttribute("data-embed-url");
      if (!url) return;

      const container = document.createElement("div");
      placeholder.parentNode?.replaceChild(container, placeholder);

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

      const container = document.createElement("div");
      placeholder.parentNode?.replaceChild(container, placeholder);

      const component = mount(MarkdownAudio, {
        target: container,
        props: { src },
      });

      mountedComponents.push({ component, container });
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
      anchor.className = "heading-anchor";
      anchor.href = `#${heading.id}`;
      anchor.setAttribute(
        "aria-label",
        `Link to ${heading.textContent || "heading"}`,
      );
      anchor.textContent = "#";
      heading.appendChild(anchor);
    });
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
    requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
  }

  async function mountQrCodes(revision: number) {
    if (!contentContainer) return;

    const placeholders = Array.from(
      contentContainer.querySelectorAll<HTMLElement>(
        ".qrcode-embed[data-qr-value]",
      ),
    );

    for (const placeholder of placeholders) {
      const value = placeholder.getAttribute("data-qr-value");
      if (!value) continue;

      try {
        const dataUrl = await QRCode.toDataURL(value, {
          margin: 1,
          width: 256,
          color: { dark: "#000000", light: "#ffffff" },
        });

        if (revision !== renderRevision) return;

        const wrapper = document.createElement("div");
        wrapper.className = "markdown-qrcode";

        const img = document.createElement("img");
        img.src = dataUrl;
        img.alt = `QR code for ${value}`;
        img.loading = "lazy";
        img.decoding = "async";
        wrapper.appendChild(img);

        placeholder.replaceWith(wrapper);
      } catch (error) {
        console.error("Error rendering QR code:", error);
        // Fall back to showing the raw value rather than a blank box.
        placeholder.textContent = value;
      }
    }
  }

  function enhanceCodeBlocks() {
    if (!contentContainer) {
      return;
    }

    const codeBlocks = Array.from(
      contentContainer.querySelectorAll<HTMLElement>("pre > code"),
    );

    codeBlocks.forEach((codeBlock) => {
      if (
        codeBlock.classList.contains("language-mermaid") ||
        codeBlock.classList.contains("lang-mermaid")
      ) {
        return;
      }

      const pre = codeBlock.parentElement;
      if (!(pre instanceof HTMLElement) || pre.dataset.enhanced === "true") {
        return;
      }

      const languageClass =
        Array.from(codeBlock.classList).find(
          (className) =>
            className.startsWith("language-") || className.startsWith("lang-"),
        ) || "";
      const info = getCodeLanguageInfo(languageClass);
      const renderedLines = Array.from(
        codeBlock.querySelectorAll<HTMLElement>(":scope > .code-line"),
      );
      const source = renderedLines.length
        ? renderedLines.map((line) => line.textContent || "").join("\n")
        : codeBlock.textContent || "";

      const shell = document.createElement("div");
      shell.className = "code-block-shell";
      shell.dataset.wrap = wrapCodeBlocks ? "true" : "false";

      const chromeHost = document.createElement("div");
      chromeHost.className = "code-block-chrome-host";
      shell.append(chromeHost, pre.cloneNode(true));
      pre.replaceWith(shell);

      const component = mount(CodeBlockChrome, {
        target: chromeHost,
        props: {
          languageLabel: info.label,
          wrapEnabled: wrapCodeBlocks,
          onToggleWrap: toggleCodeWrap,
          onCopyCode: () => copyCodeBlock(source),
        },
      });

      mountedComponents.push({ component, container: chromeHost });
    });
  }

  async function renderMermaidDiagrams(revision: number) {
    if (!contentContainer) {
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

    const mermaid = await getMermaid();
    if (!mermaid || revision !== renderRevision) {
      return;
    }

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: getMermaidTheme(),
    });

    for (const [index, block] of mermaidBlocks.entries()) {
      if (revision !== renderRevision) {
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

        if (revision !== renderRevision) {
          return;
        }

        container.innerHTML = svg;
        pre.replaceWith(container);
        bindFunctions?.(container);
      } catch (error) {
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
    if (!contentContainer) {
      return;
    }

    renderRevision += 1;
    const currentRevision = renderRevision;

    setContent();
    mountEmbeds();
    enhanceHeadings();
    enhanceCodeBlocks();
    void mountQrCodes(currentRevision);
    await renderMermaidDiagrams(currentRevision);
    scrollToCurrentHash();
  }

  onMount(() => {
    if (!contentContainer) return;

    if (browser) {
      wrapCodeBlocks =
        window.localStorage.getItem("markdown-code-wrap") === "true";
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
      cleanupEmbeds();
      themeObserver?.disconnect();
      themeObserver = null;
    };
  });

  afterUpdate(() => {
    if (contentContainer) {
      void refreshContent();
    }
  });
</script>

<div bind:this={contentContainer} class="markdown-content"></div>

<style>
  .markdown-content :global(.code-block-shell) {
    position: relative;
    margin: 1.5rem 0;
    border: 1px solid var(--border);
    border-radius: 0.65rem;
    overflow: hidden;
    background: color-mix(in srgb, var(--card), transparent 8%);
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
    padding: 2.35rem 1rem 0.9rem;
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

  .markdown-content :global(.markdown-video),
  .markdown-content :global(.markdown-embed-image) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 1.5rem 0;
  }

  .markdown-content :global(.markdown-qrcode) {
    display: flex;
    justify-content: center;
    margin: 1.5rem 0;
  }

  .markdown-content :global(.markdown-qrcode img) {
    width: 256px;
    max-width: 100%;
    height: auto;
    padding: 0.75rem;
    background: #ffffff;
    border-radius: 0.65rem;
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
    margin-left: 0.45em;
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
