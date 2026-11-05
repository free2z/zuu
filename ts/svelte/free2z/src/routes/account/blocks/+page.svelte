<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { Button } from "$lib/components/ui/button";
  import { tStore as t } from "$lib/i18n";
  import { setBlocked } from "$lib/moderation";
  import { authStore, currentUser } from "$lib/stores/auth";
  import {
    blockedUsernames,
    blockSessionGeneration,
    blockListStatus,
    retryBlocks,
    setLocallyBlocked,
  } from "$lib/stores/blocks";

  let pending = "";
  let error = false;
  let refreshError = false;
  $: names = [...$blockedUsernames].sort((a, b) => a.localeCompare(b));
  $: account = $currentUser?.username ?? "";
  $: if ($blockSessionGeneration !== lastSession) {
    lastSession = $blockSessionGeneration;
    pending = "";
    error = false;
    refreshError = false;
  }
  let lastSession = -1;

  async function unblock(username: string) {
    if (!account || pending) return;
    const reader = account;
    const owns = authStore.captureRequestOwnership();
    pending = username;
    error = false;
    refreshError = false;
    const outcome = await setBlocked(username, false);
    if (!owns() || $currentUser?.username !== reader) return;
    pending = "";
    if (!outcome.ok || outcome.blocked) {
      error = true;
      return;
    }
    setLocallyBlocked(username, false, reader);
    try {
      await invalidateAll();
    } catch {
      if (owns() && $currentUser?.username === reader) refreshError = true;
    }
  }
</script>

<svelte:head
  ><title>{$t("moderation.manage.title", "Blocked accounts")} | Free2Z</title
  ></svelte:head
>
<main class="mx-auto w-full max-w-3xl px-4 py-8" data-testid="block-management">
  <h1 class="text-2xl font-bold">
    {$t("moderation.manage.title", "Blocked accounts")}
  </h1>
  {#if !$currentUser}
    <p class="mt-4">
      {$t("moderation.manage.signIn", "Sign in to manage blocked accounts.")}
    </p>
  {:else if $blockListStatus === "loading" || $blockListStatus === "idle"}
    <p class="mt-4" role="status">
      {$t("moderation.manage.loading", "Loading blocked accounts…")}
    </p>
  {:else}
    {#if $blockListStatus === "error"}
      <div role="alert" class="mt-4 space-y-2">
        <p>
          {$t(
            "moderation.manage.loadError",
            "Could not load the full block list.",
          )}
        </p>
        <Button type="button" onclick={retryBlocks}
          >{$t("moderation.manage.retry", "Retry")}</Button
        >
      </div>
    {/if}
    {#if error}<p role="alert" class="mt-4">
        {$t(
          "moderation.manage.unblockError",
          "Could not unblock this account. Try again.",
        )}
      </p>{/if}
    {#if refreshError}
      <p role="alert" class="mt-4">
        {$t(
          "moderation.manage.refreshError",
          "Account unblocked, but the page could not refresh. Reload to update content.",
        )}
      </p>
    {/if}
    {#if names.length}
      <ul class="mt-4 divide-y divide-border">
        {#each names as username (username)}
          <li class="flex items-center justify-between gap-4 py-3">
            <a class="underline" href="/{username}">@{username}</a>
            <Button
              type="button"
              variant="outline"
              disabled={!!pending}
              onclick={() => unblock(username)}
            >
              {$t("moderation.block.unblockUser", "Unblock @{username}", {
                username,
              })}
            </Button>
          </li>
        {/each}
      </ul>
    {:else if $blockListStatus === "ready"}
      <p class="mt-4">
        {$t("moderation.manage.empty", "You have not blocked any accounts.")}
      </p>
    {/if}
  {/if}
</main>
