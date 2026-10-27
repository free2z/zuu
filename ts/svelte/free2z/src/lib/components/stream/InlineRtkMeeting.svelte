<script lang="ts">
  import type RealtimeKitClient from "@cloudflare/realtimekit";
  import type { RtkI18n } from "@cloudflare/realtimekit-ui";

  export let meeting: RealtimeKitClient;
  export let translator: RtkI18n;
</script>

<!-- @ts-ignore - Web Component -->
<rtk-meeting
  mode="fill"
  {meeting}
  t={translator}
  show-setup-screen={false}
  class="rtk-meeting-host h-full min-h-0 w-full min-w-0 overflow-hidden"
></rtk-meeting>

<style>
  /* RealtimeKit lays out its stage/video in a shadow tree relative to this
     host. Both axes must be definite, and the host must remain shrinkable in
     the viewer's nested flex chain. */
  .rtk-meeting-host {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
</style>
