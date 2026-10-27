<script lang="ts">
  import * as Carousel from "$lib/components/ui/carousel/index.js";
  import {
    setEmblaContext,
    type EmblaContext,
  } from "$lib/components/ui/carousel/context.js";

  setEmblaContext({
    api: undefined,
    orientation: "horizontal",
    scrollNext: () => {},
    scrollPrev: () => {
      document.body.dataset.carouselScrollPrevious = String(
        Number(document.body.dataset.carouselScrollPrevious ?? 0) + 1,
      );
    },
    canScrollNext: false,
    canScrollPrev: true,
    handleKeyDown: (event: KeyboardEvent) => {
      document.body.dataset.carouselKeyboardHandlerSawStoppedPropagation =
        String(event.cancelBubble);
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        document.body.dataset.carouselKeyboardPrevious = String(
          Number(document.body.dataset.carouselKeyboardPrevious ?? 0) + 1,
        );
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        document.body.dataset.carouselKeyboardNext = String(
          Number(document.body.dataset.carouselKeyboardNext ?? 0) + 1,
        );
      }
    },
    options: {},
    plugins: [],
    onInit: (_event: CustomEvent) => {},
    scrollTo: (_index: number) => {},
    scrollSnaps: [],
    selectedIndex: 0,
  } as EmblaContext);

  function recordNextClick() {
    document.body.dataset.callerNextClicks = String(
      Number(document.body.dataset.callerNextClicks ?? 0) + 1,
    );
    window.location.hash = "caller-next-clicked";
  }

  function recordNextKeydown() {
    document.body.dataset.callerNextKeydowns = String(
      Number(document.body.dataset.callerNextKeydowns ?? 0) + 1,
    );
  }

  function recordPreviousClick() {
    document.body.dataset.callerPreviousClicks = String(
      Number(document.body.dataset.callerPreviousClicks ?? 0) + 1,
    );
  }

  function recordPreviousKeydown(event: KeyboardEvent) {
    document.body.dataset.callerPreviousKeydowns = String(
      Number(document.body.dataset.callerPreviousKeydowns ?? 0) + 1,
    );
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
    }
  }
</script>

<main>
  <Carousel.Next
    disabled={false}
    onclick={recordNextClick}
    onkeydown={recordNextKeydown}
    data-testid="carousel-next-caller-enabled-at-edge"
  />
  <Carousel.Previous
    onclick={recordPreviousClick}
    onkeydown={recordPreviousKeydown}
    data-testid="carousel-previous-available-with-caller-handlers"
  />
  <span data-testid="carousel-edge-neighbor">End of slides</span>
</main>
