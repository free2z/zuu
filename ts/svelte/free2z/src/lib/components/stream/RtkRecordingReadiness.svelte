<script lang="ts">
  import { tStore as t } from "$lib/i18n";
  import {
    watchRecordingReadiness,
    type RecordingLike,
  } from "$lib/utils/rtk-recording-readiness";

  let { meeting }: { meeting: unknown } = $props();
  let delayed = $state(false);

  $effect(() => {
    delayed = false;
    const current = meeting as { recording: RecordingLike } | null;
    if (!current) return;
    return watchRecordingReadiness(
      current.recording,
      (next) => {
        delayed = next;
      },
      document,
    );
  });
</script>

{#if delayed}
  <div
    role="alert"
    class="absolute inset-x-3 top-16 z-40 rounded-lg border border-amber-400/50 bg-amber-950 p-3 text-sm text-amber-50 shadow-lg sm:inset-x-6"
  >
    {$t(
      "dashboard.stream.recordingStartDelayed",
      "Recording has not been confirmed. Do not rely on a recording being saved.",
    )}
  </div>
{/if}
