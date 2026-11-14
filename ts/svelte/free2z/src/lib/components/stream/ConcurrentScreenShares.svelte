<script lang="ts">
  import type RealtimeKitClient from "@cloudflare/realtimekit";
  import { onDestroy, onMount } from "svelte";
  import { t } from "$lib/i18n";
  import {
    collectScreenShares,
    diffScreenShareSubscriptions,
    limitScreenShares,
  } from "$lib/utils/concurrent-screen-shares";

  export let meeting: RealtimeKitClient;
  let shares = [] as ReturnType<typeof collectScreenShares>;
  let selectedId = "";
  let error = "";
  let revision = 0;
  let disposed = false;
  const owned = new Set<string>();
  const pending = new Map<string, number>();
  let generation = 0;
  let stopListening = () => {};
  const MAX_SHARES = 4;
  function alreadySubscribed(id: string) {
    return Boolean(
      meeting.participants.joined?.get?.(id)?.manualProducerConfig
        ?.screenshareVideo,
    );
  }

  function participants() {
    const joined = meeting.participants?.joined;
    // Some lightweight integrations intentionally expose no participant map.
    // In that case there are no discoverable remote shares to render.
    return [
      ...(typeof joined?.values === "function" ? joined.values() : []),
      ...(meeting.self ? [meeting.self] : []),
    ];
  }

  function refresh() {
    if (disposed) return;
    revision += 1;
    const all = limitScreenShares(collectScreenShares(participants()), 4);
    shares = all;
    if (!all.some((share) => share.id === selectedId))
      selectedId = all[0]?.id ?? "";
    const remoteIds = all
      .map((share) => share.id)
      .filter((id) => id !== meeting.self.id);
    const desired = new Set(remoteIds);
    for (const id of [...pending.keys()]) {
      if (!desired.has(id)) {
        pending.delete(id);
        generation += 1;
      }
    }
    for (const id of [...owned]) {
      if (desired.has(id)) continue;
      owned.delete(id);
      pending.delete(id);
      generation += 1;
      void meeting.participants
        .unsubscribe([id], ["screenshareVideo"])
        .catch(() => {
          if (!disposed)
            error = t(
              "live.screenShares.unsubscribeError",
              "A screen share ended, but its video subscription could not be released.",
            );
        });
    }
    for (const id of remoteIds) {
      if (owned.has(id) || pending.has(id) || alreadySubscribed(id)) continue;
      const requestGeneration = ++generation;
      pending.set(id, requestGeneration);
      void meeting.participants
        .subscribe([id], ["screenshareVideo"])
        .then(() => {
          if (pending.get(id) !== requestGeneration || disposed) {
            // A stale completion can only be undone when this component initiated it.
            void meeting.participants
              .unsubscribe([id], ["screenshareVideo"])
              .catch(() => {});
            return;
          }
          pending.delete(id);
          owned.add(id);
          error = "";
        })
        .catch(() => {
          if (pending.get(id) === requestGeneration && !disposed) {
            pending.delete(id);
            error = t(
              "live.screenShares.subscribeError",
              "A shared screen is available, but this device could not subscribe to its video.",
            );
          }
        });
    }
  }

  // RealtimeKit emits screenShareUpdate through the aggregate joined map for
  // remote peers; self publishes its own event on meeting.self.
  onMount(() => {
    const joined = meeting.participants.joined;
    if (
      !joined ||
      typeof joined.on !== "function" ||
      typeof joined.off !== "function"
    ) {
      refresh();
      return;
    }
    joined.on("participantsUpdate", refresh);
    joined.on("participantLeft", refresh);
    joined.on("participantsCleared", refresh);
    meeting.self?.on?.("screenShareUpdate", refresh);
    // Individual remote peers emit screenShareUpdate; joined is an aggregate
    // map that does not rebroadcast this event. Keep every peer listener exact.
    const peerListeners = new Map<
      string,
      {
        peer: typeof joined extends Map<string, infer P> ? P : never;
        fn: () => void;
      }
    >();
    const syncPeerListeners = () => {
      if (typeof joined.values !== "function") return;
      const peers = joined.values();
      if (!peers || typeof peers[Symbol.iterator] !== "function") return;
      for (const [id, entry] of peerListeners)
        if (!joined.has(id)) {
          entry.peer.off("screenShareUpdate", entry.fn as never);
          peerListeners.delete(id);
        }
      for (const peer of peers)
        if (!peerListeners.has(peer.id)) {
          const fn = () => refresh();
          peer.on("screenShareUpdate", fn as never);
          peerListeners.set(peer.id, { peer, fn });
        }
    };
    const update = () => {
      syncPeerListeners();
      refresh();
    };
    joined.on("participantsUpdate", update);
    joined.on("participantLeft", update);
    syncPeerListeners();
    refresh();
    stopListening = () => {
      joined.off("participantsUpdate", refresh);
      joined.off("participantLeft", refresh);
      joined.off("participantsCleared", refresh);
      joined.off("participantsUpdate", update);
      joined.off("participantLeft", update);
      meeting.self?.off?.("screenShareUpdate", refresh);
      for (const { peer, fn } of peerListeners.values())
        peer.off("screenShareUpdate", fn as never);
      peerListeners.clear();
    };
  });

  onDestroy(() => {
    disposed = true;
    stopListening();
    for (const id of owned)
      void meeting.participants
        .unsubscribe([id], ["screenshareVideo"])
        .catch(() => {});
    owned.clear();
    pending.clear();
    generation += 1;
  });
</script>

{#if shares.length}
  <section
    class="flex max-h-72 min-h-0 flex-col gap-2 overflow-auto"
    aria-label={t("live.screenShares.title", "Shared screens")}
    data-testid="concurrent-screen-shares"
  >
    <div
      class="flex flex-wrap gap-2"
      aria-label={t("live.screenShares.choose", "Choose a shared screen")}
    >
      {#each shares as share (share.id)}
        <button
          type="button"
          aria-pressed={selectedId === share.id}
          class="cursor-pointer rounded px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2"
          onclick={() => (selectedId = share.id)}
        >
          {share.id === meeting.self.id
            ? t("live.screenShares.you", "You")
            : share.label}
        </button>
      {/each}
    </div>
    {#if error}<p role="status" class="text-sm text-amber-200">
        {t(
          "live.screenShares.subscribeError",
          "A shared screen is available, but this device could not subscribe to its video.",
        )}
      </p>{/if}
    <div
      class="grid min-h-0 grid-cols-1 gap-2 md:grid-cols-2"
      data-testid="screen-share-grid"
    >
      {#each shares as share (share.id)}
        <div
          class="relative min-h-40 overflow-hidden rounded bg-black {selectedId ===
          share.id
            ? 'ring-2 ring-primary'
            : ''}"
          aria-label={`Screen shared by ${share.label}`}
        >
          <!-- @ts-ignore RealtimeKit custom element supports self and remote peers. -->
          <rtk-screenshare-view
            {meeting}
            participant={share.id === meeting.self.id
              ? meeting.self
              : meeting.participants.joined.get(share.id)}
            size="lg"
            class="h-full w-full"
          ></rtk-screenshare-view>
          <span
            class="absolute bottom-2 left-2 rounded bg-black/75 px-2 py-1 text-sm text-white"
            >{share.label}</span
          >
        </div>
      {/each}
    </div>
  </section>
{/if}
