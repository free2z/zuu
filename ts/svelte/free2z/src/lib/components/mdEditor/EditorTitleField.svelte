<script lang="ts">
  import { onMount } from "svelte";
  import { tStore as t } from "$lib/i18n";

  interface Props {
    value: string;
    error?: string;
    onChange?: () => void;
    onSubmit?: () => void;
  }

  let { value = $bindable(), error, onChange, onSubmit }: Props = $props();

  let textareaRef = $state<HTMLTextAreaElement | null>(null);
  let resizeFrame: number | null = null;

  function resize() {
    if (!textareaRef) {
      return;
    }

    textareaRef.style.height = "auto";
    textareaRef.style.height = `${textareaRef.scrollHeight}px`;
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
    }}
  ></textarea>

  {#if error}
    <p class="mt-1 mb-2 text-sm text-red-500">{error}</p>
  {/if}
</div>
