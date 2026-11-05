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
    loading,
    localeLoadError,
    tStore as t,
    type SupportedLocale,
  } from "$lib/i18n";
  import { goto, invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import {
    isContentLanguageRoute,
    LOCALE_RETRY_KEY,
    localeAvailability,
  } from "$lib/locale.js";

  let selectedLocale = $state<SupportedLocale>($locale);
  const activeLanguage = $derived(
    languageOptions.find((option) => option.code === $locale) ??
      languageOptions[0],
  );

  $effect(() => {
    selectedLocale = $locale;
  });

  function retryLanguage(next: string) {
    document.cookie = `${LOCALE_RETRY_KEY}=${encodeURIComponent(next)}; Path=/; Max-Age=60; SameSite=Lax`;
    const url = new URL(window.location.href);
    if (!isContentLanguageRoute(page.route.id)) url.searchParams.delete("lang");
    window.location.assign(url.href);
  }

  async function chooseLanguage(nextLocale: SupportedLocale) {
    const success = await setLocale(nextLocale);
    if (success) {
      const url = new URL(window.location.href);
      if (
        !isContentLanguageRoute(page.route.id) &&
        url.searchParams.has("lang")
      ) {
        url.searchParams.delete("lang");
        await goto(url.pathname + url.search + url.hash, {
          replace: true,
          reset: false,
          refreshAll: true,
        });
      } else await invalidateAll();
    } else selectedLocale = $locale;
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
        <span class="flex-1 text-start text-xs font-medium">
          {activeLanguage.label}
        </span>
        <ChevronDown class="size-2.5 text-(--f2z-text-muted)" />
      </Button>
    {/snippet}
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" side="top" sideOffset={8}>
    <DropdownMenuRadioGroup bind:value={selectedLocale}>
      {#each languageOptions.filter((option) => localeAvailability(option.code, page.data.disabledLocales ?? []) !== "disabled") as option}
        <DropdownMenuRadioItem
          value={option.code}
          onclick={() => void chooseLanguage(option.code)}
        >
          <span lang={option.code}>{option.label}</span>
          {#if localeAvailability(option.code) === "beta"}<span
              aria-label={$t("language.beta", "Beta")}
            >
              · {$t("language.beta", "Beta")}</span
            >{/if}
        </DropdownMenuRadioItem>
      {/each}
    </DropdownMenuRadioGroup>
  </DropdownMenuContent>
</DropdownMenu>

{#if $loading}<span role="status"
    >{$t("language.loading", "Loading language…")}</span
  >{/if}
{#if $localeLoadError}<div role="alert">
    {$t("language.loadFailed", "Could not load that language.")}
    <button
      type="button"
      onclick={() => $localeLoadError && retryLanguage($localeLoadError)}
      >{$t("language.retry", "Try again")}</button
    >
  </div>{/if}
