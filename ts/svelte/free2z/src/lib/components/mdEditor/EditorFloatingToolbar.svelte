<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import {
    Bold,
    Italic,
    Heading2,
    List,
    ListOrdered,
    Link2,
    Quote,
    Code,
    Sigma,
    Strikethrough,
  } from "@lucide/svelte";
  import { editorShortcuts, getShortcutLabel } from "./shortcuts";

  let {
    wrapSelection,
    insertAtCursor,
    onApplyBold,
    onApplyItalic,
    onApplyLink,
    onApplyCode,
    onApplyBulletList,
    onApplyOrderedList,
    onApplyQuote,
    position,
    show,
    isMac = false,
  } = $props();
</script>

{#if show}
  <div
    onpointerdown={(e) => e.preventDefault()}
    class="fixed z-[100] flex -translate-x-1/2 animate-in items-center gap-1 rounded-md border bg-popover p-1 shadow-md duration-200 zoom-in-95 fade-in"
    style="top: {position.top}px; left: {position.left}px;"
  >
    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyBold ?? (() => wrapSelection("**"))}
      title={`Bold (${getShortcutLabel(editorShortcuts.bold, isMac)})`}
      class="h-8 w-8 p-0"
    >
      <Bold class="h-4 w-4" />
    </Button>

    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyItalic ?? (() => wrapSelection("*"))}
      title={`Italic (${getShortcutLabel(editorShortcuts.italic, isMac)})`}
      class="h-8 w-8 p-0"
    >
      <Italic class="h-4 w-4" />
    </Button>

    <Button
      variant="ghost"
      size="sm"
      onclick={() => wrapSelection("~~")}
      title="Strikethrough"
      class="h-8 w-8 p-0"
    >
      <Strikethrough class="h-4 w-4" />
    </Button>

    <div class="mx-1 h-5 w-px bg-border"></div>

    <Button
      variant="ghost"
      size="sm"
      onclick={() => insertAtCursor("# ")}
      title="Heading"
      class="h-8 w-8 p-0"
    >
      <Heading2 class="h-4 w-4" />
    </Button>

    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyBulletList ?? (() => insertAtCursor("- "))}
      title={`Bullet List (${getShortcutLabel(editorShortcuts.bulletList, isMac)})`}
      class="h-8 w-8 p-0"
    >
      <List class="h-4 w-4" />
    </Button>

    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyOrderedList ?? (() => insertAtCursor("1. "))}
      title={`Numbered List (${getShortcutLabel(editorShortcuts.orderedList, isMac)})`}
      class="h-8 w-8 p-0"
    >
      <ListOrdered class="h-4 w-4" />
    </Button>

    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyQuote ?? (() => wrapSelection("> "))}
      title={`Quote (${getShortcutLabel(editorShortcuts.quote, isMac)})`}
      class="h-8 w-8 p-0"
    >
      <Quote class="h-4 w-4" />
    </Button>

    <div class="mx-1 h-5 w-px bg-border"></div>

    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyLink ?? (() => wrapSelection("[", "](url)"))}
      title={`Link (${getShortcutLabel(editorShortcuts.link, isMac)})`}
      class="h-8 w-8 p-0"
    >
      <Link2 class="h-4 w-4" />
    </Button>

    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyCode ?? (() => wrapSelection("`"))}
      title={`Code (${getShortcutLabel(editorShortcuts.code, isMac)})`}
      class="h-8 w-8 p-0"
    >
      <Code class="h-4 w-4" />
    </Button>

    <Button
      variant="ghost"
      size="sm"
      onclick={() => wrapSelection("$$")}
      title="Inline Math ($$…$$)"
      class="h-8 w-8 p-0"
    >
      <Sigma class="h-4 w-4" />
    </Button>
  </div>
{/if}
