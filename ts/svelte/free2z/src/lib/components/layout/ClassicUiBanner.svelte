<script lang="ts">
  import { X, ArrowLeftRight } from "@lucide/svelte";
  import { CLASSIC_UI_PATH, classicUiAvailable } from "$lib/utils/classic-ui";

  // Mirrors TryNewUIBanner in the classic React UI: persistent but
  // dismissible, so people who opted in weeks ago can always find the
  // way back. Bump the version suffix to re-show after dismissal.
  const DISMISSED_KEY = "f2z-classic-ui-banner-dismissed-v1";

  let visible = $state(false);

  // $effect runs client-side only, so localStorage/host checks are safe
  // and SSR renders nothing (no hydration flash).
  $effect(() => {
    visible = classicUiAvailable() && !localStorage.getItem(DISMISSED_KEY);
  });

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, new Date().toISOString());
    visible = false;
  }
</script>

{#if visible}
  <div
    class="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center p-3"
  >
    <div
      class="pointer-events-auto flex items-center gap-3 rounded-lg border border-(--f2z-border-primary) bg-(--f2z-bg-secondary)/95 px-4 py-2 shadow-lg backdrop-blur"
    >
      <span class="text-sm text-(--f2z-text-secondary)"
        >You're trying the new Free2z</span
      >
      <a
        href={CLASSIC_UI_PATH}
        data-sveltekit-reload
        class="flex items-center gap-1.5 text-sm font-medium whitespace-nowrap text-(--f2z-accent-primary) no-underline hover:underline"
      >
        <ArrowLeftRight class="h-3.5 w-3.5" />
        Switch back
      </a>
      <button
        type="button"
        aria-label="Dismiss"
        class="cursor-pointer text-(--f2z-text-muted) transition-colors hover:text-(--f2z-text-primary)"
        onclick={dismiss}
      >
        <X class="h-4 w-4" />
      </button>
    </div>
  </div>
{/if}
