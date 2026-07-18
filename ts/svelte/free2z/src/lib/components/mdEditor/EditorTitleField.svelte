<script lang="ts">
  import { t } from '$lib/i18n';

  interface Props {
    value: string;
    error?: string;
    onChange?: () => void;
    onSubmit?: () => void;
  }

  let {
    value = $bindable(),
    error,
    onChange,
    onSubmit,
  }: Props = $props();

  let textareaRef = $state<HTMLTextAreaElement | null>(null);

  function resize() {
    if (!textareaRef) {
      return;
    }

    textareaRef.style.height = 'auto';
    textareaRef.style.height = `${textareaRef.scrollHeight}px`;
  }

  function handleInput() {
    // Titles are single-line; pasted text may carry newlines.
    if (value.includes('\n')) {
      value = value.replace(/\s*\n+\s*/g, ' ');
    }

    resize();
    onChange?.();
  }

  $effect(() => {
    value;
    queueMicrotask(resize);
  });
</script>

<div>
  <textarea
    bind:this={textareaRef}
    bind:value
    placeholder={t('editor.titlePlaceholder', 'Article title...')}
    class="w-full resize-none overflow-hidden border-none bg-transparent font-inherit text-4xl font-bold leading-tight outline-none md:text-5xl {error ? 'text-[#c00]' : 'text-foreground'}"
    rows="1"
    oninput={handleInput}
    onkeydown={(event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onSubmit?.();
      }
    }}
  ></textarea>

  {#if error}
    <p class="mb-2 mt-1 text-sm text-red-500">{error}</p>
  {/if}
</div>
