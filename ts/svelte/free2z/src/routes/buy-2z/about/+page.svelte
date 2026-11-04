<script lang="ts">
  import { tStore as t } from "$lib/i18n";
</script>

<svelte:head
  ><title>{$t("credits.title", "Why a penny a post?")} · Free2Z</title
  ></svelte:head
>
<article class="mx-auto w-full max-w-2xl space-y-4 px-4 py-10">
  <h1 class="text-2xl font-semibold">
    {$t("credits.title", "Why a penny a post?")}
  </h1>
  <p>
    {$t(
      "credits.model",
      "2Z are platform credits for actions on Free2Z. A post starts at 1 2Z, about a US penny. This small cost discourages spam and helps keep Free2Z free of ads. Your first zPage is free; creating another requires a balance of 1 2Z and does not spend it.",
    )}
  </p>
  <p>
    {$t(
      "credits.sources",
      "Eligible new accounts receive a welcome grant. You can buy 2Z, or receive gifts from members who want to hear more from you. Introduce yourself with a zPage so readers can get to know you.",
    )}
  </p>
  <a
    href="/buy-2z"
    class="font-medium text-primary underline underline-offset-2"
    >{$t("insufficientFunds.buy", "Buy 2Z")}</a
  >
</article>
