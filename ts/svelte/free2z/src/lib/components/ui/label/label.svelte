<script lang="ts">
  import { Label as LabelPrimitive } from 'bits-ui';
  import { cn } from '$lib/utils';
  export let className: string = '';
  export let forId: string | undefined = undefined;
</script>

<LabelPrimitive.Root
  class={cn(
    'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
    className
  )}
  for={forId}
  {...$$restProps}
>
  <slot />
</LabelPrimitive.Root>
