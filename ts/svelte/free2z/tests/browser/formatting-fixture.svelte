<script lang="ts">
  import {
    createDisplayNames,
    formatDisplayDate,
    formatDisplayNumber,
  } from "$lib/intl-display.js";
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

<p data-testid="activity-date">
  {formatDisplayDate(new Date("2026-10-11T18:55:00Z"), $locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  })}
</p>
<p data-testid="notification-count">{formatDisplayNumber(1234, $locale)}</p>
<p data-testid="language-name">
  {createDisplayNames([$locale, "en"], {
    type: "language",
    fallback: "none",
  }).of("ja")}
</p>
<p data-testid="media-size">
  {formatDisplayNumber(1.5, $locale, {
    style: "unit",
    unit: "megabyte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  })}
</p>
