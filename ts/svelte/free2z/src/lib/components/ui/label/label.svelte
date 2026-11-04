<script lang="ts">
  import { onMount } from "svelte";
  import { Label as LabelPrimitive } from "bits-ui";
  import { cn } from "$lib/utils";
  export let className: string = "";
  export let forId: string | undefined = undefined;
  /** Use for labels associated with checkbox, radio, switch, or file controls. */
  export let control: boolean = false;
  let root: HTMLLabelElement | null = null;

  onMount(() => {
    if (!control) return;
    // Use this label's native association, including labelable custom buttons.
    // Native label activation already clicks those buttons exactly once.
    const sync = () => {
      if (!root) return;
      const target = root.control;
      const choice =
        target instanceof HTMLInputElement
          ? ["checkbox", "radio", "file"].includes(target.type)
          : target?.matches(
              '[role="checkbox"], [role="radio"], [role="switch"]',
            );
      const enabled = String(
        control &&
          !!choice &&
          !target?.matches(
            ":disabled, [aria-disabled='true'], [data-disabled]",
          ),
      );
      if (root.dataset.associatedControlEnabled !== enabled) {
        root.dataset.associatedControlEnabled = enabled;
      }
    };
    // Associations can change when targets are inserted, removed, renamed, or
    // disabled (including through a fieldset). Ignore our own data attribute.
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "id",
        "for",
        "disabled",
        "aria-disabled",
        "data-disabled",
        "role",
        "type",
      ],
    });
    queueMicrotask(sync);
    return () => observer.disconnect();
  });
</script>

<LabelPrimitive.Root
  bind:ref={root}
  class={cn(
    "text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
    className,
  )}
  onclick={(event: MouseEvent) => {
    if (
      control &&
      root?.control?.matches(
        ":disabled, [aria-disabled='true'], [data-disabled]",
      )
    ) {
      event.preventDefault();
    }
  }}
  for={forId}
  {...$$restProps}
>
  <slot />
</LabelPrimitive.Root>
