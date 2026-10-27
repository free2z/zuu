<script lang="ts">
  import type {
    Command as CommandPrimitive,
    Dialog as DialogPrimitive,
  } from "bits-ui";
  import type { Snippet } from "svelte";
  import Command from "./command.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import type { WithoutChildrenOrChild } from "$lib/utils.js";
  import { tStore as t } from "$lib/i18n";

  let {
    open = $bindable(false),
    ref = $bindable(null),
    value = $bindable(""),
    title = $t("commandPalette.title", "Command Palette"),
    description = $t(
      "commandPalette.description",
      "Search for a command to run",
    ),
    portalProps,
    onOpenAutoFocus,
    children,
    ...restProps
  }: WithoutChildrenOrChild<DialogPrimitive.RootProps> &
    WithoutChildrenOrChild<CommandPrimitive.RootProps> & {
      portalProps?: DialogPrimitive.PortalProps;
      children: Snippet;
      title?: string;
      description?: string;
      /**
       * Forwarded to the dialog content's focus scope. `restProps` is spread
       * onto `Dialog.Root` and `Command`, neither of which owns the focus
       * scope, so this has to be threaded through explicitly. Calling
       * `preventDefault()` on the event cancels bits-ui's own
       * `requestAnimationFrame` focus pass, which is the only way to be the
       * single focus authority for the palette.
       */
      onOpenAutoFocus?: DialogPrimitive.ContentProps["onOpenAutoFocus"];
    } = $props();
</script>

<Dialog.Root bind:open {...restProps}>
  <Dialog.Header class="sr-only">
    <Dialog.Title>{title}</Dialog.Title>
    <Dialog.Description>{description}</Dialog.Description>
  </Dialog.Header>
  <Dialog.Content class="overflow-hidden p-0" {portalProps} {onOpenAutoFocus}>
    <Command
      class="**:data-[slot=command-input-wrapper]:h-12 [&_[data-command-group]]:px-2 [&_[data-command-group]:not([hidden])_~[data-command-group]]:pt-0 [&_[data-command-input-wrapper]_svg]:h-5 [&_[data-command-input-wrapper]_svg]:w-5 [&_[data-command-input]]:h-12 [&_[data-command-item]]:px-2 [&_[data-command-item]]:py-3 [&_[data-command-item]_svg]:h-5 [&_[data-command-item]_svg]:w-5"
      {...restProps}
      bind:value
      bind:ref
      {children}
    />
  </Dialog.Content>
</Dialog.Root>
