<script lang="ts">
  import { meetingStore } from "$lib/stores/liveStreamStore";
  import RtkAudioHealth from "$lib/components/stream/RtkAudioHealth.svelte";

  export let onReconnect = () => {};
  $: meeting = $meetingStore;
</script>

<RtkAudioHealth {meeting} mode="host" {onReconnect} />
