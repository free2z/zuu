<script lang="ts">
  import type RealtimeKitClient from "@cloudflare/realtimekit";
  import type { RtkI18n } from "@cloudflare/realtimekit-ui";
  import { onDestroy } from "svelte";
  import {
    createReactionController,
    REACTION_EVENT,
    REACTIONS,
    type Reaction,
    type ReactionEvent,
  } from "$lib/utils/meeting-reactions";

  export let meeting: RealtimeKitClient;
  export let translator: RtkI18n;
  const reactions = createReactionController();
  let visible = reactions.visible;
  let announcement = "";
  let status = "";
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const onReaction = (event: ReactionEvent) => {
    const item = reactions.receive(event);
    if (!item) return;
    visible = reactions.visible;
    announcement = `A participant reacted ${item.emoji}`;
    timers.set(
      item.id,
      setTimeout(() => {
        reactions.expire(item.id);
        timers.delete(item.id);
        visible = reactions.visible;
      }, 3000),
    );
  };
  meeting.participants.on("broadcastedMessage", onReaction);
  function send(emoji: Reaction) {
    const payload = reactions.makePayload(emoji);
    if (!payload) {
      status = "Please wait before sending another reaction.";
      return;
    }
    meeting.participants
      .broadcastMessage(REACTION_EVENT, payload)
      .then(() => {
        status = "Reaction sent.";
      })
      .catch(() => {
        status = "Reaction could not be sent.";
      });
  }
  onDestroy(() => {
    meeting.participants.off("broadcastedMessage", onReaction);
    for (const timer of timers.values()) clearTimeout(timer);
    reactions.clear();
  });
</script>

<div class="meeting-wrap">
  <!-- @ts-ignore - Web Component -->
  <rtk-meeting
    mode="fill"
    {meeting}
    t={translator}
    show-setup-screen={false}
    class="rtk-meeting-host h-full min-h-0 w-full min-w-0 overflow-hidden"
  ></rtk-meeting>
  <div class="reaction-ui" aria-label="Meeting reactions">
    <div class="reaction-buttons">
      {#each REACTIONS as emoji}
        <button
          type="button"
          aria-label={`Send ${emoji} reaction`}
          title={`Send ${emoji} reaction`}
          on:click={() => send(emoji)}>{emoji}</button
        >
      {/each}
    </div>
    <div class="reaction-floats" aria-hidden="true">
      {#each visible as item (item.id)}<span>{item.emoji}</span>{/each}
    </div>
    <span class="sr-only" aria-live="polite" aria-atomic="true"
      >{announcement}</span
    >
    <span class="sr-only" role="status">{status}</span>
  </div>
</div>

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
  .meeting-wrap {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    width: 100%;
    height: 100%;
  }
  .reaction-ui {
    position: absolute;
    right: 1rem;
    bottom: 1rem;
    z-index: 20;
  }
  .reaction-buttons {
    display: flex;
    gap: 0.375rem;
    padding: 0.375rem;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.72);
  }
  .reaction-buttons button {
    min-width: 2.75rem;
    min-height: 2.75rem;
    border-radius: 999px;
    font-size: 1.25rem;
    cursor: pointer;
  }
  .reaction-buttons button:focus-visible {
    outline: 3px solid white;
    outline-offset: 2px;
  }
  .reaction-floats {
    position: absolute;
    right: 0.5rem;
    bottom: 3.5rem;
    display: flex;
    gap: 0.25rem;
    font-size: 2rem;
  }
  .reaction-floats span {
    animation: reaction-rise 3s ease-out both;
  }
  @keyframes reaction-rise {
    from {
      opacity: 0;
      transform: translateY(1rem);
    }
    15% {
      opacity: 1;
    }
    to {
      opacity: 0;
      transform: translateY(-3rem);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .reaction-floats span {
      animation: none;
    }
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
