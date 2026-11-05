<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import { tStore as t } from "$lib/i18n";
  let {
    onSave,
    direction = "auto",
  }: {
    onSave: (alt: string, caption: string) => boolean;
    direction?: "ltr" | "rtl" | "auto";
  } = $props();
  let open = $state(false);
  let alt = $state("");
  let caption = $state("");
  let error = $state(false);
  let pending:
    ((value: { alt: string; caption: string } | null) => void) | null = null;
  export function request(
    description: string,
  ): Promise<{ alt: string; caption: string } | null> {
    if (pending) return Promise.resolve(null);
    show(description, "");
    return new Promise((resolve) => {
      pending = resolve;
    });
  }
  function cancel() {
    const resolve = pending;
    pending = null;
    open = false;
    resolve?.(null);
  }
  function changed(next: boolean) {
    if (!next) cancel();
  }
  $effect(() => () => {
    pending?.(null);
    pending = null;
  });
  export function show(description: string, visibleCaption: string) {
    alt = description;
    caption = visibleCaption;
    error = false;
    open = true;
  }
  function save(event: SubmitEvent) {
    event.preventDefault();
    if (pending) {
      const resolve = pending;
      pending = null;
      open = false;
      resolve({ alt, caption });
    } else if (onSave(alt, caption)) open = false;
    else error = true;
  }
</script>

<Dialog.Root bind:open onOpenChange={changed}>
  <Dialog.Content class="z-[60] max-w-lg">
    <Dialog.Header>
      <Dialog.Title
        >{$t("editor.imageDetailsTitle", "Image details")}</Dialog.Title
      >
      <Dialog.Description
        >{$t(
          "editor.imageDetailsHint",
          "Alt text describes the image for screen readers. A caption appears below the image for everyone.",
        )}</Dialog.Description
      >
    </Dialog.Header>
    <form onsubmit={save} class="space-y-4">
      <div class="space-y-2">
        <Label for="image-description"
          >{$t(
            "editor.imageDescription",
            "Alt text (image description)",
          )}</Label
        >
        <Input id="image-description" bind:value={alt} dir={direction} />
      </div>
      <div class="space-y-2">
        <Label for="image-caption"
          >{$t("editor.imageCaption", "Visible caption")}</Label
        >
        <textarea
          id="image-caption"
          bind:value={caption}
          dir={direction}
          class="min-h-20 w-full rounded-md border bg-background p-2 text-foreground"
        ></textarea>
      </div>
      {#if error}<p role="alert" class="text-sm text-destructive">
          {$t(
            "editor.imageDetailsChanged",
            "The document changed. Select the image again.",
          )}
        </p>{/if}
      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" onclick={cancel}
          >{$t("common.cancel", "Cancel")}</Button
        >
        <Button type="submit">{$t("editor.imageDetailsSave", "Apply")}</Button>
      </div>
    </form>
  </Dialog.Content>
</Dialog.Root>
