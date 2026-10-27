<script lang="ts">
  import { onMount } from "svelte";
  import { X, ArrowLeftRight } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import { page } from "$app/state";
  import {
    classicUiAvailable,
    classicUiSwitchHref,
  } from "$lib/utils/classic-ui";

  const classicUiHref = $derived(
    classicUiSwitchHref(page.url.pathname, page.url.search, page.url.hash),
  );

  // Mirrors TryNewUIBanner in the classic React UI: dismissible, so people who
  // opted in weeks ago can always find the way back. Bump the version suffix to
  // re-show after dismissal.
  const DISMISSED_KEY = "f2z-classic-ui-banner-dismissed-v1";

  //this used to sit over page content until manually dismissed, and on
  // mobile it stacked with the reCAPTCHA badge and the article FAB. It is a
  // snackbar now — it retires itself.
  //
  // Auto-dismiss deliberately does NOT write DISMISSED_KEY: timing out means
  // "you probably didn't read it", so the notice comes back next visit, while
  // the ✕ means "stop showing me this" and persists. Nobody is stranded either
  // way — Navbar and AuthUserDropdown carry the same "Switch back" link.
  const AUTO_DISMISS_MS = 8000;

  let visible = $state(false);
  // Hover and focus are tracked separately, not folded into one flag: a mouse
  // user who hovers, tabs to "Switch back", then moves the pointer away would
  // otherwise have pointerleave clear a hold that focus still owns, and the
  // focused control would disappear mid-interaction.
  let hovered = $state(false);
  let focusWithin = $state(false);
  // While held, the countdown is suspended, so the "Switch back" link never
  // vanishes out from under someone reading it or tabbing to it.
  let held = $derived(hovered || focusWithin);
  // Measured height of the whole docked strip (card + its padding). Published
  // as a CSS variable so other bottom-docked chrome — the article FAB in
  // PageActions.svelte — can lift clear of it instead of landing on top.
  let dockHeight = $state(0);

  // onMount, not $effect: this must decide visibility exactly once. An $effect
  // would be free to re-run later and resurrect a snackbar that already timed
  // out. It is client-only either way, so SSR renders nothing (no hydration
  // flash) and localStorage/host checks are safe.
  onMount(() => {
    visible = classicUiAvailable() && !localStorage.getItem(DISMISSED_KEY);
  });

  // The timer lives in an effect purely so Svelte owns its teardown: it is
  // cleared on unmount and on every navigation-triggered re-run, so a pending
  // dismissal can never fire against a destroyed component.
  $effect(() => {
    if (!visible || held) return;
    const timer = setTimeout(() => {
      visible = false;
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  });

  // Keep the published height in sync, and make sure it goes back to 0 when the
  // snackbar leaves — otherwise the FAB would stay lifted forever.
  $effect(() => {
    const height = visible ? dockHeight : 0;
    document.documentElement.style.setProperty(
      "--f2z-bottom-dock-height",
      `${height}px`,
    );
    return () => {
      document.documentElement.style.removeProperty("--f2z-bottom-dock-height");
    };
  });

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, new Date().toISOString());
    visible = false;
  }
</script>

{#if visible}
  <!--
    No aria-live/role="status" on purpose. The snackbar is inserted right after
    mount, not in response to anything the user did, so announcing it would
    interrupt whatever they are actually doing — and an announcement racing an
    8s timer is worse than none. role="note" is the quiet, non-live role that
    matches (and it satisfies the a11y lint for a container carrying pointer
    handlers).

    Known trade-off, accepted: a screen-reader user browsing with a virtual
    cursor never fires the focus handlers that pause the countdown, so the
    notice can time out before they reach it. It is a redundant affordance —
    Navbar and AuthUserDropdown both carry the same "Switch back" link — and
    timing out does not persist, so it is offered again on the next page load.
  -->
  <div
    class="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center p-3"
    bind:clientHeight={dockHeight}
  >
    <!--
      Wraps rather than truncates. "Switch back" is 11 characters in English but
      "Volver a la versión anterior" in Spanish, which alone is wider than the
      space left beside a 44px close button at 320px — so below `sm` the notice
      claims its own row (w-full) and the link + ✕ sit underneath it. Nothing in
      here is nowrap or fixed-width except the ✕ itself.
    -->
    <div
      class="pointer-events-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-(--f2z-border-primary) bg-(--f2z-bg-secondary)/95 py-1 pr-1 pl-4 shadow-lg backdrop-blur"
      role="note"
      onpointerenter={() => (hovered = true)}
      onpointerleave={() => (hovered = false)}
      onfocusin={() => (focusWithin = true)}
      onfocusout={() => (focusWithin = false)}
    >
      <span
        class="w-full min-w-0 text-sm break-words text-(--f2z-text-secondary) sm:w-auto"
        >{$t(
          "navigation.newSiteNotice",
          "You're trying the new version of Free2Z",
        )}</span
      >
      <a
        href={classicUiHref}
        data-sveltekit-reload
        class="flex min-w-0 items-center gap-1.5 text-sm font-medium break-words text-(--f2z-accent-primary) no-underline hover:underline"
      >
        <ArrowLeftRight class="h-3.5 w-3.5 shrink-0" />
        {$t("navigation.switchBack", "Switch back")}
      </a>
      <button
        type="button"
        aria-label={$t("navigation.dismiss", "Dismiss")}
        class="ml-auto flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--f2z-text-muted) transition-colors hover:text-(--f2z-text-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary) focus-visible:outline-none"
        onclick={dismiss}
      >
        <X class="h-5 w-5" />
      </button>
    </div>
  </div>
{/if}
