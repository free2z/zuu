<script lang="ts">
  import { ChevronDown, Moon, Sun, Laptop } from "@lucide/svelte";
  import { resetMode, setMode, userPrefersMode } from "mode-watcher";
  import { Button } from "$lib/components/ui/button";
  import { tStore as t } from "$lib/i18n";
  import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
  } from "$lib/components/ui/dropdown-menu";
  const themePreference = $derived.by(
    () => (userPrefersMode.current || "system") as "light" | "dark" | "system",
  );
  const themeLabel = $derived(
    themePreference === "light"
      ? $t("footer.light", "Light")
      : themePreference === "dark"
        ? $t("footer.dark", "Dark")
        : $t("footer.system", "System"),
  );
</script>

<DropdownMenu>
  <DropdownMenuTrigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="outline"
        class="h-8 min-w-28 justify-start rounded-md border-(--f2z-border-primary) bg-(--f2z-bg-primary)/70 px-2 shadow-none backdrop-blur-sm hover:border-(--f2z-accent-primary)/45 hover:bg-(--f2z-bg-primary)"
        aria-label={$t("footer.chooseTheme", "Choose theme")}
        title={$t("footer.theme", "Theme")}
      >
        {#if themePreference === "light"}
          <Sun class="size-3 text-(--f2z-accent-primary)" />
        {:else if themePreference === "dark"}
          <Moon class="size-3 text-(--f2z-accent-primary)" />
        {:else}
          <Laptop class="size-3 text-(--f2z-accent-primary)" />
        {/if}
        <span class="flex-1 text-left text-xs font-medium">{themeLabel}</span>
        <ChevronDown class="size-2.5 text-(--f2z-text-muted)" />
      </Button>
    {/snippet}
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" side="top" sideOffset={8}>
    <DropdownMenuItem onclick={() => setMode("light")}>
      <Sun class="mr-2 h-4 w-4" />
      {$t("footer.light", "Light")}
    </DropdownMenuItem>
    <DropdownMenuItem onclick={() => setMode("dark")}>
      <Moon class="mr-2 h-4 w-4" />
      {$t("footer.dark", "Dark")}
    </DropdownMenuItem>
    <DropdownMenuItem onclick={() => resetMode()}>
      <Laptop class="mr-2 h-4 w-4" />
      {$t("footer.system", "System")}
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
