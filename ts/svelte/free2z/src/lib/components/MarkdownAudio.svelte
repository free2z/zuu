<script lang="ts">
  import AudioVisualizer from "$lib/components/stream/AudioVisualizer.svelte";

  export let src: string;

  let audioElement: HTMLAudioElement;
  let hasStarted = false;
</script>

<div class="markdown-audio">
  {#if hasStarted && audioElement}
    <div class="markdown-audio-visualizer" aria-hidden="true">
      <AudioVisualizer {audioElement} />
    </div>
  {/if}
  <audio
    bind:this={audioElement}
    {src}
    controls
    crossorigin="anonymous"
    preload="metadata"
    onplay={() => (hasStarted = true)}
  >
    <a href={src}>Open the audio file</a>
  </audio>
</div>

<style>
  .markdown-audio {
    display: flex;
    width: min(100%, 42rem);
    flex-direction: column;
    gap: 0.5rem;
    margin: 1.5rem auto;
  }

  .markdown-audio-visualizer {
    height: 9rem;
    overflow: hidden;
    border-radius: 0.65rem;
  }

  audio {
    width: 100%;
  }
</style>
