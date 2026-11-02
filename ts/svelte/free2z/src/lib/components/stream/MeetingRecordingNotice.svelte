<script lang="ts">
  import { tStore as t } from "$lib/i18n";
  import {
    watchMeetingRecordingNotice,
    type RecordingNotice,
    type RecordingNoticeMeeting,
  } from "$lib/utils/meeting-recording-notice";

  let { meeting }: { meeting: unknown } = $props();
  let notice = $state<RecordingNotice | null>(null);

  $effect(() => {
    notice = null;
    const current = meeting as RecordingNoticeMeeting | null;
    if (!current?.recording?.addListener) return;
    return watchMeetingRecordingNotice(current, (next) => {
      notice = next;
    });
  });
</script>

{#if notice}
  <div
    data-testid="meeting-recording-notice"
    data-emphasis={notice.emphasis}
    data-state={notice.state}
    data-on-stage={notice.onStage ? "true" : "false"}
    class="pointer-events-none absolute inset-x-0 z-40 flex justify-center {notice.emphasis ===
    'stage'
      ? 'top-0'
      : 'top-3 px-3'}"
  >
    <div
      role="status"
      aria-live="polite"
      class={notice.emphasis === "stage"
        ? "flex w-full items-center justify-center gap-2 bg-red-600 px-3 py-2 text-center text-sm leading-snug font-semibold text-white shadow-md"
        : "flex max-w-full items-center gap-2 rounded-full border border-red-300/50 bg-red-950/95 px-3 py-1.5 text-center text-sm leading-snug font-medium text-red-50 shadow-lg"}
    >
      <span
        class="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full {notice.emphasis ===
        'stage'
          ? 'bg-white'
          : 'bg-red-500'}"
        aria-hidden="true"
      ></span>
      <span>
        {#if notice.onStage && notice.state === "STARTING"}
          {$t(
            "dashboard.stream.recordingNotice.stageStarting",
            "You are on stage. Recording is starting.",
          )}
        {:else if notice.onStage && notice.state === "RECORDING"}
          {$t(
            "dashboard.stream.recordingNotice.stageRecording",
            "You are on stage and this meeting is being recorded.",
          )}
        {:else if notice.onStage && notice.state === "PAUSED"}
          {$t(
            "dashboard.stream.recordingNotice.stagePaused",
            "You are on stage. Recording is paused.",
          )}
        {:else if notice.state === "STARTING"}
          {$t(
            "dashboard.stream.recordingNotice.starting",
            "Recording is starting.",
          )}
        {:else if notice.state === "PAUSED"}
          {$t(
            "dashboard.stream.recordingNotice.paused",
            "Recording is paused.",
          )}
        {:else}
          {$t(
            "dashboard.stream.recordingNotice.recording",
            "This meeting is being recorded.",
          )}
        {/if}
      </span>
    </div>
  </div>
{/if}
