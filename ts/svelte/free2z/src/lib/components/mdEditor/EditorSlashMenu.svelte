<script lang="ts">
  import * as Kbd from "$lib/components/ui/kbd";
  import { getShortcutLabel } from "./shortcuts";
  import { getMenuPositionStyle } from "./menuPosition";

  let {
    slashMenuRef = $bindable(),
    slashMenuPosition,
    filteredCommands,
    selectedSlashCommand = $bindable(),
    insertSlashCommand,
    selectedCommandRefs = $bindable([]),
    isMac = false,
  } = $props();

  function getShortcutKeys(shortcut: { mac: string; windows: string }) {
    return getShortcutLabel(shortcut, isMac).split("+");
  }

  const positionStyle = $derived(getMenuPositionStyle(slashMenuPosition));
</script>

<div
  bind:this={slashMenuRef}
  onpointerdown={(event) => event.preventDefault()}
  class="fixed z-[100] flex max-h-[420px] w-[360px] animate-in flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md fade-in slide-in-from-bottom-2"
  style={positionStyle}
>
  <div
    class="flex shrink-0 items-center justify-between border-b bg-muted/50 px-3 py-2"
  >
    <span class="text-xs font-medium text-muted-foreground">Commands</span>
    <span class="font-mono text-[10px] text-muted-foreground opacity-70"
      >↑↓ Navigate · ↵ Select · Esc Close</span
    >
  </div>
  <div class="slash-menu-items max-h-[360px] overflow-y-auto p-1">
    {#each filteredCommands as command, index}
      {@const Icon = command.icon}
      {@const isSelected = index === selectedSlashCommand}
      <button
        bind:this={selectedCommandRefs[index]}
        type="button"
        class="group relative flex w-full cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-sm transition-colors outline-none {isSelected
          ? 'bg-primary text-primary-foreground'
          : 'hover:bg-primary/8'}"
        onclick={() => insertSlashCommand(command)}
        onmouseenter={() => (selectedSlashCommand = index)}
      >
        <div
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border bg-background text-muted-foreground shadow-sm transition-colors {isSelected
            ? 'border-border/80 bg-background text-foreground'
            : 'group-hover:text-foreground/80'}"
        >
          <Icon class="h-3 w-3" />
        </div>

        <div class="min-w-0 flex-1">
          <div class="leading-none font-medium">
            {command.name}
          </div>
          <div
            class="mt-1 text-xs transition-colors {isSelected
              ? 'text-primary-foreground/85'
              : 'text-muted-foreground group-hover:text-foreground/70'}"
          >
            {command.description}
          </div>
        </div>

        <div class="ml-auto flex items-center gap-2">
          {#if command.shortcut}
            <Kbd.Group class="gap-0.5">
              {#each getShortcutKeys(command.shortcut) as key, keyIndex}
                {#if keyIndex > 0}
                  <span
                    class="px-0.5 text-[10px] {isSelected
                      ? 'text-primary-foreground/50'
                      : 'text-muted-foreground'}">+</span
                  >
                {/if}
                <Kbd.Root
                  class="h-5 min-w-0 border-0 px-1.5 font-mono text-[10px] shadow-none {isSelected
                    ? 'bg-background/16 text-primary-foreground'
                    : 'bg-muted/80 text-muted-foreground'}"
                >
                  {key}
                </Kbd.Root>
              {/each}
            </Kbd.Group>
          {/if}

          {#if isSelected}
            <div class="ml-0.5 h-4 w-px bg-primary-foreground/15"></div>
            <Kbd.Root
              class="h-5 min-w-0 border-0 bg-background px-1.5 font-mono text-[10px] text-foreground shadow-none"
            >
              ↵
            </Kbd.Root>
          {/if}
        </div>
      </button>
    {/each}

    {#if filteredCommands.length === 0}
      <div class="py-6 text-center text-sm text-muted-foreground">
        No commands found.
      </div>
    {/if}
  </div>
</div>

<style>
  .slash-menu-items::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  .slash-menu-items::-webkit-scrollbar-track {
    background: transparent;
  }
  .slash-menu-items::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 3px;
  }
  .slash-menu-items::-webkit-scrollbar-thumb:hover {
    background: var(--muted-foreground);
  }
</style>
