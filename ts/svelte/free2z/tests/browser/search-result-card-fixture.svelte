<script lang="ts">
  import SearchResultCard from "$lib/components/SearchResultCard.svelte";
</script>

<main>
  <SearchResultCard
    article={{
      get_url: "/zpage/cursor-article/",
      title: "Cursor fixture article",
      content: "A search result for interaction coverage.",
      tags: ["cursor-tag"],
      created_at: "2026-08-30T12:00:00Z",
      updated_at: "2026-08-30T12:00:00Z",
      creator: { username: "cursor-author" },
    }}
  />
</main>
