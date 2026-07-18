<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { ChevronDown, Languages } from "@lucide/svelte";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu";
  import {
    languageOptions,
    locale,
    setLocale,
    tStore as t,
    type SupportedLocale,
  } from "$lib/i18n";

  let selectedLocale = $state<SupportedLocale>($locale);
  const activeLanguage = $derived(
    languageOptions.find((option) => option.code === $locale) ??
      languageOptions[0],
  );

  $effect(() => {
    selectedLocale = $locale;
  });

  function chooseLanguage(nextLocale: SupportedLocale) {
    selectedLocale = nextLocale;
    setLocale(nextLocale);
  }
</script>

<DropdownMenu>
  <DropdownMenuTrigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="outline"
        class="h-8 min-w-28 justify-start rounded-md border-(--f2z-border-primary) bg-(--f2z-bg-primary)/70 px-2 shadow-none backdrop-blur-sm hover:border-(--f2z-accent-primary)/45 hover:bg-(--f2z-bg-primary)"
        aria-label={`${$t("language.current", "Language")}: ${activeLanguage.label}`}
        title={$t("language.choose", "Choose language")}
      >
        <Languages class="size-3 text-(--f2z-accent-primary)" />
        <span class="flex-1 text-left text-xs font-medium">
          {activeLanguage.label}
        </span>
        <ChevronDown class="size-2.5 text-(--f2z-text-muted)" />
      </Button>
    {/snippet}
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" side="top" sideOffset={8}>
    <DropdownMenuRadioGroup bind:value={selectedLocale}>
      {#each languageOptions as option}
        <DropdownMenuRadioItem
          value={option.code}
          onclick={() => chooseLanguage(option.code)}
        >
          <span lang={option.code}>{option.label}</span>
        </DropdownMenuRadioItem>
      {/each}
    </DropdownMenuRadioGroup>
  </DropdownMenuContent>
</DropdownMenu>
