<script lang="ts">
  import { onMount } from "svelte";
  import ConcurrentScreenShares from "$lib/components/stream/ConcurrentScreenShares.svelte";

  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  const peers = new Map<string, any>();
  const calls: string[] = [];
  let fixtureReady = false;
  const emitter = (key: string) => ({
    on: (event: string, fn: (payload?: unknown) => void) => {
      const k = `${key}:${event}`;
      listeners.set(k, new Set([...(listeners.get(k) ?? []), fn]));
      return emitter(key);
    },
    off: (event: string, fn: (payload?: unknown) => void) =>
      listeners.get(`${key}:${event}`)?.delete(fn),
    emit: (event: string, payload?: unknown) =>
      listeners.get(`${key}:${event}`)?.forEach((fn) => fn(payload)),
  });
  const joined = Object.assign(new Map(), {
    on: (event: string, fn: (payload?: unknown) => void) =>
      emitter("joined").on(event, fn),
    off: (event: string, fn: (payload?: unknown) => void) =>
      emitter("joined").off(event, fn),
  });
  function peer(id: string, name: string) {
    return Object.assign(emitter(id), {
      id,
      name,
      screenShareEnabled: true,
      screenShareTracks: { video: undefined },
    });
  }
  peers.set("remote-a", peer("remote-a", "Ada"));
  peers.set("remote-b", peer("remote-b", "Bea"));
  joined.set("remote-a", peers.get("remote-a"));
  joined.set("remote-b", peers.get("remote-b"));
  const self = Object.assign(emitter("self"), {
    id: "self",
    name: "You",
    screenShareEnabled: true,
    screenShareTracks: { video: {} },
  });
  let pending: Array<{
    ids: string[];
    resolve: () => void;
    reject: () => void;
  }> = [];
  const meeting: any = {
    self,
    participants: {
      joined,
      subscribe: (ids: string[]) => {
        calls.push(`subscribe:${ids.join(",")}`);
        return new Promise<void>((resolve, reject) =>
          pending.push({ ids, resolve, reject }),
        );
      },
      unsubscribe: async (ids: string[]) => {
        calls.push(`unsubscribe:${ids.join(",")}`);
      },
    },
  };
  onMount(() => {
    if (!customElements.get("rtk-screenshare-view"))
      customElements.define(
        "rtk-screenshare-view",
        class extends HTMLElement {
          connectedCallback() {
            this.textContent = "Remote screen video";
          }
        },
      );
    (window as any).__shareFixture = {
      calls,
      pending,
      stop: (id: string) => {
        const p = peers.get(id);
        p.screenShareEnabled = false;
        emitter("joined").emit("participantsUpdate");
      },
      leave: (id: string) => {
        joined.delete(id);
        emitter("joined").emit("participantLeft", peers.get(id));
      },
      track: (id: string) => {
        peers.get(id).screenShareTracks.video = {};
        emitter("joined").emit("participantsUpdate");
      },
      resolve: (id: string) =>
        pending.find((entry) => entry.ids.includes(id))?.resolve(),
      reject: (id: string) =>
        pending.find((entry) => entry.ids.includes(id))?.reject(),
      dispose: async () => {
        const { unmount } = await import("svelte");
        await unmount((window as any).__mountedShares);
      },
    };
    fixtureReady = true;
  });
  export function getMeeting() {
    return meeting;
  }
</script>

<svelte:head><title>Screen share fixture</title></svelte:head>
<main class="p-4" data-testid="share-fixture-ready" data-ready={fixtureReady}>
  <ConcurrentScreenShares {meeting} />
</main>
