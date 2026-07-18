<script module lang="ts">
  let markdownContentInstanceSequence = 0;
</script>

<script lang="ts">
  import { browser } from "$app/environment";
  import { onMount, afterUpdate } from "svelte";
  import { mount, unmount } from "svelte";
  import DOMPurify from "isomorphic-dompurify";
  import ExternalEmbed from "./ExternalEmbed.svelte";
  import CodeBlockChrome from "./CodeBlockChrome.svelte";
  import { getCodeLanguageInfo } from "$lib/utils/markdown";

  export let html: string;

  let contentContainer: HTMLDivElement;
  let mountedComponents: Array<{ component: any; container: HTMLElement }> = [];
  let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
  let renderRevision = 0;
  let themeObserver: MutationObserver | null = null;
  let wrapCodeBlocks = false;
  const componentInstanceId = ++markdownContentInstanceSequence;

  const markdownSanitizeOptions = {
    ADD_TAGS: ["video", "source"],
    ADD_ATTR: [
      "aria-hidden",
      "class",
      "data-embed-url",
      "href",
      "src",
      "title",
      "alt",
    ],
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|tel):|\/(?!\/)|#|[^:/?#]*(?:[/?#]|$))/i,
  };

  function escapeHtml(content: string) {
    return content
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function sanitizeHtml(content: string) {
    return DOMPurify.sanitize(content, markdownSanitizeOptions);
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
    contentContainer.innerHTML = sanitizeHtml(html || "");
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
      const source = codeBlock.textContent || "";

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
    enhanceCodeBlocks();
    await renderMermaidDiagrams(currentRevision);
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
</style>
