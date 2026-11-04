<script lang="ts">
  import { onMount } from "svelte";
  import { tStore as t } from "$lib/i18n";
  import { autoGrowTextarea } from "./autoGrow";

  interface Props {
    value: string;
    error?: string;
    /**
     * The direction the TITLE is written in — the article's, never the
     * creator's UI locale. `"auto"` while the language is unknown,
     * which on a `<textarea>` the browser re-resolves on every keystroke.
     */
    direction?: "ltr" | "rtl" | "auto";
    /** The title's content language, or undefined for an unlabelled draft. */
    language?: string;
    onChange?: () => void;
    onSubmit?: () => void;
  }

  let {
    value = $bindable(),
    error,
    direction = "auto",
    language,
    onChange,
    onSubmit,
  }: Props = $props();

  let textareaRef = $state<HTMLTextAreaElement | null>(null);
  let resizeFrame: number | null = null;

  // Same auto-grow, same hazard as the body: the title lives on the
  // same scroll-the-document `/edit` page, so its collapse clamps the page
  // scroll too. The symptom is milder only because a title is one or two lines
  // the mechanism is identical. No height floor here: the title hugs its
  // content.
  function resize() {
    autoGrowTextarea(textareaRef);
  }

  function scheduleResize() {
    if (resizeFrame !== null) {
      cancelAnimationFrame(resizeFrame);
    }

    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      resize();
    });
  }

  function handleInput() {
    // Titles are single-line; pasted text may carry newlines.
    if (value.includes("\n")) {
      value = value.replace(/\s*\n+\s*/g, " ");
    }

    resize();
    onChange?.();
  }

  $effect(() => {
    value;
    queueMicrotask(resize);
  });

  onMount(() => {
    if (!textareaRef) {
      return;
    }

    let observedWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width ?? 0;

      if (nextWidth !== observedWidth) {
        observedWidth = nextWidth;
        scheduleResize();
      }
    });

    observer.observe(textareaRef);
    void document.fonts?.ready.then(() => {
      if (observedWidth >= 0) {
        scheduleResize();
      }
    });

    return () => {
      observedWidth = -1;
      observer.disconnect();

      if (resizeFrame !== null) {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
      }
    };
  });
</script>

<svelte:window onresize={scheduleResize} />

<div>
  <textarea
    bind:this={textareaRef}
    bind:value
    dir={direction}
    lang={language}
    placeholder={$t("editor.titlePlaceholder", "Article title...")}
    class="font-inherit w-full resize-none overflow-hidden border-none bg-transparent text-4xl leading-tight font-bold outline-none md:text-5xl {error
      ? 'text-[#c00]'
      : 'text-foreground'}"
    rows="1"
    oninput={handleInput}
    onkeydown={(event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onSubmit?.();
      }
    }}></textarea>

  {#if error}
    <p class="mt-1 mb-2 text-sm text-red-500">{error}</p>
  {/if}
</div>
