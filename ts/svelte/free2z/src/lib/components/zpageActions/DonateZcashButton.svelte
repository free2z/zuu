<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import { mergeProps, Tooltip as TooltipPrimitive } from "bits-ui";
  import { Content as TooltipContent } from "$lib/components/ui/tooltip";
  import QRCode from "qrcode";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Drawer from "$lib/components/ui/drawer";
  import { Button } from "$lib/components/ui/button";
  import CopyableValue from "$lib/components/CopyableValue.svelte";
  import { tStore as t } from "$lib/i18n";

  let creator = $state<{ username?: string; p2paddr?: string } | null>(null);
  const props = $props();

  $effect(() => {
    const { creator: c = null } = props;
    creator = c;
  });

  function titleText() {
    return creator?.username
      ? $t("pageActions.donate.title", `Donate to ${creator.username}`, {
          username: creator.username,
        })
      : $t("pageActions.donate.titleFallback", "Donate ZEC");
  }

  function modalTitle() {
    return creator?.username
      ? $t(
          "pageActions.donate.modalTitle",
          `${creator.username}'s Zcash Address`,
          { username: creator.username },
        )
      : $t("pageActions.donate.modalTitleFallback", "Zcash Donation Address");
  }

  // Local QR generation (data URL) using `qrcode` lib
  let qrDataUrl = $state<string | null>(null);
  let qrError = $state(false);

  $effect(() => {
    // generate a data URL when the creator address changes;
    if (creator?.p2paddr) {
      qrError = false;
      QRCode.toDataURL(creator.p2paddr, { margin: 1, width: 240 })
        .then((url: string) => {
          qrDataUrl = url;
          qrError = false;
        })
        .catch(() => {
          qrDataUrl = null;
          qrError = true;
        });
    } else {
      qrDataUrl = null;
      qrError = false;
    }
  });

  let open = $state(false);
  const isDesktop = new MediaQuery("(min-width: 768px)");
</script>

<!-- snippets -->
{#snippet commonButton(
  dialogTriggerProps: Record<string, any> = {},
  tooltipTriggerProps: Record<string, any> = {},
)}
  <div class="relative flex items-center justify-center">
    <Button
      {...mergeProps(dialogTriggerProps, tooltipTriggerProps)}
      size="icon-lg"
      class="flex items-center justify-center rounded-full "
      title={titleText()}
      aria-label={titleText()}
    >
      <img src="/svg/zcash.svg" alt="Zcash" class="h-6 w-6" />
    </Button>
    <div class="absolute left-1/2 -translate-x-1/2 translate-y-6 transform">
      <div
        class="rounded-full bg-(--f2z-accent-primary) px-2 py-0.5 text-xs font-bold text-(--f2z-bg-primary) shadow-md"
      >
        {$t("pageActions.donate.button", "Donate")}
      </div>
    </div>
  </div>
{/snippet}

{#snippet dialogContent()}
  {#if creator?.p2paddr}
    <div class="mt-4 flex flex-col items-center gap-3 p-4">
      {#if qrDataUrl}
        <img
          class="block rounded-lg bg-white"
          src={qrDataUrl}
          alt={$t("pageActions.donate.qrAlt", "Zcash donation QR code")}
          width="192"
          height="192"
        />
      {:else if qrError}
        <div
          class="block flex h-48 w-48 items-center justify-center rounded-lg bg-white text-red-500"
        >
          {$t("pageActions.donate.qrError", "Failed to generate QR code")}
        </div>
      {:else}
        <div
          class="block flex h-48 w-48 items-center justify-center rounded-lg bg-white"
        >
          {$t("pageActions.donate.qrLoading", "Generating...")}
        </div>
      {/if}

      <!-- Full address, wrapped and never truncated: a donor has to be able
           to check it against the QR before sending. -->
      <CopyableValue
        value={creator.p2paddr}
        label={$t("pageActions.donate.copyAddress", "Copy Zcash address")}
      />

      <div class="text-xs text-(--f2z-text-muted,#666)">
        {$t(
          "pageActions.donate.disclaimer",
          "We don't collect or route funds — this address is owner-controlled.",
        )}
      </div>
    </div>
  {/if}
{/snippet}

<!--  -->

{#if isDesktop.current}
  <Dialog.Root bind:open>
    <Dialog.Trigger>
      {#snippet child({ props: dialogTriggerProps })}
        <TooltipPrimitive.Provider>
          <TooltipPrimitive.Root>
            <TooltipPrimitive.Trigger>
              {#snippet child({ props: tooltipTriggerProps })}
                {@render commonButton(dialogTriggerProps, tooltipTriggerProps)}
              {/snippet}
            </TooltipPrimitive.Trigger>
            <TooltipContent side="left">{titleText()}</TooltipContent>
          </TooltipPrimitive.Root>
        </TooltipPrimitive.Provider>
      {/snippet}
    </Dialog.Trigger>

    <Dialog.Content>
      <Dialog.Header>
        <Dialog.Title>{modalTitle()}</Dialog.Title>
        <Dialog.Description>
          <p class="text-(--f2z-text-muted,#666)] mt-2 text-sm">
            {#if creator?.p2paddr}
              {$t(
                "pageActions.donate.description",
                "All donations go directly to the creator's wallet. Use the QR or copy the raw address below.",
              )}
            {:else}
              {$t(
                "pageActions.donate.descriptionFallback",
                "The creator has not configured a Zcash (ZEC) address yet. You can check back later or contact the creator for options.",
              )}
            {/if}
          </p>
        </Dialog.Description>
      </Dialog.Header>
      {@render dialogContent()}
      <Dialog.Footer class="pt-2">
        <Dialog.Close>{$t("pageActions.donate.cancel", "Cancel")}</Dialog.Close>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{:else}
  <Drawer.Root bind:open>
    <Drawer.Trigger>
      {#snippet child({ props: drawerTriggerProps })}
        <TooltipPrimitive.Provider>
          <TooltipPrimitive.Root>
            <TooltipPrimitive.Trigger>
              {#snippet child({ props: tooltipTriggerProps })}
                {@render commonButton(drawerTriggerProps, tooltipTriggerProps)}
              {/snippet}
            </TooltipPrimitive.Trigger>
            <TooltipContent side="left">{titleText()}</TooltipContent>
          </TooltipPrimitive.Root>
        </TooltipPrimitive.Provider>
      {/snippet}
    </Drawer.Trigger>

    <Drawer.Content>
      <Drawer.Header class="text-left">
        <Drawer.Title>{modalTitle()}</Drawer.Title>
        <Drawer.Description>
          <p class="mt-2 text-sm text-(--f2z-text-muted,#666)">
            {#if creator?.p2paddr}
              {$t(
                "pageActions.donate.description",
                "All donations go directly to the creator's wallet. Use the QR or copy the raw address below.",
              )}
            {:else}
              {$t(
                "pageActions.donate.descriptionFallback",
                "The creator has not configured a Zcash (ZEC) address yet. You can check back later or contact the creator for options.",
              )}
            {/if}
          </p>
        </Drawer.Description>
      </Drawer.Header>
      {@render dialogContent()}
      <Drawer.Footer class="pt-2">
        <Drawer.Close>{$t("pageActions.donate.cancel", "Cancel")}</Drawer.Close>
      </Drawer.Footer>
    </Drawer.Content>
  </Drawer.Root>
{/if}
