<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { Dialog } from "bits-ui";
  import { Plus, X } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { tStore as t } from "$lib/i18n";
  import ConverseComposer from "./ConverseComposer.svelte";

  let open = false;
  let mobile = false;
  let keyboardInset = 0;
  let visibleHeight: number | null = null;
  let trigger: HTMLButtonElement | null = null;
  const dispatch = createEventDispatcher();

  onMount(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const viewport = window.visualViewport;
    const syncViewport = () => {
      mobile = media.matches;
      if (!mobile) open = false;
      // Mobile keyboards shrink the visual viewport without resizing the
      // layout viewport. Keep the amount and submit controls above them.
      visibleHeight = mobile && viewport ? viewport.height : null;
      keyboardInset =
        mobile && viewport
          ? Math.max(
              0,
              window.innerHeight - viewport.height - viewport.offsetTop,
            )
          : 0;
    };
    syncViewport();
    media.addEventListener("change", syncViewport);
    window.addEventListener("resize", syncViewport);
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    return () => {
      media.removeEventListener("change", syncViewport);
      window.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
    };
  });
</script>

<div class="contents sm:block">
  <Dialog.Root bind:open>
    <Button
      bind:ref={trigger}
      size="icon"
      class="fixed right-4 z-40 size-12 rounded-full shadow-lg sm:hidden"
      style="bottom: calc(max(1rem, calc(env(safe-area-inset-bottom) + 0.75rem)) + var(--f2z-bottom-dock-height, 0px))"
      aria-label={$t("converse.newPost", "New conversation")}
      title={$t("converse.newPost", "New conversation")}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls="converse-mobile-composer"
      onclick={() => (open = true)}
    >
      <Plus strokeWidth={1.75} class="size-5" />
    </Button>

    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/50 sm:hidden" />
    <!-- Keep the one composer mounted across dismissals, preserving drafts,
       posting intent and uploads. Desktop keeps its original inline form.
       No portal switch means resizing does not remount the editor either. -->
    <Dialog.Content
      forceMount
      trapFocus={open}
      preventScroll={open}
      onOpenAutoFocus={(event) => {
        const field = document.getElementById("converse-content");
        const login = document.querySelector<HTMLElement>(
          '[data-testid="converse-login-prompt"]',
        );
        const target = field ?? login;
        if (target) {
          event.preventDefault();
          target.focus();
        }
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (mobile) trigger?.focus();
      }}
    >
      {#snippet child({ props })}
        <div
          {...props}
          style:contain="none"
          style:bottom={mobile ? `${keyboardInset}px` : undefined}
          style:max-height={visibleHeight === null
            ? undefined
            : `${Math.max(0, visibleHeight - 16)}px`}
          id="converse-mobile-composer"
          role={mobile ? "dialog" : "region"}
          aria-modal={mobile ? true : undefined}
          onkeydown={(event) => {
            // The editor owns Escape while a writing menu is open. Bits UI's
            // document Escape layer clones the event, losing defaultPrevented.
            if (mobile && event.key === "Escape" && event.defaultPrevented) {
              event.stopPropagation();
            }
          }}
          class={`${open ? "block" : "hidden"} fixed inset-x-0 bottom-0 z-50 max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-t-[8px] border border-border bg-background px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl sm:static sm:block sm:max-h-none sm:overflow-visible sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none`}
        >
          <div class="mb-4 flex items-center justify-between gap-3 sm:sr-only">
            <Dialog.Title class="text-lg font-semibold">
              {$t("converse.newPost", "New conversation")}
            </Dialog.Title>
            <Dialog.Close
              class="flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:hidden"
              aria-label={$t("common.close", "Close")}
            >
              <X class="size-5" />
            </Dialog.Close>
          </div>
          <ConverseComposer
            mobileDrawer
            on:posted={() => {
              open = false;
              dispatch("posted");
            }}
          />
        </div>
      {/snippet}
    </Dialog.Content>
  </Dialog.Root>
</div>
