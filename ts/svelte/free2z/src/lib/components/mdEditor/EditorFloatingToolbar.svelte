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
  import { tStore as t } from "$lib/i18n";
  import {
    editorShortcuts,
    getShortcutLabel,
    type PlatformShortcut,
  } from "./shortcuts";

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
    // Converse turns this off: a short post has no headings, and the action
    // REPLACES the selection with "# " (codex review of ).
    showHeading = true,
  } = $props();

  const toolbarLabels = $derived.by(() => ({
    bold: $t("editor.commandNames.bold", "Bold"),
    italic: $t("editor.commandNames.italic", "Italic"),
    strikethrough: $t("editor.commandNames.strikethrough", "Strikethrough"),
    heading: $t("editor.commandNames.heading", "Heading"),
    bulletList: $t("editor.commandNames.bulletList", "Bullet list"),
    numberedList: $t("editor.commandNames.numberedList", "Numbered list"),
    quote: $t("editor.commandNames.quote", "Quote"),
    link: $t("editor.commandNames.link", "Link"),
    code: $t("editor.commandNames.code", "Code"),
  }));

  function actionWithShortcut(action: string, shortcut: PlatformShortcut) {
    return $t("editor.toolbar.actionWithShortcut", "{action} ({shortcut})", {
      action,
      shortcut: getShortcutLabel(shortcut, isMac),
    });
  }
</script>

{#if show}
  <div
    onpointerdown={(e) => e.preventDefault()}
    class="fixed z-[100] flex max-w-[100vw] -translate-x-1/2 animate-in items-center gap-1 overflow-x-auto rounded-md border bg-popover p-1 shadow-md duration-200 zoom-in-95 fade-in"
    style="top: {position.top}px; left: {position.left}px;"
  >
    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyBold ?? (() => wrapSelection("**"))}
      title={actionWithShortcut(toolbarLabels.bold, editorShortcuts.bold)}
      aria-label={toolbarLabels.bold}
      class="h-8 w-8 p-0"
    >
      <Bold class="h-4 w-4" />
    </Button>

    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyItalic ?? (() => wrapSelection("*"))}
      title={actionWithShortcut(toolbarLabels.italic, editorShortcuts.italic)}
      aria-label={toolbarLabels.italic}
      class="h-8 w-8 p-0"
    >
      <Italic class="h-4 w-4" />
    </Button>

    <Button
      variant="ghost"
      size="sm"
      onclick={() => wrapSelection("~~")}
      title={toolbarLabels.strikethrough}
      aria-label={toolbarLabels.strikethrough}
      class="h-8 w-8 p-0"
    >
      <Strikethrough class="h-4 w-4" />
    </Button>

    <div class="mx-1 h-5 w-px shrink-0 bg-border"></div>

    {#if showHeading}
      <Button
        variant="ghost"
        size="sm"
        onclick={() => insertAtCursor("# ")}
        title={toolbarLabels.heading}
        aria-label={toolbarLabels.heading}
        class="h-8 w-8 p-0"
      >
        <Heading2 class="h-4 w-4" />
      </Button>
    {/if}

    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyBulletList ?? (() => insertAtCursor("- "))}
      title={actionWithShortcut(
        toolbarLabels.bulletList,
        editorShortcuts.bulletList,
      )}
      aria-label={toolbarLabels.bulletList}
      class="h-8 w-8 p-0"
    >
      <List class="h-4 w-4" />
    </Button>

    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyOrderedList ?? (() => insertAtCursor("1. "))}
      title={actionWithShortcut(
        toolbarLabels.numberedList,
        editorShortcuts.orderedList,
      )}
      aria-label={toolbarLabels.numberedList}
      class="h-8 w-8 p-0"
    >
      <ListOrdered class="h-4 w-4" />
    </Button>

    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyQuote ?? (() => wrapSelection("> "))}
      title={actionWithShortcut(toolbarLabels.quote, editorShortcuts.quote)}
      aria-label={toolbarLabels.quote}
      class="h-8 w-8 p-0"
    >
      <Quote class="h-4 w-4" />
    </Button>

    <div class="mx-1 h-5 w-px shrink-0 bg-border"></div>

    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyLink ?? (() => wrapSelection("[", "](url)"))}
      title={actionWithShortcut(toolbarLabels.link, editorShortcuts.link)}
      aria-label={toolbarLabels.link}
      class="h-8 w-8 p-0"
    >
      <Link2 class="h-4 w-4" />
    </Button>

    <Button
      variant="ghost"
      size="sm"
      onclick={onApplyCode ?? (() => wrapSelection("`"))}
      title={actionWithShortcut(toolbarLabels.code, editorShortcuts.code)}
      aria-label={toolbarLabels.code}
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
