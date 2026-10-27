<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "$lib/api/mutator";
  import {
    economyCapabilities,
    economyAgreement,
    economyAgreementAccept,
    economyEarnings,
    economyPaymentsList,
    economyPaymentRequest,
    economyFundingResolutions,
  } from "$lib/api/economy/economy";
  import type {
    Capabilities,
    Earnings,
    Agreement,
    AcceptAgreement,
    Payment,
    PaymentCreate,
    FundingResolution,
  } from "$lib/api/f2z.schemas";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { locale, tStore as t } from "$lib/i18n";
  import { formatUsd, positiveUsd, usdFixed } from "$lib/economy-values.js";
  import {
    readEconomyIntent,
    prepareEconomyIntent,
    clearEconomyIntent,
  } from "$lib/economy-intent.js";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Label } from "$lib/components/ui/label";
  import {
    Card,
    CardHeader,
    CardTitle,
    CardDescription,
    CardContent,
  } from "$lib/components/ui/card";

  export let ownerUsername: string;
  type Pending = ReturnType<typeof readEconomyIntent>;
  let capabilities: Capabilities | null = null;
  let earnings: Earnings | null = null;
  let agreement: Agreement | null = null;
  let payments: Payment[] = [];
  let fundingResolutions: FundingResolution[] = [];
  let accepted = false;
  let reviewingAgreement = false;
  let loading = true;
  let error = "";
  let notice = "";
  let onboarding = false;
  let busy = false;
  let amount = "";
  let address = "";
  let pendingPayment: Pending = null;
  let actor = 0;
  let mounted = false;
  let epoch = 0;

  $: transactional = capabilities?.policy_version === 1 && capabilities.active;
  $: agreementReady =
    agreement !== null &&
    [agreement.version, agreement.digest, agreement.text].every(
      (value) => typeof value === "string" && value.length > 0,
    ) &&
    Array.isArray(agreement.schedules) &&
    agreement.schedules.length > 0 &&
    agreement.schedules.every(
      (schedule) =>
        schedule.currency === "USD" &&
        [
          schedule.service,
          schedule.version,
          schedule.digest,
          schedule.text,
        ].every((value) => typeof value === "string" && value.length > 0),
    );
  $: if (
    mounted &&
    actor !== ($currentUser?.username === ownerUsername ? $currentUser.id : 0)
  ) {
    amount = "";
    address = "";
    pendingPayment = null;
    actor = $currentUser?.username === ownerUsername ? $currentUser.id : 0;
    void refresh();
  }

  function validActivity(
    activity: NonNullable<Earnings["recent_activity"]>[number],
  ) {
    try {
      return (
        activity.currency === "USD" &&
        ["livestream_ppv", "sdk_application"].includes(activity.service) &&
        !!usdFixed(activity.amount) &&
        !Number.isNaN(Date.parse(activity.created_at))
      );
    } catch {
      return false;
    }
  }
  function errorCode(cause: unknown): string | undefined {
    return cause instanceof ApiError && typeof cause.data?.code === "string"
      ? cause.data.code
      : undefined;
  }
  async function refresh() {
    const readEpoch = ++epoch;
    earnings = null;
    agreement = null;
    capabilities = null;
    payments = [];
    fundingResolutions = [];
    accepted = false;
    reviewingAgreement = false;
    onboarding = false;
    error = "";
    notice = "";
    pendingPayment = null;
    loading = true;
    if (!actor) {
      loading = false;
      return;
    }
    const account = actor;
    const stillCurrent = () => readEpoch === epoch && actor === account;
    void economyCapabilities({ timeoutMs: 10000 })
      .then((value) => {
        if (stillCurrent()) capabilities = value;
      })
      .catch(() => {});
    void economyAgreement({ timeoutMs: 10000 })
      .then((value) => {
        if (stillCurrent()) agreement = value;
      })
      .catch(() => {});
    void economyPaymentsList(
      { expected_actor_id: account },
      { timeoutMs: 10000 },
    )
      .then((value) => {
        if (!stillCurrent()) return;
        if (value.actor_id !== account) {
          error = $t("economy.signInAgain");
          return;
        }
        payments = value.results;
      })
      .catch(() => {});
    void economyFundingResolutions(
      { expected_actor_id: account },
      { timeoutMs: 10000 },
    )
      .then((value) => {
        if (!stillCurrent()) return;
        if (value.actor_id !== account) {
          error = $t("economy.signInAgain");
          return;
        }
        fundingResolutions = value.results;
      })
      .catch(() => {});
    try {
      const value = await economyEarnings(
        { expected_actor_id: account },
        { timeoutMs: 10000 },
      );
      if (!stillCurrent()) return;
      if (value.actor_id !== account)
        throw new Error($t("economy.signInAgain"));
      if (value.currency !== "USD") throw new Error("Unexpected currency");
      for (const name of [
        "balance",
        "held",
        "available",
        "payment_in_flight",
      ] as const)
        usdFixed(value[name]);
      earnings = value;
      if (!amount) amount = value.available;
    } catch (cause) {
      if (!stillCurrent()) return;
      onboarding = errorCode(cause) === "earnings_onboarding_required";
      if (!onboarding) error = $t("economy.unavailable");
    }
    try {
      pendingPayment = readEconomyIntent(localStorage, actor, "payment");
      if (pendingPayment) {
        amount = pendingPayment.payload.amount;
        address = pendingPayment.payload.address;
      }
    } catch {
      error = $t("economy.savedRequestUnavailable");
    }
    loading = false;
  }
  async function verifiedActor() {
    const expected = actor;
    const authenticated = await authStore.checkAuth({
      fresh: true,
      force: true,
      silent: true,
    });
    if (
      authenticated !== true ||
      !expected ||
      $currentUser?.id !== expected ||
      $currentUser.username !== ownerUsername
    ) {
      throw new Error($t("economy.signInAgain"));
    }
    return expected;
  }
  async function acceptAgreement() {
    if (!agreement || !agreementReady || !accepted || busy) return;
    busy = true;
    error = "";
    const expected = actor;
    const displayedAcceptance: AcceptAgreement = {
      expected_actor_id: expected,
      version: agreement.version,
      digest: agreement.digest,
      acknowledged: true,
      schedules: agreement.schedules.map(({ service, version, digest }) => ({
        service,
        version,
        digest,
      })),
    };
    try {
      await verifiedActor();
      await economyAgreementAccept(displayedAcceptance);
      if (actor === expected) {
        await refresh();
        notice = $t("economy.accepted");
      }
    } catch (cause) {
      if (actor === expected)
        error =
          cause instanceof Error ? cause.message : $t("economy.unavailable");
    } finally {
      busy = false;
    }
  }
  async function submitPayment() {
    if (busy || !transactional) return;
    busy = true;
    error = "";
    notice = "";
    const expected = actor;
    let attempted: Pending = null;
    try {
      await verifiedActor();
      let pending = pendingPayment;
      if (!pending) {
        const value = usdFixed(amount);
        if (!positiveUsd(value)) throw new Error($t("economy.positiveAmount"));
        if (
          !earnings ||
          BigInt(value.replace(".", "")) >
            BigInt(usdFixed(earnings.available).replace(".", ""))
        )
          throw new Error($t("economy.exceedsAvailable"));
        if (!address.trim()) throw new Error($t("economy.addressRequired"));
        pending = await prepareEconomyIntent(
          localStorage,
          navigator.locks,
          expected,
          "payment",
          { amount: value, address: address.trim() },
        );
        pendingPayment = pending;
        amount = pending.payload.amount;
        address = pending.payload.address;
        if (pending.reused) throw new Error($t("economy.existingOriginal"));
      }
      attempted = pending;
      await verifiedActor();
      const receipt = await economyPaymentRequest(
        pending.payload as PaymentCreate,
      );
      if (
        typeof receipt.id !== "string" ||
        !receipt.id ||
        receipt.currency !== "USD" ||
        receipt.amount !== pending.payload.amount ||
        ![
          "requested",
          "approved",
          "signing",
          "broadcast_unknown",
          "broadcast",
          "confirmed",
          "rejected",
        ].includes(receipt.state)
      )
        throw new Error($t("economy.unknownOutcome"));
      await clearEconomyIntent(
        localStorage,
        navigator.locks,
        expected,
        "payment",
        pending.payload.idempotency_key,
      );
      if (actor === expected) {
        await refresh();
        notice = $t("economy.requestRecorded");
      }
    } catch (cause) {
      const refusal = cause as { code?: string; status?: number };
      if (
        attempted &&
        actor === expected &&
        [400, 409].includes(refusal.status || 0) &&
        [
          "invalid_payment_address",
          "shielded_payment_address_required",
          "invalid_request",
          "insufficient_payable",
        ].includes(errorCode(cause) || "")
      ) {
        try {
          await clearEconomyIntent(
            localStorage,
            navigator.locks,
            expected,
            "payment",
            attempted.payload.idempotency_key,
          );
          pendingPayment = readEconomyIntent(localStorage, expected, "payment");
        } catch {
          error = $t("economy.savedRequestUnavailable");
        }
      }
      if (actor === expected && !error)
        error =
          cause instanceof Error ? cause.message : $t("economy.unknownOutcome");
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    mounted = true;
  });
</script>

<Card data-testid="creator-earnings">
  <CardHeader>
    <CardTitle>{$t("economy.title")}</CardTitle>
    <CardDescription>{$t("economy.separate")}</CardDescription>
  </CardHeader>
  <CardContent class="space-y-5">
    {#if loading}<p role="status">{$t("economy.loading")}</p>
    {:else if earnings}
      <div class="grid gap-3 sm:grid-cols-3">
        {#each [["balance", "owed"], ["held", "held"], ["available", "available"]] as [field, label]}
          <div class="min-w-0 rounded-lg bg-muted/40 p-3">
            <p class="text-sm text-muted-foreground">
              {$t(`economy.${label}`)}
            </p>
            <p
              class="text-lg font-semibold break-words"
              data-testid={`earnings-${field}`}
              title={`${earnings[field as "balance"]} USD`}
            >
              {formatUsd(earnings[field as "balance"], $locale)}
              <span class="sr-only">({earnings[field as "balance"]} USD)</span>
            </p>
          </div>
        {/each}
      </div>
      <p class="text-sm">{$t("economy.newAgreement")}</p>
      {#if earnings.recent_activity?.length}
        <div class="space-y-2 border-t pt-4" data-testid="earnings-activity">
          <h3 class="font-semibold">{$t("economy.recentActivity")}</h3>
          {#each earnings.recent_activity as activity}
            {#if validActivity(activity)}
              <div
                class="flex flex-wrap justify-between gap-2 rounded-lg border p-3 text-sm"
              >
                <div>
                  <p>
                    {$t(
                      activity.service === "livestream_ppv"
                        ? "economy.ppvService"
                        : "economy.sdkService",
                    )}
                  </p>
                  <time datetime={activity.created_at}
                    >{new Intl.DateTimeFormat($locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(activity.created_at))}</time
                  >
                  <p class="break-all text-muted-foreground">
                    {$t("economy.reference")}: {activity.id}
                  </p>
                </div>
                <p title={`${activity.amount} USD`}>
                  {formatUsd(activity.amount, $locale)}
                  <span class="sr-only">({activity.amount} USD)</span>
                </p>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
      {#if !earnings.compensation_eligible}<p
          class="text-sm text-muted-foreground"
        >
          {$t("economy.futureUnavailable")}
        </p>{/if}
      {#if earnings.legacy_review_pending === true}<p class="text-sm">
          {$t("economy.historicalReview")}
        </p>{/if}
      {#if !transactional}<p class="text-sm">
          {$t("economy.transactionsUnavailable")}
        </p>{/if}
      {#if earnings.agreement_accepted}
        <form
          class="space-y-3 border-t pt-4"
          on:submit|preventDefault={submitPayment}
        >
          <h3 class="font-semibold">{$t("economy.requestPayment")}</h3>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <Label for="earnings-payment-amount"
                >{$t("economy.usdAmount")}</Label
              >
              <Input
                id="earnings-payment-amount"
                inputmode="decimal"
                bind:value={amount}
                disabled={busy || !!pendingPayment || !transactional}
              />
            </div>
            <div>
              <Label for="earnings-payment-address"
                >{$t("economy.paymentAddress")}</Label
              >
              <Textarea
                id="earnings-payment-address"
                bind:value={address}
                rows={3}
                class="break-all"
                disabled={busy || !!pendingPayment || !transactional}
              />
            </div>
          </div>
          <p class="text-sm text-muted-foreground">
            {$t("economy.paymentMethod")}
          </p>
          {#if pendingPayment}<p role="status" class="text-sm">
              {$t("economy.pendingRetry")}
            </p>{/if}
          <Button
            type="submit"
            disabled={busy ||
              !transactional ||
              (!pendingPayment && !positiveUsd(earnings.available))}
          >
            {$t(
              pendingPayment
                ? "economy.retryOriginal"
                : "economy.authorizePayment",
            )}
          </Button>
        </form>
      {/if}
      {#if earnings.legal_payee && agreement && agreementReady}
        {#if earnings.agreement_accepted}
          <Button
            variant="outline"
            onclick={() => {
              reviewingAgreement = !reviewingAgreement;
              accepted = false;
            }}
          >
            {$t("economy.reviewCurrentAgreement")}
          </Button>
        {/if}
        {#if !earnings.agreement_accepted || reviewingAgreement}
          <p class="text-sm">
            {$t("economy.verifiedPayee")}: {earnings.legal_payee.display_name} ({earnings
              .legal_payee.jurisdiction})
          </p>
          <details class="rounded-lg border p-3">
            <summary class="cursor-pointer font-medium"
              >{$t("economy.readAgreement")} ({agreement.version})</summary
            >
            <pre
              class="mt-3 font-sans text-sm break-words whitespace-pre-wrap">{agreement.text}</pre>
          </details>
          {#each agreement.schedules as schedule}
            <details class="rounded-lg border p-3">
              <summary class="cursor-pointer font-medium"
                >{schedule.service} ({schedule.version})</summary
              >
              <pre
                class="mt-3 font-sans text-sm break-words whitespace-pre-wrap">{schedule.text}</pre>
            </details>
          {/each}
          <p class="text-sm text-muted-foreground">
            {$t("economy.prospective")}
          </p>
          <label class="flex items-start gap-2 text-sm"
            ><input
              type="checkbox"
              bind:checked={accepted}
              disabled={busy}
              class="mt-1"
            />
            <span>{$t("economy.acceptAcknowledgment")}</span></label
          >
          <Button disabled={!accepted || busy} onclick={acceptAgreement}
            >{$t("economy.acceptAgreement")}</Button
          >
        {/if}
      {:else if !earnings.legal_payee}
        <p class="text-sm">{$t("economy.payeeReview")}</p>
        <a
          class="text-primary underline"
          href={`/${encodeURIComponent(ownerUsername)}/dashboard/kyc`}
          >{$t("economy.verification")}</a
        >
      {/if}
      {#if payments.length}
        <div class="space-y-3 border-t pt-4">
          <h3 class="font-semibold">{$t("economy.paymentHistory")}</h3>
          {#each payments as payment}
            <div class="rounded-lg border p-3 text-sm">
              <p>
                {formatUsd(payment.amount, $locale)} — {$t(
                  `economy.paymentStates.${payment.state}`,
                  $t("economy.statusUnavailable"),
                )}
              </p>
              <p class="break-all text-muted-foreground">{payment.id}</p>
              {#if payment.txid}<p class="break-all">
                  {$t("economy.transaction")}: {payment.txid}
                </p>{/if}
              {#if payment.settlement}
                <p>
                  {$t("economy.usdSettled")}: {formatUsd(
                    payment.settlement.usd_satisfaction,
                    $locale,
                  )}
                </p>
                <p>
                  {payment.settlement.amount_zec} ZEC · {payment.settlement
                    .usd_per_zec} USD/ZEC
                </p>
                <p>
                  {payment.settlement.rate_source || ""} · {payment.settlement
                    .quoted_at}
                </p>
                <p>
                  {$t("economy.companyFee")}: {payment.settlement.fee_zec} ZEC
                </p>
                <p>
                  {$t("economy.companyRounding")}: {formatUsd(
                    payment.settlement.rounding_expense,
                    $locale,
                  )}
                </p>
                <p>
                  {$t("economy.methodVersion")}: {payment.settlement
                    .pricing_method_version}
                </p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {:else if onboarding}
      <p>{$t("economy.onboarding")}</p>
      <a
        class="text-primary underline"
        href={`/${encodeURIComponent(ownerUsername)}/dashboard/kyc`}
        >{$t("economy.verification")}</a
      >
    {:else}
      <p>{$t("economy.unavailable")}</p>
      {#if capabilities?.policy_version === 0}<p
          class="text-sm text-muted-foreground"
        >
          {$t("economy.notActive")}
        </p>{/if}
    {/if}
    {#if fundingResolutions.length}
      <div class="space-y-3 border-t pt-4">
        <h3 class="font-semibold">{$t("economy.fundingPending")}</h3>
        <p class="text-sm">{$t("economy.fundingExplanation")}</p>
        {#each fundingResolutions as resolution}
          <div class="rounded-lg border p-3 text-sm">
            <p class="break-all">
              {$t("economy.reference")}: {resolution.resolution_id}
            </p>
            <p>{resolution.reason} · {resolution.created_at}</p>
          </div>
        {/each}
      </div>
    {/if}
    {#if error}<p role="alert" class="text-sm break-words text-destructive">
        {error}
      </p>{/if}
    {#if notice}<p role="status" class="text-sm">{notice}</p>{/if}
    <Button variant="outline" onclick={refresh} disabled={busy || loading}
      >{$t("economy.refresh")}</Button
    >
  </CardContent>
</Card>
