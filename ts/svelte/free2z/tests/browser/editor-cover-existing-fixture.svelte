<script lang="ts">
  import EditorCoverField from "$lib/components/mdEditor/EditorCoverField.svelte";

  let coverImage = $state(
    "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
  );
  let coverImageId = $state<number | null>(1);
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
