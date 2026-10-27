<script lang="ts">
  import TranslateWithAiDialog from "$lib/components/zpageLanguage/TranslateWithAiDialog.svelte";
  import TranslateIntoDialog from "$lib/components/zpageLanguage/TranslateIntoDialog.svelte";
  import { get } from "svelte/store";
  import { currentUser } from "$lib/stores/auth";
  import { customInstance } from "$lib/api/mutator";
  import {
    insufficientFundsFromError,
    type InsufficientFundsDetails,
  } from "$lib/insufficient-funds";
  let {
    bulk = false,
    holdQuote = false,
    holdPurchase = false,
    refusePurchase = false,
    refusalUrl,
  } = $props<{
    bulk?: boolean;
    holdQuote?: boolean;
    holdPurchase?: boolean;
    refusePurchase?: boolean;
    refusalUrl?: string;
  }>();
  import {
    beginAccountBalanceRead,
    recordQuotedBalanceRead,
  } from "$lib/account-balance";
  // Real editor callers pass a full private creator, including DB metadata.
  const owner = { ...get(currentUser), id: 4301, username: "fixtureowner" };
  (window as any).fixtureQuoteOwner = owner;
  let quote = $state<any>({
    price: refusalUrl ? "20" : "70000",
    balance: refusalUrl ? "25" : "60000",
    affordable: Boolean(refusalUrl),
    ai_model: "test-model",
    existing_variant: null,
  });
  const singleReadOrder = beginAccountBalanceRead();
  if (holdQuote && !bulk) {
    const delayed = quote;
    quote = null;
    (window as any).releaseDelayedQuote = () =>
      (quote = recordQuotedBalanceRead(delayed, singleReadOrder));
  }
  let quotes = 0;
  let purchases = 0;
  let singleFunds = $state<InsufficientFundsDetails | null>(null);
  const refresh = () =>
    (quote = { ...quote, balance: $currentUser?.tuzis, affordable: true });
</script>

{#if bulk}
  <TranslateIntoDialog
    open
    {owner}
    languages={["es"]}
    initial={["es"]}
    label={() => "Spanish"}
    quoteDelayMs={0}
    quote={async () => {
      if (holdQuote && quotes === 0)
        await new Promise<void>(
          (resolve) => ((window as any).releaseDelayedQuote = resolve),
        );
      return {
        items: [
          {
            language: "es",
            price: refusalUrl
              ? 20
              : refusePurchase && quotes > 0
                ? 71000
                : 70000,
            available: true,
          },
        ],
        total: refusalUrl ? 20 : refusePurchase && quotes > 0 ? 71000 : 70000,
        balance: refusalUrl
          ? "25"
          : quotes++ === 0
            ? "60000"
            : ($currentUser?.tuzis ?? "0"),
        affordable: Number($currentUser?.tuzis) >= (refusalUrl ? 20 : 70000),
        source_digest: "same-quoted-source",
        source_language: "en",
      } as any;
    }}
    purchase={async (decision, lines, key) => {
      if (refusalUrl) {
        await customInstance<void>(refusalUrl, { method: "POST" });
        return;
      }
      (window as any).fixturePurchases ??= [];
      (window as any).fixturePurchases.push({
        total: decision.total,
        lines,
        key,
      });
      if (refusePurchase && purchases++ === 0)
        throw { status: 409, data: { code: "source_changed" } };
      if (holdPurchase)
        await new Promise<void>(
          (resolve) => ((window as any).releasePurchase = resolve),
        );
    }}
    onclose={() => {}}
  />
{:else}
  <TranslateWithAiDialog
    open
    {owner}
    language="Spanish"
    {quote}
    error={null}
    insufficientFunds={singleFunds}
    buying={false}
    onretry={refresh}
    onconfirm={async () => {
      if (refusalUrl)
        try {
          await customInstance(refusalUrl, { method: "POST" });
        } catch (error) {
          singleFunds = insufficientFundsFromError(error);
        }
    }}
    onclose={() => {}}
  />
{/if}
