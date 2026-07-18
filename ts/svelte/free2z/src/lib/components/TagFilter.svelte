<script lang="ts">
 import Check from "@lucide/svelte/icons/check";
 import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
 import { tick } from "svelte";
 import * as Command from "$lib/components/ui/command/index.js";
 import * as Popover from "$lib/components/ui/popover/index.js";
 import { Button } from "$lib/components/ui/button/index.js";
 import { cn } from "$lib/utils.js";
 
 let { availableTags, currentTag, onSelect } = $props<{
    availableTags: { name: string; count: number }[];
    currentTag: string;
    onSelect: (tag: string) => void;
 }>();
 
 let open = $state(false);
 let triggerRef = $state<HTMLButtonElement>(null!);
 
 function closeAndFocusTrigger() {
  open = false;
  tick().then(() => {
   triggerRef.focus();
  });
 }
</script>
 
<Popover.Root bind:open>
 <Popover.Trigger bind:ref={triggerRef}>
  {#snippet child({ props })}
   <Button
    {...props}
    variant="outline"
    class="w-full md:w-48 justify-between bg-muted/50 border-border/50 h-9"
    role="combobox"
    aria-expanded={open}
   >
    <span class="truncate">
        {currentTag || "Tag"}
    </span>
    <ChevronsUpDown class="ml-2 size-4 opacity-50" />
   </Button>
  {/snippet}
 </Popover.Trigger>
 <Popover.Content class="w-[200px] p-0">
  <Command.Root>
   <Command.Input placeholder="Search tags..." />
   <Command.List class="max-h-[300px] overflow-y-auto overflow-x-hidden">
    <Command.Empty>No tag found.</Command.Empty>
    <Command.Group>
      <Command.Item
       value="all-tags-clear-selection"
       onSelect={() => {
        onSelect("");
        closeAndFocusTrigger();
       }}
      >
       <Check
        class={cn("mr-2 size-4", !currentTag && "text-transparent")}
       />
       All Tags
      </Command.Item>

     {#each availableTags as tag (tag.name)}
      <Command.Item
       value={tag.name}
       onSelect={() => {
        onSelect(tag.name);
        closeAndFocusTrigger();
       }}
      >
       <Check
        class={cn("mr-2 size-4", currentTag !== tag.name && "text-transparent")}
       />
       <div class="flex flex-1 justify-between items-center gap-2 overflow-hidden">
           <span class="truncate">{tag.name}</span>
           <span class="text-xs text-muted-foreground ml-auto shrink-0">{tag.count}</span>
       </div>
      </Command.Item>
     {/each}
    </Command.Group>
   </Command.List>
  </Command.Root>
 </Popover.Content>
</Popover.Root>