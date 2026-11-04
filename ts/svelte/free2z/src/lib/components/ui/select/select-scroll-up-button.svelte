<script lang="ts">
  import ChevronUpIcon from "@lucide/svelte/icons/chevron-up";
  import { Select as SelectPrimitive } from "bits-ui";
  import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

  let {
    ref = $bindable(null),
    class: className,
    ...restProps
  }: WithoutChildrenOrChild<SelectPrimitive.ScrollUpButtonProps> = $props();
</script>

<SelectPrimitive.ScrollUpButton
  bind:ref
  data-slot="select-scroll-up-button"
  class={cn(
    "flex items-center justify-center py-1 data-[disabled]:cursor-default",
    className,
  )}
  {...restProps}
>
  <ChevronUpIcon class="size-4" />
</SelectPrimitive.ScrollUpButton>
