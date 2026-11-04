<script lang="ts">
  import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
  import type { WithoutChildren } from "bits-ui";
  import { getEmblaContext } from "./context.js";
  import { cn } from "$lib/utils.js";
  import { Button, type Props } from "$lib/components/ui/button/index.js";
  import { tStore as t } from "$lib/i18n";

  let {
    ref = $bindable(null),
    class: className,
    variant = "outline",
    size = "icon",
    disabled: callerDisabled = false,
    onclick: callerOnclick,
    onkeydown: callerOnkeydown,
    ...restProps
  } = $props() as any;

  const emblaCtx = getEmblaContext("<Carousel.Next/>");
  const unavailable = $derived(!emblaCtx.canScrollNext || callerDisabled);

  function handleButtonEvent(event: MouseEvent | KeyboardEvent) {
    if (event.type === "click") {
      if (unavailable) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      callerOnclick?.(event as MouseEvent);
      if (event.defaultPrevented || event.cancelBubble) return;
      emblaCtx.scrollNext();
      return;
    }

    const keyEvent = event as KeyboardEvent;
    const requestedDirectionAvailable =
      keyEvent.key === "ArrowLeft"
        ? emblaCtx.canScrollPrev
        : keyEvent.key === "ArrowRight"
          ? emblaCtx.canScrollNext
          : true;
    if (callerDisabled || !requestedDirectionAvailable) {
      if (
        callerDisabled ||
        keyEvent.key === "ArrowLeft" ||
        keyEvent.key === "ArrowRight"
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    callerOnkeydown?.(keyEvent);
    if (event.defaultPrevented || event.cancelBubble) return;
    emblaCtx.handleKeyDown(keyEvent);
  }

  $effect(() => {
    const button = ref as HTMLButtonElement | null;
    if (!button) return;
    button.addEventListener("click", handleButtonEvent, true);
    button.addEventListener("keydown", handleButtonEvent, true);
    return () => {
      button.removeEventListener("click", handleButtonEvent, true);
      button.removeEventListener("keydown", handleButtonEvent, true);
    };
  });
</script>

<Button
  data-slot="carousel-next"
  {variant}
  {size}
  class={cn(
    "absolute size-8 rounded-full",
    emblaCtx.orientation === "horizontal"
      ? "top-1/2 -right-12 -translate-y-1/2"
      : "-bottom-12 left-1/2 -translate-x-1/2 rotate-90",
    className,
  )}
  bind:ref
  {...restProps}
  disabled={callerDisabled}
  aria-disabled={unavailable}
>
  <ArrowRightIcon class="size-4" />
  <span class="sr-only">{$t("carousel.next", "Next slide")}</span>
</Button>
