<script lang="ts">
  import { tStore as t } from "$lib/i18n";
  import Button from "$lib/components/ui/button/button.svelte";

  const label = "Nuevo";
</script>

<Button
  type="button"
  aria-label={$t(
    "creators.filters.removeActiveFilter",
    "Remove filter: {label}",
    {
      label,
    },
  )}
>
  {label}
</Button>
