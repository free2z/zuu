<script lang="ts">
  import { goto } from "$app/navigation";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Users, Radio, Video } from "@lucide/svelte";
  import TuziMark from "$lib/components/TuziMark.svelte";
  import { Button } from "$lib/components/ui/button";
  import type { StreamInfo } from "$lib/services/stream";
  import {
    formatLocalizedNumber,
    isSingularCount,
    locale,
    tStore as t,
  } from "$lib/i18n";
  import { streamWatchPath } from "$lib/utils/stream-path";

  export let open = false;
  export let username: string;
  export let streams: StreamInfo[] = [];

  function handleJoin(stream: StreamInfo) {
    open = false;
    goto(streamWatchPath(username, stream.type));
  }

  function streamTypeLabel(type: StreamInfo["type"]) {
    if (type === "broadcast")
      return $t("stream.types.broadcast", "Public broadcast");
    if (type === "subscribers-only") {
      return $t("stream.types.subscribersOnly", "Subscribers only");
    }
    return $t("stream.types.payPerView", "Pay per view");
  }

  function viewerCount(count: number | undefined) {
    if (count == null) {
      return $t("stream.viewerCountUnknown", "Viewer count unavailable");
    }
    const formattedCount = formatLocalizedNumber(count, $locale);
    return isSingularCount(count, $locale)
      ? $t("stream.viewerCountOne", "{count} viewer", {
          count: formattedCount,
        })
      : $t("stream.viewerCountOther", "{count} viewers", {
          count: formattedCount,
        });
  }

  function formatAmount(value: number | string) {
    return new Intl.NumberFormat($locale, { maximumFractionDigits: 2 }).format(
      Number(value),
    );
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-[425px]">
    <Dialog.Header>
      <Dialog.Title
        >{$t("stream.selection.title", "Join {username}'s Stream", {
          username,
        })}</Dialog.Title
      >
      <Dialog.Description>
        {$t(
          "stream.selection.description",
          "{username} has multiple live streams running. Choose which one you want to join.",
          { username },
        )}
      </Dialog.Description>
    </Dialog.Header>

    <div class="grid gap-4 py-4">
      {#each streams as stream}
        <Button
          variant="outline"
          class="group flex h-auto w-full min-w-0 items-center justify-between rounded-lg border-zinc-700 bg-zinc-800/50 p-4 text-left transition-all hover:border-zinc-600 hover:bg-zinc-800"
          onclick={() => handleJoin(stream)}
        >
          <div class="flex min-w-0 items-center gap-3">
            <div
              class={`shrink-0 rounded-full p-2 ${
                stream.type === "broadcast"
                  ? "bg-blue-500/20 text-blue-400"
                  : stream.type === "subscribers-only"
                    ? "bg-purple-500/20 text-purple-400"
                    : "bg-green-500/20 text-green-400"
              }`}
            >
              {#if stream.type === "broadcast"}
                <Radio size={20} />
              {:else if stream.type === "subscribers-only"}
                <Users size={20} />
              {:else}
                <TuziMark size={20} />
              {/if}
            </div>
            <div class="min-w-0">
              <h4
                class="font-medium whitespace-normal text-white capitalize transition-colors group-hover:text-blue-400"
              >
                {streamTypeLabel(stream.type)}
              </h4>
              <div
                class="flex flex-wrap items-center gap-2 text-sm whitespace-normal text-zinc-400"
              >
                <span class="flex items-center gap-1">
                  <Users size={12} />
                  {viewerCount(stream.participant_count)}
                </span>
                {#if stream.price_per_minute}
                  <span>•</span>
                  <span
                    >{$t("stream.pricePerMinuteShort", "{amount} 2Z/min", {
                      amount: formatAmount(stream.price_per_minute),
                    })}</span
                  >
                {/if}
              </div>
            </div>
          </div>
          <div
            class="shrink-0 text-zinc-500 transition-colors group-hover:text-white"
          >
            <Video size={20} />
          </div>
        </Button>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
