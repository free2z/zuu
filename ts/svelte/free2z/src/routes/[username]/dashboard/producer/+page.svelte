<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { mountProducer } from "$lib/producer/panel";
  import { ProducerFailure } from "$lib/producer/client";
  import { producerLabelKeys } from "$lib/producer/labels";
  import { customInstance, ApiError } from "$lib/api/mutator";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { tStore } from "$lib/i18n";
  export let data: { username: string };
  let root: HTMLDivElement;
  onMount(() => {
    let stop = () => {};
    let currentActor: number | null = null;
    const unsubscribe = currentUser.subscribe((user) => {
      if (
        currentActor &&
        (user?.id !== currentActor || user.username !== data.username)
      ) {
        stop();
        currentActor = null;
      }
      const actor = user?.username === data.username ? user.id : null;
      if (!actor || currentActor) return;
      currentActor = actor;
      stop = mountProducer(root, {
        actor,
        labels: Object.fromEntries(
          producerLabelKeys.map((key) => [key, get(tStore)(`producer.${key}`)]),
        ),
        current: () => get(currentUser)?.id === actor,
        transport: async (method, path, body) => {
          try {
            return await customInstance(
              { url: path, method, data: body },
              { timeoutMs: 45000 },
            );
          } catch (e) {
            if (e instanceof ApiError)
              throw new ProducerFailure(
                e.data?.code ?? "request_refused",
                e.data,
              );
            throw e;
          }
        },
        connect: async (authToken) => {
          const { default: RealtimeKitClient } =
            await import("@cloudflare/realtimekit");
          const m = await RealtimeKitClient.init({
            authToken,
            defaults: { audio: false, video: false },
          });
          return {
            join: () => m.join(),
            leave: () => m.leave(),
            audio: (on) => (on ? m.self.enableAudio() : m.self.disableAudio()),
            video: (on) => (on ? m.self.enableVideo() : m.self.disableVideo()),
            device: (d) => m.self.setDevice(d),
            preview: (el) => m.self.registerVideoElement(el),
            media: () => ({
              audio: m.self.audioEnabled,
              video: m.self.videoEnabled,
            }),
            onMedia: (callback) => {
              m.self.on("audioUpdate", callback);
              m.self.on("videoUpdate", callback);
              return () => {
                m.self.off("audioUpdate", callback);
                m.self.off("videoUpdate", callback);
              };
            },
            onLeft: (callback) => {
              m.self.on("roomLeft", callback);
              return () => m.self.off("roomLeft", callback);
            },
          };
        },
      });
    });
    void authStore.checkAuth({ silent: true });
    return () => {
      unsubscribe();
      stop();
    };
  });
</script>

<div class="p-4 sm:p-6" bind:this={root}></div>
