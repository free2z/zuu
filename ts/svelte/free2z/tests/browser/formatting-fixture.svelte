<script lang="ts">
  import {
    locale,
    setLocale,
    formatCurrencyMinor,
    formatLocalizedUnit,
    formatScaledAsset,
  } from "$lib/i18n";
</script>

<button onclick={() => setLocale("en")}>English</button>
<button onclick={() => setLocale("fr")}>Français</button>
<p data-testid="currency">{formatCurrencyMinor(123456n, 2, "USD", $locale)}</p>
<p data-testid="unit">
  {formatLocalizedUnit(1.5, "megabyte", $locale, {
    unitDisplay: "short",
    maximumFractionDigits: 1,
  })}
</p>
<p data-testid="asset">{formatScaledAsset(1n, 8, "ZEC", $locale)}</p>
