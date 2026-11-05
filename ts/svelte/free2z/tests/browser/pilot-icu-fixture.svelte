<script lang="ts">
  import {
    locale,
    setLocale,
    translateWithCatalogs,
    formatLocalizedNumber,
  } from "$lib/i18n";
  const catalogs = {
    en: {
      sample:
        "{count, plural, one {# item} other {# items}} · {rank, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} · {choice, select, yes {yes} other {no}}",
    },
    ar: {
      sample:
        "{count, plural, zero {لا عناصر} one {عنصر واحد} two {عنصران} few {# عناصر} many {# عنصرًا} other {# عنصر}} · {rank, selectordinal, other {المرتبة #}} · {choice, select, yes {نعم} other {لا}}",
    },
    pl: {
      sample:
        "{count, plural, one {# element} few {# elementy} many {# elementów} other {# elementu}} · {rank, selectordinal, other {miejsce #}} · {choice, select, yes {tak} other {nie}}",
    },
    ja: {
      sample:
        "{count, plural, other {# 件}} · {rank, selectordinal, other {第 # 位}} · {choice, select, yes {はい} other {いいえ}}",
    },
    hi: {
      sample:
        "{count, plural, one {# वस्तु} other {# वस्तुएँ}} · {rank, selectordinal, other {स्थान #}} · {choice, select, yes {हाँ} other {नहीं}}",
    },
    de: {
      sample:
        "{count, plural, one {# Element} other {# Elemente}} · {rank, selectordinal, other {Platz #}} · {choice, select, yes {ja} other {nein}}",
    },
  };
  let count = $state(2);
</script>

{#each ["ar", "pl", "ja", "hi", "de"] as code}
  <button onclick={() => setLocale(code)}>{code}</button>
{/each}
<button onclick={() => (count = 0)}>zero</button>
<button onclick={() => (count = 3)}>three</button>
<button onclick={() => (count = 11)}>eleven</button>
<p data-testid="pilot-icu">
  {translateWithCatalogs(catalogs, ["sample"], $locale, "sample", "", {
    count,
    rank: 2,
    choice: "yes",
  })}
</p>

<p data-testid="pilot-number">{formatLocalizedNumber(1234.5, $locale)}</p>
