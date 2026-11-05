<script lang="ts">
  import { locale, setLocale, translateWithCatalogs, tStore } from "$lib/i18n";

  const catalogs = {
    en: {
      sample:
        "{count, plural, one {{who} has one} other {{who} has #}} · {rank, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} · {choice, select, yes {yes} other {no}}",
    },
    fr: {
      sample:
        "{count, plural, one {{who} a un} other {{who} a #}} · {rank, selectordinal, other {#e}} · {choice, select, yes {oui} other {non}}",
    },
  };
  const values = { count: 2, who: "Ada", rank: 2, choice: "yes" };
</script>

<button onclick={() => setLocale("en")}>English</button>
<button onclick={() => setLocale("fr")}>Français</button>
<p data-testid="icu">
  {translateWithCatalogs(catalogs, ["sample"], $locale, "sample", "", values)}
</p>
<p data-testid="pagination">
  {$tStore("trending.pageOf", "Page {page} of {total}", { page: 2, total: 4 })}
</p>
