<script lang="ts">
  import {
    type CarouselAPI,
    type CarouselProps,
    type EmblaContext,
    setEmblaContext,
  } from "./context.js";
  import { cn, type WithElementRef } from "$lib/utils.js";
  import { tStore as t } from "$lib/i18n";

  // Keep a runtime fallback for legacy `childrenProp` and accept loose prop typing.
  let {
    ref = $bindable<HTMLElement | null>(null),
    opts = {},
    plugins = [],
    setApi = () => {},
    orientation = "horizontal",
    class: className,
    childrenProp,
    ...restProps
  } = $props() as unknown as Record<string, any>;

  const renderChildren = $derived(childrenProp ?? restProps.children);

  let carouselState = $state<EmblaContext>({
    api: undefined,
    scrollPrev,
    scrollNext,
    orientation,
    canScrollNext: false,
    canScrollPrev: false,
    handleKeyDown,
    options: opts,
    plugins,
    onInit,
    scrollSnaps: [],
    selectedIndex: 0,
    scrollTo,
  });

  setEmblaContext(carouselState);

  function scrollPrev() {
    carouselState.api?.scrollPrev();
  }

  function scrollNext() {
    carouselState.api?.scrollNext();
  }

  function scrollTo(index: number, jump?: boolean) {
    carouselState.api?.scrollTo(index, jump);
  }

  function onSelect() {
    if (!carouselState.api) return;
    carouselState.selectedIndex = carouselState.api.selectedScrollSnap();
    carouselState.canScrollNext = carouselState.api.canScrollNext();
    carouselState.canScrollPrev = carouselState.api.canScrollPrev();
  }

  function onReInit() {
    carouselState.scrollSnaps = carouselState.api?.scrollSnapList() ?? [];
    onSelect();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      scrollPrev();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      scrollNext();
    }
  }

  function onInit(event: CustomEvent<CarouselAPI>) {
    carouselState.api = event.detail;
    setApi(carouselState.api);

    carouselState.api.on("select", onSelect);
    carouselState.api.on("reInit", onReInit);
    onReInit();
  }

  $effect(() => {
    return () => {
      carouselState.api?.off("select", onSelect);
      carouselState.api?.off("reInit", onReInit);
    };
  });
</script>

<div
  bind:this={ref}
  data-slot="carousel"
  class={cn("relative", className)}
  role="region"
  aria-roledescription={$t("carousel.label", "carousel")}
  {...restProps}
>
  {@render renderChildren?.()}
</div>
