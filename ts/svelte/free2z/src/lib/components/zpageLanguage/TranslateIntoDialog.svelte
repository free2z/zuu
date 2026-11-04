<script lang="ts">
  /**
   * "Translate…" — many languages, one price, one confirm.
   *
   * ONE step: tick languages and the total updates as you go (a debounced
   * quote), then confirm. The creator stays on the article they are editing
   * the whole time; nothing here navigates.
   *
   * The money rules are the single-language dialog's, unchanged:
   *
   * - **No 2Z leave from a screen that has not shown the number.** The confirm
   *   button is enabled only while the quote on screen prices exactly the
   *   languages ticked, and it names the total it commits to.
   * - **One `Idempotency-Key` per decision**, minted at the first confirm of a
   *   given quote and re-sent by every retry of it. An answer that never
   *   arrived is retried with the same key, which the server replays rather
   *   than charging twice. A new quote is a new decision and a new key.
   *
   * 2Z are Free2Z credits — never money, never cryptocurrency.
   */
  import { untrack } from "svelte";
  import { tStore as t } from "$lib/i18n";
  import { currentUser, authStore } from "$lib/stores/auth";
  import {
    createQuotedBalanceDisplay,
    beginAccountBalanceRead,
    recordQuotedBalanceRead,
  } from "$lib/account-balance";
  import {
    describeLanguageEntry,
    entryMatchesQuery,
  } from "$lib/language-picker.js";
  import { focusTrap } from "$lib/focus-trap";
  import InsufficientFunds from "$lib/components/InsufficientFunds.svelte";
  import {
    compareDecimalText,
    insufficientFundsFromError,
    makeInsufficientFunds,
    type InsufficientFundsDetails,
  } from "$lib/insufficient-funds";
  import {
    isAmbiguousOutcome,
    isNoChargeRefusal,
    newIdempotencyKey,
    translationErrorCode,
    translationPurchaseError,
  } from "$lib/zpage-translation-purchase.js";
  import type { BulkQuote } from "$lib/api/zpage-translations";

  interface Props {
    open: boolean;
    owner?: { username: string; id?: number };
    /** Every language this article could be translated into. */
    languages: readonly string[];
    names?: ReadonlyMap<
      string,
      {
        name?: string | null;
        autonym?: string | null;
        direction?: "ltr" | "rtl";
      }
    >;
    viewerLocale?: string;
    /** Languages that cannot be picked right now, and why (shown on the row). */
    unavailable?: ReadonlyMap<string, string>;
    /** Pre-ticked when the dialog opens (e.g. "Retry" on a failed row). */
    initial?: readonly string[];
    /**
     * The most languages one purchase may hold, as the server last said
     * ( `max_items`). The quote's own `max_items` wins once it arrives.
     */
    maxItems?: number | null;
    /**
     * A purchase whose outcome is still unknown — kept by the page across
     * close, navigation and reload. While it exists the dialog offers exactly
     * one thing: re-send THAT purchase with ITS key, which the server replays
     * if it landed and performs once if it did not. Never a fresh key.
     */
    pending?: {
      quote: BulkQuote;
      languages: string[];
      key: string;
    } | null;
    /** Lines whose purchase replaces a saved draft in that language. */
    replaces?: ReadonlySet<string>;
    /** Name a language in the reader's UI locale. */
    label: (language: string) => string;
    /** Flush the article and price these languages. Throws an ApiError. */
    quote: (languages: string[]) => Promise<BulkQuote | null>;
    /** Buy exactly these lines under `key`. Throws an ApiError. */
    purchase: (
      quote: BulkQuote,
      languages: string[],
      key: string,
    ) => Promise<void>;
    onclose: () => void;
    /** How long selection must rest before it is priced. Tests shorten it. */
    quoteDelayMs?: number;
  }

  let {
    open,
    owner,
    languages,
    names = new Map(),
    viewerLocale = "en",
    unavailable = new Map(),
    initial = [],
    maxItems = null,
    pending = null,
    replaces = new Set(),
    label,
    quote: requestQuote,
    purchase,
    onclose,
    quoteDelayMs = 350,
  }: Props = $props();

  /** Widely read on the web, in our sell list — a starting point, not a ranking. */
  const WIDELY_READ = [
    "es",
    "zh-Hans",
    "ar",
    "pt-BR",
    "fr",
    "ja",
    "ru",
    "de",
    "id",
    "hi",
  ];
  /** The EU's official languages that we sell. */
  const EU = [
    "bg",
    "cs",
    "da",
    "de",
    "el",
    "es",
    "et",
    "fi",
    "fr",
    "hr",
    "hu",
    "it",
    "lt",
    "lv",
    "nl",
    "pl",
    "pt-PT",
    "ro",
    "sk",
    "sl",
    "sv",
  ];
  const DEFAULT_MAX_ITEMS = 10;

  let query = $state("");
  let selected = $state<string[]>([]);
  let currentQuote = $state<BulkQuote | null>(null);
  let quoting = $state(false);
  let buying = $state(false);
  let error = $state<string | null>(null);
  let funds = $state<InsufficientFundsDetails | null>(null);
  /**
   * Lines that cannot be bought, with why: refused by the quote or by the
   * purchase. They are unticked (and re-priced without) automatically, and
   * the row keeps saying why.
   */
  let blocked = $state<Map<string, string>>(new Map());
  /** Re-sending an unresolved purchase: nothing can be changed. */
  let resending = $state(false);
  /** The key bound to `currentQuote`'s decision. */
  let decisionKey: string | null = null;
  let quoteRequest = 0;
  let quoteTimer: ReturnType<typeof setTimeout> | null = null;
  let wasOpen = false;

  $effect(() => {
    if (open && !wasOpen) {
      query = "";
      currentQuote = null;
      error = null;
      funds = null;
      blocked = new Map();
      decisionKey = null;
      quoting = false;
      if (pending) {
        resending = true;
        selected = [...pending.languages];
        currentQuote = {
          ...pending.quote,
          items: pending.quote.items.filter((item) =>
            pending!.languages.includes(item.language),
          ),
        };
        decisionKey = pending.key;
        error = $t(
          "translationJobs.purchaseUnknown",
          "We could not tell whether that went through. Check the tray before buying again — pressing Translate again re-sends this same purchase and never charges twice.",
        );
      } else {
        resending = false;
        selected = initial.filter(
          (language) =>
            languages.includes(language) && !unavailable.has(language),
        );
        // Pre-ticked ("Retry") is priced at once, like any other selection.
        if (selected.length) untrack(() => schedulePrice(0));
      }
    }
    if (!open && wasOpen) cancelQuote();
    wasOpen = open;
  });

  const cap = $derived(
    Math.max(
      1,
      Number(currentQuote?.max_items ?? maxItems ?? DEFAULT_MAX_ITEMS) ||
        DEFAULT_MAX_ITEMS,
    ),
  );

  const entries = $derived(
    languages
      .map((language) =>
        describeLanguageEntry(
          language,
          viewerLocale,
          names.get(language) ?? null,
        ),
      )
      .filter((entry) => entry !== null)
      .sort((a, b) => a.name.localeCompare(b.name, viewerLocale)),
  );
  const visible = $derived(
    entries.filter((entry) => entryMatchesQuery(entry, query, viewerLocale)),
  );
  const offered = $derived(
    new Set(
      entries.map((entry) => entry.language).filter((l) => !unavailable.has(l)),
    ),
  );
  // A quick pick larger than one purchase may hold would only ever be
  // refused, so it is not offered at all.
  const quickSets = $derived(
    [
      {
        id: "widely-read",
        label: $t("translationJobs.quickWidelyRead", "10 widely read"),
        languages: WIDELY_READ.filter((l) => offered.has(l)),
      },
      {
        id: "eu",
        label: $t("translationJobs.quickEu", "EU languages"),
        languages: EU.filter((l) => offered.has(l)),
      },
    ].filter((set) => set.languages.length > 0 && set.languages.length <= cap),
  );
  const atCap = $derived(selected.length >= cap);

  /**
   * A quick pick the cap cut short says so ( verification): "10 widely
   * read" with 3 already ticked adds 7, and the creator must not believe it
   * added 10.
   */
  let truncatedPick = $state<{
    label: string;
    added: number;
    count: number;
  } | null>(null);
  /** Past this many, the chosen languages collapse to "+N more". */
  const CHOSEN_SHOWN = 8;
  let showAllChosen = $state(false);
  const chosenNames = $derived(
    selected.map(
      (language) =>
        entries.find((entry) => entry.language === language)?.name ?? language,
    ),
  );

  function setSelection(next: string[]) {
    truncatedPick = null;
    selected = next.slice(0, cap);
    schedulePrice();
  }

  function toggle(language: string) {
    if (resending || buying) return;
    if (selected.includes(language))
      setSelection(selected.filter((l) => l !== language));
    else if (!atCap) setSelection([...selected, language]);
  }

  function addSet(set: readonly string[], label = "") {
    if (resending || buying) return;
    const all = set.every((l) => selected.includes(l));
    setSelection(
      all
        ? selected.filter((l) => !set.includes(l))
        : [...new Set([...selected, ...set])],
    );
    if (!all) {
      const added = set.filter((l) => selected.includes(l)).length;
      if (added < set.length)
        truncatedPick = { label, added, count: set.length };
    }
  }

  function cancelQuote() {
    quoteRequest += 1;
    if (quoteTimer) clearTimeout(quoteTimer);
    quoteTimer = null;
    quoting = false;
  }

  /** Price the ticked languages once the selection rests. */
  function schedulePrice(delay = quoteDelayMs) {
    if (buying || resending) return;
    cancelQuote();
    error = null;
    funds = null;
    // A different selection is a different decision: never carry a key over.
    decisionKey = null;
    if (!selected.length) {
      currentQuote = null;
      return;
    }
    quoting = true;
    const mine = quoteRequest;
    quoteTimer = setTimeout(() => {
      quoteTimer = null;
      if (mine === quoteRequest) void price(mine, [...selected]);
    }, delay);
  }

  async function price(mine: number, langs: string[]) {
    try {
      const readOrder = beginAccountBalanceRead();
      const answer = await requestQuote(langs);
      if (answer) recordQuotedBalanceRead(answer, readOrder);
      if (mine !== quoteRequest) return;
      if (!answer) {
        currentQuote = null;
        error = $t(
          "translationJobs.quoteUnavailable",
          "Several languages at once is not available yet. Translate one language at a time from the Translations panel.",
        );
        return;
      }
      // A line the server will not sell is unticked and re-priced without:
      // the total on screen is always for exactly what is ticked.
      const refusedNow = answer.items.filter((item) => !item.available);
      if (refusedNow.length) {
        const next = new Map(blocked);
        for (const item of refusedNow)
          next.set(item.language, refusalReason(item.reason, item.language));
        blocked = next;
        const keep = selected.filter((l) => !next.has(l));
        quoting = false;
        setSelection(keep);
        if (!keep.length) currentQuote = null;
        return;
      }
      currentQuote = answer;
    } catch (caught) {
      if (mine !== quoteRequest) return;
      currentQuote = null;
      funds = insufficientFundsFromError(caught);
      if (!funds)
        error = translationPurchaseError(caught, {
          t: $t,
          language: langs.map(label).join(", "),
        });
    } finally {
      if (mine === quoteRequest) quoting = false;
    }
  }

  const quotedBalance = createQuotedBalanceDisplay((owner, order, balance) => {
    if (typeof window !== "undefined" && owner) {
      authStore.fenceAccountSnapshot(owner.username, order);
      // Dispatch order cannot establish when the database read occurred.
      authStore.observeAccountBalanceSnapshot({
        username: owner.username,
        id: owner.id,
        tuzis: balance,
      });
    }
  });
  const displayBalance = $derived(
    quotedBalance(currentQuote, owner, $currentUser),
  );
  const balanceChanged = $derived(
    Boolean(currentQuote) &&
      compareDecimalText(displayBalance, currentQuote?.balance ?? "0") !== 0,
  );

  /** The quote on screen prices exactly the ticked languages. */
  const quoteMatches = $derived.by(() => {
    if (!currentQuote || quoting) return false;
    const priced = currentQuote.items.map((item) => item.language);
    return (
      priced.length === selected.length &&
      selected.every((l) => priced.includes(l)) &&
      currentQuote.items.every((item) => item.available)
    );
  });
  const priceOf = $derived(
    new Map(
      (currentQuote?.items ?? []).map((item) => [item.language, item.price]),
    ),
  );
  const total = $derived(
    (currentQuote?.items ?? [])
      .filter((item) => selected.includes(item.language) && item.available)
      .reduce((sum, item) => sum + Number(item.price || 0), 0),
  );
  /** More lines than this account may start right now ( `capacity`). */
  const overCapacity = $derived(
    quoteMatches &&
      typeof currentQuote?.capacity === "number" &&
      selected.length > currentQuote.capacity,
  );
  /** The quote says the balance does not cover it. */
  const unaffordable = $derived(
    quoteMatches && currentQuote?.affordable === false,
  );
  const canBuy = $derived(
    quoteMatches && !funds && !overCapacity && !unaffordable && !buying,
  );
  const replacesDraft = (language: string) => {
    const item = currentQuote?.items.find((i) => i.language === language);
    return (
      replaces.has(language) ||
      Boolean(item?.existing_variant && !item.existing_variant.is_published)
    );
  };

  function refusalReason(code: string | null | undefined, language: string) {
    // On ONE line this code means "that language is already translating",
    // not the account-wide cap the generic sentence describes.
    if (code === "translation_in_progress")
      return $t("translationJobs.alreadyTranslating", "Already translating");
    return translationPurchaseError(
      { status: 409, data: { code: code ?? "" } },
      { t: $t, language: label(language) },
    );
  }

  async function confirm() {
    if (!currentQuote || buying || !(resending || canBuy)) return;
    decisionKey ??= newIdempotencyKey();
    const key = decisionKey;
    const lines = [...selected];
    // ONE immutable decision — quote (with its article), lines and key — sent
    // by the first request and its automatic retry alike. Re-reading
    // `currentQuote` after an await could buy a quote nobody confirmed.
    const decision = currentQuote;
    buying = true;
    let repriceAfterRefusal = false;
    let changedPrice = false;
    error = null;
    try {
      try {
        await purchase(decision, lines, key);
      } catch (first) {
        // The answer may have been lost after the debit committed. The same
        // key replays a purchase that landed and performs one that did not —
        // never both.
        if (!isAmbiguousOutcome(first)) throw first;
        await purchase(decision, lines, key);
      }
      onclose();
    } catch (caught) {
      const data = (caught as { data?: { items?: unknown } })?.data;
      // The key is retired ONLY by a refusal that proves nothing was charged.
      // A 403, a 429, `request_in_progress`, a lost answer: the debit may have
      // committed, so the next click must re-send this same key.
      const noCharge = isNoChargeRefusal(caught);
      if (noCharge) {
        decisionKey = null;
        resending = false;
      }
      funds = insufficientFundsFromError(caught);
      const items = Array.isArray(data?.items)
        ? (data.items as { language?: string; code?: string }[])
        : [];
      if (funds) {
        // Nothing more to show: the balance explains it.
      } else if (
        translationErrorCode(caught) === "source_changed" ||
        (items.length && items.every((item) => item?.code === "price_changed"))
      ) {
        // The article (or only the prices) moved since this quote. Nothing
        // was charged; price the same languages again.
        repriceAfterRefusal = true;
        changedPrice = true;
      } else if (items.length) {
        // 409 naming the lines that cannot be bought. Nothing was charged:
        // the purchase is all or nothing. Untick them and price the rest as a
        // new decision — which also picks up any line whose price moved.
        const next = new Map(blocked);
        for (const item of items)
          if (
            typeof item?.language === "string" &&
            item.code !== "price_changed"
          )
            next.set(item.language, refusalReason(item.code, item.language));
        blocked = next;
        truncatedPick = null;
        selected = selected.filter((l) => !next.has(l));
        repriceAfterRefusal = true;
      } else if (decisionKey !== null) {
        // Keep the key: the next click replays THIS decision.
        error = $t(
          "translationJobs.purchaseUnknown",
          "We could not tell whether that went through. Check the tray before buying again — pressing Translate again re-sends this same purchase and never charges twice.",
        );
      } else {
        error = translationPurchaseError(caught, {
          t: $t,
          language: lines.map(label).join(", "),
        });
      }
    } finally {
      buying = false;
      if (repriceAfterRefusal) {
        schedulePrice(0);
        if (changedPrice)
          error = $t(
            "translationJobs.repriced",
            "The price changed since you looked. This is the new one — nothing was charged.",
          );
      }
    }
  }

  function close() {
    if (buying) return;
    cancelQuote();
    onclose();
  }

  const statusText = $derived(
    !selected.length
      ? $t("translationJobs.pickNone", "Pick one or more languages.")
      : quoting
        ? $t("editor.translateAiQuoting", "Working out the price…")
        : $t("translationJobs.selectedCount", "{count} selected", {
            count: selected.length,
          }),
  );
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="translate-into-title"
      tabindex="-1"
      use:focusTrap
      class="flex max-h-[92dvh] w-full flex-col rounded-t-xl border border-border bg-background shadow-lg sm:max-h-[85dvh] sm:max-w-lg sm:rounded-lg"
      data-testid="translate-into-dialog"
    >
      <header class="border-b border-border/60 px-5 pt-5 pb-3">
        <h2 id="translate-into-title" class="text-lg font-semibold">
          {$t("translationJobs.pickTitle", "Translate this article")}
        </h2>
        <p class="mt-1 text-sm text-muted-foreground">
          {resending
            ? $t(
                "translationJobs.resendBody",
                "This purchase was not confirmed. Re-send it to find out — it never charges twice.",
              )
            : $t(
                "translationJobs.pickBodyShort",
                "Pick languages. They translate at the same time while you keep writing.",
              )}
        </p>
      </header>

      {#if !resending}
        <div class="space-y-3 px-5 pt-3">
          <input
            type="search"
            bind:value={query}
            autocomplete="off"
            spellcheck="false"
            placeholder={$t(
              "editor.languageSearchPlaceholder",
              "Search languages, or type a language code…",
            )}
            aria-label={$t(
              "editor.languageSearchPlaceholder",
              "Search languages, or type a language code…",
            )}
            aria-controls="translate-into-list"
            class="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
          />
          {#if quickSets.length && !query}
            <div
              class="flex flex-wrap gap-2"
              role="group"
              aria-label={$t("translationJobs.quickSets", "Quick picks")}
            >
              {#each quickSets as set (set.id)}
                {@const on = set.languages.every((l) => selected.includes(l))}
                <button
                  type="button"
                  aria-pressed={on}
                  onclick={() => addSet(set.languages, set.label)}
                  class="min-h-10 rounded-full border px-3 text-sm {on
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground'}"
                >
                  {set.label}
                </button>
              {/each}
            </div>
          {/if}
          {#if truncatedPick}
            <p
              class="text-xs text-amber-700 dark:text-amber-400"
              role="status"
              data-testid="translate-into-pick-truncated"
            >
              {$t(
                "translationJobs.pickTruncated",
                "{set}: only {added} of {count} added — up to {max} languages at once.",
                {
                  set: truncatedPick.label,
                  added: truncatedPick.added,
                  count: truncatedPick.count,
                  max: cap,
                },
              )}
            </p>
          {:else if atCap}
            <p
              class="text-xs text-muted-foreground"
              data-testid="translate-into-cap"
            >
              {$t(
                "translationJobs.atCap",
                "Up to {max} languages at once. Untick one to pick another.",
                { max: cap },
              )}
            </p>
          {/if}
        </div>
      {/if}

      <ul
        id="translate-into-list"
        class="mt-2 flex-1 overflow-y-auto px-2 pb-2"
        aria-label={$t("translationJobs.pickList", "Languages")}
      >
        {#each resending ? entries.filter( (e) => selected.includes(e.language) ) : visible as entry (entry.language)}
          {@const reason =
            unavailable.get(entry.language) ?? blocked.get(entry.language)}
          {@const on = selected.includes(entry.language)}
          {@const price = on ? priceOf.get(entry.language) : undefined}
          <li>
            <label
              class="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm {reason ||
              (atCap && !on)
                ? 'text-muted-foreground'
                : 'cursor-pointer'}"
              data-language={entry.language}
            >
              <input
                type="checkbox"
                class="size-4 accent-primary"
                checked={on}
                disabled={Boolean(reason) || resending || (atCap && !on)}
                onchange={() => toggle(entry.language)}
              />
              <span class="flex min-w-0 flex-1 flex-col">
                <span>{entry.name}</span>
                {#if on && replacesDraft(entry.language)}
                  <!-- Buying over a saved draft replaces it; the single
                       dialog says so, and so must this one. The quote's own
                       `existing_variant` is read too: the editor's cached
                       rows miss a draft saved on another device. -->
                  <span
                    class="text-xs text-amber-700 dark:text-amber-400"
                    data-testid="translate-into-replaces"
                    >{$t(
                      "translationJobs.replacesDraft",
                      "Replaces your saved draft",
                    )}</span
                  >
                {/if}
              </span>
              {#if reason}
                <span class="max-w-[55%] text-right text-xs">{reason}</span>
              {:else if price !== undefined && price !== null}
                <span
                  class="tabular-nums"
                  data-testid="translate-into-line-price"
                  >{$t("editor.translateAiPrice", "{price} 2Z", {
                    price,
                  })}</span
                >
              {:else if entry.autonym && entry.autonym !== entry.name}
                <bdi
                  dir={entry.direction}
                  lang={entry.language}
                  class="text-xs text-muted-foreground">{entry.autonym}</bdi
                >
              {/if}
            </label>
          </li>
        {:else}
          <li class="px-3 py-8 text-center text-sm text-muted-foreground">
            {$t("editor.languageSearchNoResults", "No languages match that.")}
          </li>
        {/each}
      </ul>

      <div class="space-y-2 border-t border-border/60 px-5 pt-3 text-sm">
        <div class="flex items-baseline justify-between gap-3">
          <!-- Only this line is live: it is the one that changes. -->
          <p class="text-muted-foreground" aria-live="polite">{statusText}</p>
          {#if quoteMatches}
            <span
              class="text-xl font-semibold tabular-nums"
              data-testid="translate-into-total"
              >{$t("editor.translateAiPrice", "{price} 2Z", {
                price: total,
              })}</span
            >
          {/if}
        </div>
        {#if selected.length && !resending}
          <!-- What is being bought, by name ( verification): a compact
               wrapped list, collapsed past CHOSEN_SHOWN. The total is shown
               once, beside the status line above. -->
          <ul
            class="flex flex-wrap gap-1"
            aria-label={$t(
              "translationJobs.chosenLanguages",
              "Translating into",
            )}
            data-testid="translate-into-chosen"
          >
            {#each showAllChosen ? chosenNames : chosenNames.slice(0, CHOSEN_SHOWN) as name (name)}
              <li class="rounded-full bg-muted px-2 py-0.5 text-xs">{name}</li>
            {/each}
            {#if chosenNames.length > CHOSEN_SHOWN}
              <li>
                <button
                  type="button"
                  class="min-h-6 rounded-full px-2 py-0.5 text-xs text-muted-foreground underline-offset-2 hover:underline"
                  aria-expanded={showAllChosen}
                  data-testid="translate-into-chosen-more"
                  onclick={() => (showAllChosen = !showAllChosen)}
                >
                  {showAllChosen
                    ? $t("translationJobs.chosenFewer", "Show fewer")
                    : $t("translationJobs.chosenMore", "+{count} more", {
                        count: chosenNames.length - CHOSEN_SHOWN,
                      })}
                </button>
              </li>
            {/if}
          </ul>
        {/if}
        {#if quoteMatches}
          <p class="text-xs text-muted-foreground">
            {#if currentQuote?.balance}{$t(
                "editor.translateAiBalance",
                "Balance {balance} 2Z · Free2Z credits",
                { balance: displayBalance },
              ) + " · "}{/if}{$t(
              "translationJobs.termsShort",
              "Each arrives as a draft to review. A failed one is refunded — unless the article or that translation changed while it ran; then the work done is charged, never more than its price.",
            )}
          </p>
        {/if}
        {#if overCapacity}
          <p
            class="text-amber-700 dark:text-amber-400"
            data-testid="translate-into-capacity"
          >
            {$t(
              "translationJobs.overCapacity",
              "Your account can start {capacity} more right now ({inFlight} running). Remove some languages, or come back when some finish.",
              {
                capacity: currentQuote?.capacity ?? 0,
                inFlight: currentQuote?.in_flight ?? 0,
              },
            )}
          </p>
        {/if}
        {#if funds}
          <InsufficientFunds {owner} {funds} />
        {:else if unaffordable && currentQuote?.balance !== undefined}
          <InsufficientFunds
            {owner}
            funds={makeInsufficientFunds(total, displayBalance, "translation")}
          />
        {/if}
        {#if error}
          <p
            class="text-destructive"
            role="alert"
            data-testid="translate-into-error"
          >
            {error}
          </p>
        {/if}
      </div>

      <footer class="flex flex-wrap items-center justify-end gap-2 px-5 py-3">
        <button
          type="button"
          class="min-h-10 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50"
          disabled={buying}
          onclick={close}
        >
          {$t("common.cancel", "Cancel")}
        </button>
        {#if !resending && !quoting && selected.length && ((!quoteMatches && (error || funds)) || balanceChanged || unaffordable)}
          <button
            type="button"
            class="min-h-10 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50"
            disabled={buying}
            onclick={() => schedulePrice(0)}
          >
            {$t("editor.translateRetryQuote", "Refresh price and balance")}
          </button>
        {/if}
        <button
          type="button"
          class="min-h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={!(resending ? currentQuote && !buying : canBuy)}
          onclick={() => void confirm()}
          data-testid="translate-into-confirm"
        >
          {buying
            ? $t("editor.translateAiBuying", "Starting…")
            : resending
              ? $t("translationJobs.resend", "Re-send purchase")
              : quoteMatches
                ? $t("translationJobs.confirmMany", "Translate {count}", {
                    count: selected.length,
                  })
                : $t("translationJobs.confirmIdle", "Translate")}
        </button>
      </footer>
    </div>
  </div>
{/if}

<svelte:window
  onkeydown={(event) => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    close();
  }}
/>
