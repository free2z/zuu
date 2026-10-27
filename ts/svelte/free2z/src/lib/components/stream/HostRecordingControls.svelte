<script lang="ts">
  import { apiFetch } from "$lib/api/config";
  import type { RecordingStatus } from "$lib/utils/recording-controls";
  import { tStore as t } from "$lib/i18n";
  import { Button } from "$lib/components/ui/button";
  import {
    recordingControls,
    type RecordingView,
  } from "$lib/utils/recording-controls";
  import {
    dyteRecordingRetrieve,
    dyteRecordingCreate,
    dyteRecordingStopCreate,
  } from "$lib/api/dyte/dyte";
  let {
    username,
    hostSession = "",
    privateSecret,
  }: {
    username: string;
    hostSession?: string;
    privateSecret?: string;
  } = $props();
  let view = $state<RecordingView>({ state: null, busy: true, error: false });
  let controls: ReturnType<typeof recordingControls> | undefined;
  $effect(() => {
    const owner = username;
    const session = { host_session: hostSession };
    const secret = privateSecret;
    const handle = recordingControls(
      async (action, signal) => {
        if (secret) {
          const path = `/api/dyte/${encodeURIComponent(owner)}/private/${encodeURIComponent(secret)}/recording${action === "stop" ? "/stop" : ""}`;
          const response = await apiFetch(path, {
            method: action === "status" ? "GET" : "POST",
            signal,
            timeoutMs: null,
          });
          if (!response.ok) throw new Error("Private recording request failed");
          const result = (await response.json()) as {
            recording_state: RecordingStatus;
          };
          return { state: result.recording_state };
        }
        const result =
          action === "status"
            ? await dyteRecordingRetrieve(
                owner,
                session,
                { timeoutMs: null },
                signal,
              )
            : action === "start"
              ? await dyteRecordingCreate(
                  owner,
                  session,
                  { timeoutMs: null },
                  signal,
                )
              : await dyteRecordingStopCreate(
                  owner,
                  session,
                  { timeoutMs: null },
                  signal,
                );
        return { state: result.recording_state };
      },
      (next) => {
        view = next;
      },
    );
    controls = handle;
    return () => {
      handle.stop();
    };
  });
  let delayed = $state(false);
  let recordingState = $derived(view.state);
  $effect(() => {
    delayed = false;
    if (recordingState !== "INVOKED") return;
    const timer = setTimeout(() => {
      delayed = true;
    }, 30_000);
    return () => clearTimeout(timer);
  });
  const messages: Record<string, [string, string]> = {
    INVOKED: ["starting", "Recording is starting"],
    RECORDING: ["active", "Recording"],
    PAUSED: ["paused", "Recording is paused"],
    STOPPING: ["stopping", "Stopping recording"],
    UPLOADING: ["uploading", "Recording is uploading"],
    UPLOADED: ["uploaded", "Recording captured. Processing for your uploads."],
    FAILED: ["failed", "Recording failed. No saved recording is confirmed."],
    ERRORED: ["failed", "Recording failed. No saved recording is confirmed."],
  };
  let canStop = $derived(
    view.state === "INVOKED" ||
      view.state === "RECORDING" ||
      view.state === "PAUSED",
  );
  let canStart = $derived(
    ["IDLE", "UPLOADED", "FAILED", "ERRORED"].includes(view.state ?? ""),
  );
</script>

<div class="flex min-w-0 flex-wrap items-center gap-2 text-sm text-white">
  {#if delayed}
    <span role="alert"
      >{$t(
        "dashboard.stream.recordingControls.delayed",
        "Recording has not started. Stop this attempt before trying again.",
      )}</span
    >
  {/if}
  {#if view.error}
    <span role="alert"
      >{$t(
        "dashboard.stream.recordingControls.error",
        "Recording status could not be confirmed. Check again before starting another recording.",
      )}</span
    >
    <Button
      size="sm"
      variant="secondary"
      disabled={view.busy}
      onclick={() => controls?.run("status")}
      >{$t("dashboard.stream.recordingControls.retry", "Check status")}</Button
    >
  {:else}
    {#if view.state && messages[view.state]}
      <span aria-live="polite"
        >{$t(
          `dashboard.stream.recordingControls.${messages[view.state][0]}`,
          messages[view.state][1],
        )}</span
      >
    {/if}
    {#if canStop}
      <Button
        size="sm"
        variant="destructive"
        disabled={view.busy}
        onclick={() => controls?.run("stop")}
        >{$t(
          "dashboard.stream.recordingControls.stop",
          "Stop recording",
        )}</Button
      >
    {:else if canStart}
      <Button
        size="sm"
        variant="secondary"
        disabled={view.busy}
        onclick={() => controls?.run("start")}
        >{$t(
          "dashboard.stream.recordingControls.start",
          "Record livestream",
        )}</Button
      >
    {:else if !view.state}
      <span
        >{$t(
          "dashboard.stream.recordingControls.checking",
          "Checking recording status…",
        )}</span
      >
    {/if}
  {/if}
</div>
