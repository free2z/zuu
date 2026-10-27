<script lang="ts">
  import { onMount } from "svelte";
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { outboundLinkStore } from "$lib/stores/outbound-links";
  import { tStore as t } from "$lib/i18n";

  let trustedDomains: string[] = [];
  let globalWarningDisabled = false;

  onMount(() => {
    const stopStorageSync = outboundLinkStore.startStorageSync();
    const unsubscribe = outboundLinkStore.subscribe((state) => {
      trustedDomains = state.trustedDomains;
      globalWarningDisabled = state.globalWarningDisabled;
    });

    return () => {
      unsubscribe();
      stopStorageSync();
    };
  });

  function revokeDomain(domain: string) {
    outboundLinkStore.revokeDomain(domain);
  }
</script>

<Card.Root data-testid="outbound-link-settings">
  <Card.Header>
    <Card.Title>
      {$t("privacy.outboundLinkSettingsTitle", "External link warnings")}
    </Card.Title>
    <Card.Description>
      {$t(
        "privacy.outboundLinkSettingsDescription",
        "Choose whether Markdown links should ask before opening a new tab.",
      )}
    </Card.Description>
  </Card.Header>

  <Card.Content class="space-y-6">
    <div class="flex items-start gap-3">
      <Switch
        id="outbound-link-global-warning"
        checked={globalWarningDisabled}
        onCheckedChange={(checked) =>
          outboundLinkStore.setGlobalWarningDisabled(checked)}
      />
      <div class="space-y-1">
        <Label for="outbound-link-global-warning" class="cursor-pointer">
          {$t(
            "privacy.outboundLinkDisableWarnings",
            "Don't warn for any external links",
          )}
        </Label>
        <p class="text-sm text-muted-foreground">
          {$t(
            "privacy.outboundLinkGlobalDescription",
            "When enabled, external Markdown links open immediately in a new tab.",
          )}
        </p>
      </div>
    </div>

    <div class="space-y-3">
      <div>
        <h3 class="text-sm font-medium">
          {$t("privacy.outboundLinkTrustedDomains", "Trusted external domains")}
        </h3>
        <p class="mt-1 text-sm text-muted-foreground">
          {$t(
            "privacy.outboundLinkTrustedDomainsDescription",
            "These domains open without a warning. Revoking a domain makes it ask again next time.",
          )}
        </p>
      </div>

      {#if trustedDomains.length > 0}
        <ul
          class="divide-y rounded-md border"
          data-testid="outbound-trusted-domains"
        >
          {#each trustedDomains as domain (domain)}
            <li
              class="flex min-h-12 items-center justify-between gap-3 px-3 py-2"
            >
              <code class="min-w-0 text-sm break-all">{domain}</code>
              <Button
                variant="ghost"
                size="sm"
                class="shrink-0 text-destructive hover:text-destructive"
                data-testid={`revoke-outbound-domain-${domain}`}
                onclick={() => revokeDomain(domain)}
              >
                {$t("privacy.outboundLinkRevokeDomain", "Revoke")}
              </Button>
            </li>
          {/each}
        </ul>
      {:else}
        <p
          class="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
          data-testid="outbound-no-trusted-domains"
        >
          {$t(
            "privacy.outboundLinkNoTrustedDomains",
            "No external domains are trusted yet.",
          )}
        </p>
      {/if}
    </div>
  </Card.Content>
</Card.Root>
