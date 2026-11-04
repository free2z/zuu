<script lang="ts">
  import InsufficientFunds from "$lib/components/InsufficientFunds.svelte";
  import { ApiError, customInstance } from "$lib/api/mutator";
  import { apiFetch } from "$lib/api/config";
  import {
    beginAccountBalanceRead,
    recordQuotedBalanceRead,
  } from "$lib/account-balance";
  import { onMount } from "svelte";
  import {
    insufficientFundsFromError,
    insufficientFundsFromResponse,
    type InsufficientFundsDetails,
  } from "$lib/insufficient-funds";
  let {
    requestUrl,
    generated = false,
  }: { requestUrl?: string; generated?: boolean } = $props();
  let funds = $state<InsufficientFundsDetails | null>(
    requestUrl
      ? null
      : insufficientFundsFromError(
          recordQuotedBalanceRead(
            new ApiError("Insufficient funds", 402, {
              code: "insufficient_funds" as const,
              cost: "20",
              balance: "5",
              shortfall: "15",
              action: "donation",
            }),
            beginAccountBalanceRead(),
          ),
        ),
  );
  onMount(() => {
    if (!requestUrl) return;
    if (generated)
      void customInstance(requestUrl, { method: "POST" }).catch((error) => {
        funds = insufficientFundsFromError(error);
      });
    else
      void apiFetch(requestUrl, { method: "POST" }).then(async (response) => {
        funds = await insufficientFundsFromResponse(response);
      });
  });
  let draft = $state("My unsent message");
</script>

<textarea aria-label="Unsent donation message" bind:value={draft}></textarea>
{#if funds}<InsufficientFunds {funds} />{/if}
