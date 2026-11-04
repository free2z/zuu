<script lang="ts">
  import EditorCoverField from "$lib/components/mdEditor/EditorCoverField.svelte";

  let coverImage = $state("");
  let coverImageId = $state<number | null>(null);
  let showCover = $state(true);
</script>

<main>
  <EditorCoverField
    title="Cursor fixture"
    bind:coverImage
    bind:coverImageId
    bind:showCover
  />
</main>
