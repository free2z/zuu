<script lang="ts">
  import { Select as SelectPrimitive } from 'bits-ui';

  // Keep things permissive for now; accept any props and make `selected` bindable.
  // Support legacy `childrenProp` function and the standard default slot.
  let { selected = $bindable(), childrenProp, ...rest } = $props() as any;
  const renderChildren = () => childrenProp?.() || (rest as any)?.children?.();

  // Reference the primitive part in the instance script so the template can
  // access it when using `<svelte:component this={...}>`.
  const Root = (SelectPrimitive as any).Root;
</script>

{#if Root}
  <svelte:component
    this={Root}
    {...rest}
    on:selected={(e: any) => (selected = e.detail)}
  >
    {@render renderChildren()}
  </svelte:component>
{:else}
  {@render renderChildren()}
{/if}
