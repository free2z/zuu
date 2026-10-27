<script module lang="ts">
  export type OutboundLinkDecision = {
    cancelled: boolean;
    trustDomain: boolean;
    disableWarnings: boolean;
  };
</script>

<script lang="ts">
  import type { OutboundLinkDestination } from "$lib/utils/outbound-link";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Label } from "$lib/components/ui/label";
  import { tStore as t } from "$lib/i18n";

  export let open = false;
  export let destination: OutboundLinkDestination | null = null;
  export let onDecision: (decision: OutboundLinkDecision) => void = () => {};

  let trustDomain = false;
  let disableWarnings = false;
  let lastDestinationHref = "";

  $: if ((destination?.href || "") !== lastDestinationHref) {
    lastDestinationHref = destination?.href || "";
    trustDomain = false;
    disableWarnings = false;
  }

  function choose(decision: OutboundLinkDecision) {
    open = false;
    onDecision(decision);
  }

  function continueOnce() {
    choose({
      cancelled: false,
      trustDomain,
      disableWarnings,
    });
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && open) {
      choose({
        cancelled: true,
        trustDomain: false,
        disableWarnings: false,
      });
      return;
    }
    open = nextOpen;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === "Escape") {
      event.preventDefault();
      choose({
        cancelled: true,
        trustDomain: false,
        disableWarnings: false,
      });
    }
  }

  // bits-ui owns the normal focus trap and restoration. This explicit Escape
  // path also covers a dialog opened from a delegated Markdown anchor rather
  // than from Dialog.Trigger, and keeps the cancellation callback deterministic.
</script>

<svelte:window onkeydown={handleKeydown} />

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content
    class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
    data-testid="outbound-link-warning"
  >
    <Dialog.Header>
      <Dialog.Title>
        {$t("privacy.outboundLinkWarningTitle", "Open external link?")}
      </Dialog.Title>
      <Dialog.Description>
        {$t(
          "privacy.outboundLinkWarningDescription",
          "This link leaves Free2Z. Review the parsed destination before opening it.",
        )}
      </Dialog.Description>
    </Dialog.Header>

    {#if destination}
      <div class="space-y-2 py-2">
        <p class="text-sm text-muted-foreground">
          {$t("privacy.outboundLinkDestinationLabel", "Destination")}
        </p>
        <code
          class="block max-w-full overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-sm break-all text-foreground"
          data-testid="outbound-link-destination">{destination.href}</code
        >
        <p class="text-sm text-muted-foreground">
          {$t("privacy.outboundLinkDomainLabel", "Host")}:
          <span class="font-mono text-foreground">{destination.hostname}</span>
        </p>
        <p class="text-sm text-muted-foreground">
          {$t("privacy.outboundLinkSchemeLabel", "Scheme")}:
          <span class="font-mono text-foreground">{destination.protocol}</span>
        </p>
      </div>

      <div class="space-y-3 py-2">
        <div class="flex items-start gap-3">
          <Checkbox
            id="outbound-link-trust-domain"
            bind:checked={trustDomain}
          />
          <Label
            for="outbound-link-trust-domain"
            class="cursor-pointer leading-5 font-normal"
          >
            {$t("privacy.outboundLinkTrustDomain", "Always trust this domain")}
          </Label>
        </div>
        <div class="flex items-start gap-3">
          <Checkbox
            id="outbound-link-disable-warnings"
            bind:checked={disableWarnings}
          />
          <Label
            for="outbound-link-disable-warnings"
            class="cursor-pointer leading-5 font-normal"
          >
            {$t(
              "privacy.outboundLinkDisableWarnings",
              "Don't warn for any external links",
            )}
          </Label>
        </div>
      </div>

      <Dialog.Footer class="pt-2 sm:flex-row">
        <Button
          variant="outline"
          data-testid="outbound-link-cancel"
          onclick={() =>
            choose({
              cancelled: true,
              trustDomain: false,
              disableWarnings: false,
            })}>{$t("common.cancel", "Cancel")}</Button
        >
        <Button data-testid="outbound-link-continue" onclick={continueOnce}
          >{$t("privacy.outboundLinkContinueOnce", "Continue once")}</Button
        >
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
