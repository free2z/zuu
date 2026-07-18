<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { tStore as t } from "$lib/i18n";
  import { UploadCloud } from "@lucide/svelte";

  interface Props {
    onDragState: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void | Promise<void>;
    onDeviceInputChange: (
      event: Event & { currentTarget: EventTarget & HTMLInputElement },
    ) => void | Promise<void>;
  }

  let { onDragState, onDrop, onDeviceInputChange }: Props = $props();
  let deviceInputRef = $state<HTMLInputElement | null>(null);
</script>

<div
  class="rounded-2xl border border-dashed border-border/60 bg-muted/20 p-8 text-center"
  role="region"
  aria-label="Drop an image here to upload a cover"
  ondragenter={onDragState}
  ondragover={onDragState}
  ondragleave={onDragState}
  ondrop={onDrop}
>
  <div class="mx-auto flex max-w-md flex-col items-center gap-3">
    <div class="rounded-full bg-background p-4 shadow-sm">
      <UploadCloud class="h-6 w-6 text-primary" />
    </div>
    <div class="space-y-1">
      <p class="text-sm font-medium text-foreground">
        {$t(
          "editor.dropOrSelectCover",
          "Drop an image here or pick one from your device",
        )}
      </p>
      <p class="text-xs text-muted-foreground">
        {$t(
          "editor.coverUploadHint",
          "The final cover will be cropped to the standard banner ratio before it is saved.",
        )}
      </p>
    </div>
    <Button size="sm" onclick={() => deviceInputRef?.click()}>
      {$t("editor.selectImage", "Select Image")}
    </Button>
    <input
      bind:this={deviceInputRef}
      type="file"
      accept="image/*"
      class="hidden"
      onchange={onDeviceInputChange}
    />
  </div>
</div>
