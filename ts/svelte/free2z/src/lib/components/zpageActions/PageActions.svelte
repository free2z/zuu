<script lang="ts">
  import { onMount, tick } from "svelte";
  import { Flag, HeartHandshake, Pencil, X } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import ProfileDonate from "$lib/components/profile/ProfileDonate.svelte";
  import ReportDialog from "$lib/components/moderation/ReportDialog.svelte";
  import { authStore } from "$lib/stores/auth";
  import { requestLogin } from "$lib/stores/auth-modal";
  import { tStore as t } from "$lib/i18n";
  import { editorArticleHref } from "$lib/zpage-language.js";
  import BoostButton from "./BoostButton.svelte";
  import InsufficientFunds from "$lib/components/InsufficientFunds.svelte";
  import type { InsufficientFundsDetails } from "$lib/insufficient-funds";
  import { toastPresentation } from "$lib/toast.js";
  import ShareButton from "./ShareButton.svelte";

  export let article: any = null;
  export let score: string | number | null = null;
  export let navigationPending = false;
  export let onScoreChange: (
    score: string,
    pageId: string,
    phase?: "pending" | "authoritative",
  ) => void = () => {};

  type BoostOutcome = {
    pageId: string | null;
    generation: number;
    message: string | null;
    funds: InsufficientFundsDetails | null;
  };
  let boostOutcome: BoostOutcome | null = null;
  $: visibleBoostOutcome =
    boostOutcome?.pageId === article?.free2zaddr &&
    boostOutcome?.generation === $toastPresentation.generation &&
    (boostOutcome.message || boostOutcome.funds)
      ? boostOutcome
      : null;
  function handleBoostOutcome(outcome: BoostOutcome) {
    if (outcome.pageId === article?.free2zaddr) boostOutcome = outcome;
  }
  let expanded = false;
  let reportOpen = false;
  let menuActive = false;
  let modalActive = false;
  let actionRoot: HTMLElement;

  const overlaySelector = '[data-slot$="-overlay"]';

  onMount(() => {
    const updateModalState = () => {
      // UI portals mount overlays as direct body children. Limiting the scan to
      // that boundary prevents sanitized article data-* attributes from
      // spoofing modal state, and presence (rather than data-state="open")
      // keeps actions covered throughout the overlay's exit animation.
      modalActive = Array.from(document.body.children).some((child) =>
        child.matches(overlaySelector),
      );
    };
    const observer = new MutationObserver(updateModalState);
    observer.observe(document.body, {
      childList: true,
    });
    updateModalState();
    return () => observer.disconnect();
  });

  /**
   * Self-contained action chips — no shared panel chrome.
   */
  const railItemClass =
    "page-action-chip-btn relative h-9 w-auto min-w-0 max-w-[calc(100vw-2rem)] rounded-full px-3 py-0 gap-1.5 justify-center border border-border/60 bg-background text-sm font-medium text-foreground shadow-xs after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] dark:bg-card dark:border-border/50 dark:shadow-none focus-visible:ring-2 focus-visible:ring-ring/40 [&>span]:truncate";

  $: isOwner =
    !!$authStore.creator?.username &&
    $authStore.creator.username === article?.creator?.username;
  $: editHref = editorArticleHref(
    article?.free2zaddr || article?.vanity || "",
    article?.actual_language,
    article?.source_language,
  );

  function closeActions() {
    if (menuActive) return;
    expanded = false;
  }

  function handleFocusOut(event: FocusEvent) {
    const nextTarget = event.relatedTarget as Node | null;
    if (!nextTarget || !actionRoot?.contains(nextTarget)) closeActions();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && expanded && !menuActive) {
      expanded = false;
      actionRoot
        ?.querySelector<HTMLButtonElement>(".page-action-trigger")
        ?.focus();
    }
  }

  //the in-app report path Play's UGC policy requires. Anonymous
  // readers are asked to sign in first; the API only takes reports from
  // accounts.
  function openReport() {
    expanded = false;
    if (!$authStore.isAuthenticated) {
      requestLogin();
      return;
    }
    reportOpen = true;
  }

  function toggleActions() {
    expanded = !expanded;
  }

  function handlePointerEnter(event: PointerEvent) {
    if (event.pointerType === "mouse") expanded = true;
  }

  function handlePointerLeave(event: PointerEvent) {
    if (event.pointerType === "mouse") closeActions();
  }

  function handlePointerMove(event: PointerEvent) {
    if (event.pointerType !== "mouse" || !expanded || menuActive) return;

    const target = event.target;
    if (
      !(target instanceof Element) ||
      !target.closest(".page-action-trigger, .page-action-tree")
    ) {
      closeActions();
    }
  }

  async function handleMenuClose() {
    menuActive = false;
    await tick();
    if (!actionRoot?.contains(document.activeElement)) expanded = false;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<aside
  bind:this={actionRoot}
  class="page-action-dock fixed right-4 flex flex-col-reverse items-end sm:right-6"
  class:is-modal-active={modalActive}
  aria-label={$t("pageActions.actions.label", "Page actions")}
  onfocusout={handleFocusOut}
  onpointerleave={handlePointerLeave}
  onpointermove={handlePointerMove}
>
  <!-- Neutral utility trigger; Signal Lime remains reserved for direct actions. -->
  <Button
    size="icon-lg"
    variant="outline"
    class="page-action-trigger pointer-events-auto size-11 shrink-0 rounded-full border-border/70 bg-card text-foreground shadow-xs transition-colors duration-150 ease-out hover:border-primary/40 hover:bg-muted hover:text-foreground active:bg-muted/80 motion-reduce:transition-none dark:bg-card dark:shadow-none dark:hover:bg-muted"
    onclick={toggleActions}
    onpointerenter={handlePointerEnter}
    aria-expanded={expanded}
    aria-controls="page-action-tree"
    aria-label={expanded
      ? $t("pageActions.actions.close", "Close page actions")
      : $t("pageActions.actions.open", "Open page actions")}
    title={$t("pageActions.actions.label", "Page actions")}
  >
    {#if expanded}
      <X class="size-[1.125rem]" strokeWidth={1.75} aria-hidden="true" />
    {:else}
      <HeartHandshake
        class="size-[1.125rem]"
        strokeWidth={1.75}
        aria-hidden="true"
      />
    {/if}
  </Button>

  <!-- Labeled action stack — staggered entrance, no wrapper chrome -->
  <div
    id="page-action-tree"
    class="page-action-tree flex origin-bottom-right flex-col items-end gap-1.5 pb-2.5 {expanded
      ? 'is-open pointer-events-auto visible'
      : 'pointer-events-none invisible'}"
    style="--chip-count: {isOwner ? 2 : 4}"
    aria-hidden={!expanded}
    aria-label={$t(
      "pageActions.actions.group",
      "Page support and sharing actions",
    )}
    role="group"
    inert={!expanded}
  >
    {#if isOwner}
      <div class="page-action-chip" style="--i: 0">
        <Button
          href={editHref}
          size="sm"
          variant="outline"
          class={railItemClass}
          aria-label={$t("pageActions.actions.edit", "Edit page")}
          title={$t("pageActions.actions.edit", "Edit page")}
        >
          <Pencil class="size-4 shrink-0" strokeWidth={1.75} />
          <span>{$t("pageActions.actions.editShort", "Edit")}</span>
        </Button>
      </div>
    {:else}
      <div class="page-action-chip" style="--i: 0">
        <Button
          size="sm"
          variant="outline"
          class={railItemClass}
          onclick={openReport}
          aria-label={$t("moderation.report.titleZpage", "Report page")}
          title={$t("moderation.report.titleZpage", "Report page")}
          data-testid="page-action-report"
        >
          <Flag class="size-4 shrink-0" strokeWidth={1.75} />
          <span>{$t("moderation.report.action", "Report")}</span>
        </Button>
      </div>
      <div class="page-action-chip" style="--i: 1">
        <ProfileDonate
          creator={article?.creator}
          pageId={article?.free2zaddr}
          pageTitle={article?.title}
          pageAddress={article?.p2paddr}
          triggerLabel={$t("pageActions.actions.support", "Support")}
          triggerIconOnly={false}
          triggerVariant="outline"
          triggerClass={railItemClass}
          {navigationPending}
        />
      </div>
      <div class="page-action-chip" style="--i: 2">
        <BoostButton
          pageId={article?.free2zaddr}
          score={score ?? article?.f2z_score}
          {onScoreChange}
          onPaymentOutcome={handleBoostOutcome}
          presentOutcomeInline={expanded}
          showLabel={true}
          buttonVariant="outline"
          buttonClass={railItemClass}
        />
      </div>
    {/if}
    <div class="page-action-chip" style="--i: {isOwner ? 1 : 3}">
      <ShareButton
        {article}
        showLabel={true}
        triggerVariant="outline"
        triggerClass={railItemClass}
        onOpen={() => {
          menuActive = true;
          expanded = true;
        }}
        onClose={handleMenuClose}
      />
    </div>
  </div>
</aside>

{#if visibleBoostOutcome && !expanded && !modalActive}
  <div
    class="fixed top-20 right-4 z-40 max-h-[40dvh] w-[min(22rem,calc(100vw-2rem))] overflow-auto rounded-lg border border-destructive/40 bg-background p-3 shadow-lg sm:right-6"
    data-testid="boost-payment-outcome"
  >
    <button
      type="button"
      class="float-right ml-2 rounded p-1 hover:bg-muted focus-visible:ring-2"
      aria-label={$t("navigation.dismiss", "Dismiss")}
      onclick={() => (boostOutcome = null)}><X class="size-4" /></button
    >
    {#if visibleBoostOutcome.message}<p
        role="alert"
        data-testid="payment-outcome-error"
        class="text-sm text-destructive"
      >
        {visibleBoostOutcome.message}
      </p>{/if}
    {#if visibleBoostOutcome.funds}<InsufficientFunds
        funds={visibleBoostOutcome.funds}
        introHref="/edit"
      />{/if}
  </div>
{/if}

{#if !isOwner && article?.free2zaddr}
  <ReportDialog
    bind:open={reportOpen}
    kind="zpage"
    targetId={article.free2zaddr}
  />
{/if}

<style>
  /*
   *the bottom-right corner stacks this rail, the reCAPTCHA badge and the
   * classic-UI snackbar, and the expanded FAB's close button landed on top of
   * the snackbar's "Switch back" link. ClassicUiBanner publishes its measured
   * height as --f2z-bottom-dock-height (0 / unset when it is gone), so the rail
   * rides above whatever is docked down there.
   *
   * No breakpoint guard on purpose. The obvious optimisation — skip the lift on
   * wide viewports, where a centered snackbar "obviously" cannot reach a
   * right-hand rail — is a translation-length bet that already loses: the
   * Spanish/Portuguese notice is ~583px wide, so at a 640px viewport it runs to
   * x≈601 while this rail starts at x≈572. Both are z-40. Lifting whenever
   * something is docked is unconditionally correct and matches how FABs behave
   * around snackbars generally.
   */
  .page-action-dock {
    /*
     * Normal page chrome is persistent, so it wins over transient z-60 toasts;
     * its portaled menus sit at z-80 so they remain above their owning rail.
     * When a modal overlay opens, the ordering deliberately changes to
     * toast (60) > modal (50) > page actions (40): payment/error feedback stays
     * visible while the underlying rail cannot pierce the modal.
     */
    z-index: 70;
    max-height: calc(
      100dvh - 4rem - max(1rem, calc(env(safe-area-inset-bottom) + 0.75rem)) -
        var(--f2z-bottom-dock-height, 0px)
    );
    bottom: calc(
      max(1rem, calc(env(safe-area-inset-bottom) + 0.75rem)) +
        var(--f2z-bottom-dock-height, 0px)
    );
    transition: bottom 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .page-action-dock.is-modal-active {
    z-index: 40;
  }

  .page-action-tree {
    min-height: 0;
    overflow-y: auto;
  }

  /* Entrance: chips rise in with a short stagger */
  .page-action-chip {
    display: flex;
    justify-content: flex-end;
    opacity: 1;
    transform: translate3d(0, 4px, 0);
    transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
    transition-delay: 0ms;
  }

  .page-action-tree.is-open .page-action-chip {
    transform: translate3d(0, 0, 0);
    /* Bottom-most chip arrives first (nearest the FAB), then upward */
    transition-delay: calc((var(--chip-count, 3) - 1 - var(--i, 0)) * 45ms);
  }

  /* Hover: color only — no lift, scale, or shadow change */
  .page-action-chip :global(.page-action-chip-btn) {
    transition:
      background-color 150ms ease-out,
      border-color 150ms ease-out,
      color 150ms ease-out;
  }

  .page-action-chip :global(.page-action-chip-btn:hover),
  .page-action-chip :global(.page-action-chip-btn:focus-visible) {
    background-color: color-mix(in srgb, var(--primary) 14%, var(--background));
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
    color: var(--foreground);
  }

  .page-action-chip :global(.page-action-chip-btn:active) {
    background-color: color-mix(in srgb, var(--primary) 22%, var(--background));
    border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
    color: var(--foreground);
  }

  :global(.dark) .page-action-chip :global(.page-action-chip-btn:hover),
  :global(.dark)
    .page-action-chip
    :global(.page-action-chip-btn:focus-visible) {
    background-color: color-mix(in srgb, var(--primary) 18%, var(--card));
    border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
    color: var(--foreground);
  }

  :global(.dark) .page-action-chip :global(.page-action-chip-btn:active) {
    background-color: color-mix(in srgb, var(--primary) 26%, var(--card));
  }

  @media (prefers-reduced-motion: reduce) {
    .page-action-dock {
      transition: none;
    }

    .page-action-chip {
      transform: none;
      transition: none;
      transition-delay: 0ms !important;
    }

    .page-action-tree.is-open .page-action-chip {
      transform: none;
      transition-delay: 0ms !important;
    }

    .page-action-chip :global(.page-action-chip-btn) {
      transition:
        background-color 120ms ease,
        border-color 120ms ease,
        color 120ms ease;
    }
  }
</style>
