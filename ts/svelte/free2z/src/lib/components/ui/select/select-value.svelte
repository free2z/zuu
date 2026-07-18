<script lang="ts">
  import { Select as SelectPrimitive } from 'bits-ui';

  // Minimal passthrough wrapper for primitive Value - preserves slot API.
  // Render legacy `childrenProp` function or the default slot as fallback.
  let rest = $props() as any;
  const renderChildren = () =>
    rest.childrenProp?.() || (rest as any)?.children?.();

  const Value = (SelectPrimitive as any).Value;
</script>

{#if Value}
  <svelte:component this={Value} {...rest}>
    {@render renderChildren()}
  </svelte:component>
{:else}
  <!-- Fallback: render slot directly when primitive doesn't expose Value -->
  {@render renderChildren()}
{/if}
