<script lang="ts">
  import * as Carousel from "$lib/components/ui/carousel/index.js";
</script>

<div class="mx-auto mt-12 w-[calc(100vw-8rem)] max-w-[800px]">
  <Carousel.Root opts={{ align: "start" }}>
    <Carousel.Content>
      {#each [1, 2, 3] as slide}
        <Carousel.Item class="basis-[200px]">
          <div class="h-24 border p-4">Slide {slide}</div>
        </Carousel.Item>
      {/each}
    </Carousel.Content>
    <Carousel.Previous data-testid="resize-previous" />
    <Carousel.Next data-testid="resize-next" />
  </Carousel.Root>
</div>
