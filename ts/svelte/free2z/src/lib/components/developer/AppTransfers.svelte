<script lang="ts">
  import { onMount } from "svelte";
  import { tStore as t } from "$lib/i18n";
  import { authStore } from "$lib/stores/auth";
  import { Button } from "$lib/components/ui/button";
  import {
    oidcAppTransfersList,
    oidcAppTransferCreate,
    oidcAppTransferResolve,
  } from "$lib/api/oauth/oauth";
  import type { DeveloperApp, TransferOffer } from "$lib/api/f2z.schemas";
  import { ApiError } from "$lib/api/mutator";

  export let apps: DeveloperApp[];
  export let onChanged: () => void;
  let offers: TransferOffer[] = [];
  let actor: number | null = null;
  let appId = "";
  let recipient = "";
  let busy = false;
  let error = "";
  let now = Date.now();
  let serial = 0;
  let mounted = false;
  let nextCursor: string | null = null;
  let loadingMore = false;

  function ownership() {
    const own = authStore.captureRequestOwnership();
    const generation = serial;
    return () => mounted && own() && generation === serial;
  }

  async function refresh(append = false) {
    if (!actor || (append && (!nextCursor || loadingMore))) return;
    if (!append) serial++;
    const own = ownership();
    const cursor = append ? nextCursor : null;
    loadingMore = true;
    try {
      const result = await oidcAppTransfersList(
        cursor ? { cursor } : undefined,
      );
      if (own()) {
        offers = append ? [...offers, ...result.results] : result.results;
        nextCursor = result.next_cursor;
      }
    } catch {
      if (own())
        error = $t("appTransfer.loadError", "Offers could not be loaded.");
    } finally {
      if (own()) loadingMore = false;
    }
  }
  function showError(e: unknown) {
    const code = e instanceof ApiError ? e.data?.code : "";
    error =
      code === "usage_in_flight"
        ? $t(
            "appTransfer.inFlight",
            "Outstanding app usage must finish before this transfer can be accepted. Try again later.",
          )
        : $t(
            "appTransfer.failed",
            "The transfer could not be completed. Refresh and try again.",
          );
  }
  async function createOffer() {
    if (!actor || !appId || !recipient.trim()) return;
    const own = ownership();
    busy = true;
    error = "";
    try {
      await oidcAppTransferCreate(appId, {
        recipient: recipient.trim(),
        expected_actor_id: actor,
      });
      if (own()) {
        recipient = "";
        busy = false;
        await refresh();
      }
    } catch (e) {
      if (own()) showError(e);
    } finally {
      if (own()) busy = false;
    }
  }
  async function resolve(offer: TransferOffer, action: "accept" | "cancel") {
    if (
      !actor ||
      offer.state !== "pending" ||
      Date.parse(offer.expires_at) <= Date.now()
    )
      return;
    const own = ownership();
    const sameAccount = authStore.captureRequestOwnership();
    busy = true;
    error = "";
    try {
      await oidcAppTransferResolve(offer.id, action, {
        expected_actor_id: actor,
      });
      if (own()) {
        busy = false;
        await refresh();
        if (mounted && sameAccount()) onChanged();
      }
    } catch (e) {
      if (own()) {
        showError(e);
        busy = false;
        await refresh();
      }
    } finally {
      if (own()) busy = false;
    }
  }
  onMount(() => {
    mounted = true;
    const unsubscribe = authStore.subscribe((state) => {
      const id =
        state.status === "authenticated" ? (state.creator?.id ?? null) : null;
      if (id !== actor) {
        actor = id;
        serial++;
        offers = [];
        nextCursor = null;
        loadingMore = false;
        appId = "";
        recipient = "";
        error = "";
        busy = false;
        if (actor) void refresh();
      }
    });
    const timer = window.setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => {
      mounted = false;
      unsubscribe();
      window.clearInterval(timer);
      serial++;
    };
  });
</script>

<section
  class="my-8 space-y-4 rounded-lg border p-4"
  aria-labelledby="transfer-title"
>
  <h2 id="transfer-title" class="text-lg font-semibold">
    {$t("appTransfer.title", "Transfer app ownership")}
  </h2>
  <p>
    {$t(
      "appTransfer.explanation",
      "Offer an app to another account. They must accept within seven days. Existing users and their grants stay connected. Transfer every app with users before deleting your account.",
    )}
  </p>
  <p>
    {$t(
      "appTransfer.secret",
      "The previous owner may still know the client secret. After accepting a confidential app, rotate its secret and update your server.",
    )}
  </p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if apps.length}
    <form
      class="flex flex-wrap items-end gap-3"
      onsubmit={(event) => {
        event.preventDefault();
        void createOffer();
      }}
    >
      <label
        >{$t("appTransfer.app", "App")}
        <select bind:value={appId} required class="block rounded border p-2">
          <option value="">{$t("appTransfer.choose", "Choose an app")}</option>
          {#each apps.filter((app) => !app.first_party) as app}<option
              value={app.id}>{app.name}</option
            >{/each}
        </select>
      </label>
      <label
        >{$t("appTransfer.recipient", "Recipient username")}
        <input
          bind:value={recipient}
          required
          maxlength="150"
          class="block rounded border p-2"
        />
      </label>
      <Button type="submit" disabled={busy || !actor}
        >{$t("appTransfer.offer", "Send offer")}</Button
      >
    </form>
  {/if}
  <h3 class="font-semibold">{$t("appTransfer.offers", "Ownership offers")}</h3>
  {#if !offers.length}<p>{$t("appTransfer.none", "No offers yet.")}</p>{/if}
  <ul class="space-y-3">
    {#each offers as offer (offer.id)}
      {@const pending =
        offer.state === "pending" && Date.parse(offer.expires_at) > now}
      <li class="rounded border p-3" data-testid="transfer-offer">
        <p>
          <strong>{offer.application_name}</strong> · {offer.sender} → {offer.recipient}
        </p>
        <p>
          {pending
            ? $t("appTransfer.pending", "Pending")
            : offer.state === "pending" || offer.state === "expired"
              ? $t("appTransfer.expired", "Expired")
              : offer.state === "accepted"
                ? $t("appTransfer.accepted", "Accepted")
                : $t("appTransfer.cancelled", "Cancelled")}
        </p>
        <p>
          {$t("appTransfer.expires", "Expires:")}
          {new Date(offer.expires_at).toLocaleString()}
        </p>
        {#if pending}
          {#if offer.role === "recipient"}<Button
              disabled={busy}
              onclick={() => resolve(offer, "accept")}
              >{$t("appTransfer.accept", "Accept ownership")}</Button
            >{/if}
          <Button
            variant="outline"
            disabled={busy}
            onclick={() => resolve(offer, "cancel")}
            >{$t("appTransfer.cancel", "Cancel offer")}</Button
          >
        {/if}
      </li>
    {/each}
  </ul>
  {#if nextCursor}
    <Button
      variant="outline"
      disabled={loadingMore || busy}
      onclick={() => refresh(true)}
    >
      {$t("appTransfer.loadMore", "Load more offers")}
    </Button>
  {/if}
</section>
