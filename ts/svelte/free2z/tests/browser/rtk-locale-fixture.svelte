<script lang="ts">
  import { locale, setLocale } from "$lib/i18n";
  import { getRtkTranslator } from "$lib/rtk-i18n";
</script>

<button onclick={() => setLocale("fr")}>French RTK</button>
<button onclick={() => setLocale("es")}>Spanish RTK</button>
<p data-testid="rtk-leave">{getRtkTranslator($locale)("leave")}</p>
