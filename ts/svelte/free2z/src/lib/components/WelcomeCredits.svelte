<script lang="ts">
  import { onMount } from "svelte";
  import { currentUser } from "$lib/stores/auth";
  import { locale, tStore as t } from "$lib/i18n";
  import { formatDecimalText } from "$lib/insufficient-funds";

  let dismissed = $state<string | null>(null);
  let ready = $state(false);
  let account = $derived($currentUser ? String($currentUser.id) : null);
  let storageKey = $derived(`welcome-credits:${account}`);
  onMount(() => {
    ready = true;
  });
  let hidden = $state(false);
  $effect(() => {
    void storageKey;
    try {
      hidden = localStorage.getItem(storageKey) === "dismissed";
    } catch {
      hidden = false;
    }
  });
  function dismiss() {
    dismissed = account;
    try {
      localStorage.setItem(storageKey, "dismissed");
    } catch {
      /* Storage is optional. */
    }
  }
</script>

{#if ready && account && $currentUser?.welcome_grant && dismissed !== account && !hidden}
  <aside
    class="mx-auto my-3 flex w-full max-w-3xl flex-wrap items-start gap-3 rounded-lg border border-border bg-muted p-4 text-sm"
    data-testid="welcome-credits"
    aria-label={$t("credits.title", "Why a penny a post?")}
  >
    <div class="min-w-0 flex-1 space-y-2">
      <p>
        {$t(
          "credits.welcome",
          "Welcome! You received {amount} 2Z in platform credits. A post starts at 1 2Z, about a US penny, to keep Free2Z free of ads and discourage spam.",
          { amount: formatDecimalText($currentUser.welcome_grant, $locale) },
        )}
      </p>
      <a
        href="/credits"
        target="_blank"
        rel="noopener"
        class="font-medium text-primary underline underline-offset-2"
        >{$t("credits.title", "Why a penny a post?")}</a
      >
    </div>
    <button
      type="button"
      onclick={dismiss}
      class="rounded px-2 py-1 text-muted-foreground hover:bg-background focus-visible:outline-2 focus-visible:outline-ring"
      >{$t("credits.dismiss", "Dismiss welcome message")}</button
    >
  </aside>
{/if}
