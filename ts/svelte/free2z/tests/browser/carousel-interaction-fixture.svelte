<script lang="ts">
  import * as Carousel from "$lib/components/ui/carousel/index.js";
  import {
    setEmblaContext,
    type EmblaContext,
  } from "$lib/components/ui/carousel/context.js";

  setEmblaContext({
    api: undefined,
    orientation: "horizontal",
    scrollNext: () => {
      document.body.dataset.carouselActivations = String(
        Number(document.body.dataset.carouselActivations ?? 0) + 1,
      );
    },
    scrollPrev: () => {},
    canScrollNext: true,
    canScrollPrev: false,
    handleKeyDown: (_event: KeyboardEvent) => {},
    options: {},
    plugins: [],
    onInit: (_event: CustomEvent) => {},
    scrollTo: (_index: number) => {},
    scrollSnaps: [],
    selectedIndex: 0,
  } as EmblaContext);
</script>

<main>
  <Carousel.Next disabled data-testid="carousel-next-caller-disabled" />
  <Carousel.Next data-testid="carousel-next-enabled" />
</main>
