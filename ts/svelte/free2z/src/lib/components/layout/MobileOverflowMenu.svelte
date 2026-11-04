<script lang="ts">
  import * as Drawer from "$lib/components/ui/drawer";
  import { Button } from "$lib/components/ui/button";
  import { MoreVertical } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import LanguageSelector from "$lib/components/layout/LanguageSelector.svelte";
  import ModeToggle from "$lib/components/layout/ModeToggle.svelte";

  // Preferences that used to live only in the desktop footer. A Drawer rather
  // than a DropdownMenu on purpose: LanguageSelector and ModeToggle are each
  // already a dropdown, and nesting dropdown roots inside another is fragile.
  //
  // Auth deliberately does NOT live here — signing up is the primary action
  // for an anonymous visitor and stays visible in the header.
  export let triggerClass = "";
</script>

<Drawer.Root>
  <Drawer.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="icon-sm"
        class={triggerClass}
        aria-label={$t("navigation.moreOptions", "More options")}
      >
        <MoreVertical class="size-5" />
      </Button>
    {/snippet}
  </Drawer.Trigger>

  <Drawer.Content>
    <Drawer.Header class="pb-2 text-start">
      <Drawer.Title>{$t("navigation.preferences", "Preferences")}</Drawer.Title>
      <Drawer.Description class="sr-only">
        {$t("navigation.preferencesDescription", "Language and appearance")}
      </Drawer.Description>
    </Drawer.Header>

    <div class="flex flex-col gap-5 px-4 pb-8">
      <div class="flex flex-col gap-2">
        <span
          class="text-xs font-semibold tracking-[0.14em] text-(--f2z-text-secondary) uppercase"
        >
          {$t("language.label", "Language")}
        </span>
        <LanguageSelector />
      </div>

      <div class="flex flex-col gap-2">
        <span
          class="text-xs font-semibold tracking-[0.14em] text-(--f2z-text-secondary) uppercase"
        >
          {$t("theme.label", "Theme")}
        </span>
        <ModeToggle />
      </div>
    </div>
  </Drawer.Content>
</Drawer.Root>
