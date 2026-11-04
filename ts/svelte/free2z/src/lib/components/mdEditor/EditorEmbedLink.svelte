<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import { tStore as t } from "$lib/i18n";
  import { classifyFirstPartyEmbed } from "$lib/utils/first-party-embed";
  import { getSafeHttpUrl } from "$lib/utils/safe-url";
  let { onInsert }: { onInsert: (url: string) => void } = $props();
  let open = $state(false);
  let url = $state("");
  let error = $state("");
  export function openPicker() {
    url = "";
    error = "";
    open = true;
  }
  function insert(event: SubmitEvent) {
    event.preventDefault();
    const safe = getSafeHttpUrl(url.trim());
    if (!safe) {
      error = $t(
        "editor.invalidEmbedLink",
        "Enter a complete HTTP or HTTPS URL.",
      );
      return;
    }
    const firstParty = classifyFirstPartyEmbed(safe);
    const path =
      firstParty && "path" in firstParty
        ? firstParty.path
        : new URL(safe).origin === window.location.origin
          ? new URL(safe).pathname
          : "";
    if (path.startsWith("/uploadz/") && !path.startsWith("/uploadz/public/")) {
      error = $t(
        "editor.restrictedEmbedLink",
        "Choose this file from Your Cloud so we can check access and ask before sharing it with readers.",
      );
      return;
    }
    try {
      onInsert(safe);
      open = false;
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : $t("editor.insertLinkFailed", "Unable to insert link.");
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-lg">
    <Dialog.Header>
      <Dialog.Title
        >{$t("editor.commandNames.embedLink", "Embed link")}</Dialog.Title
      >
      <Dialog.Description
        >{$t(
          "editor.embedLinkHint",
          "Paste an HTTP(S) URL. Preview uses the same embed and privacy controls as your published page.",
        )}</Dialog.Description
      >
    </Dialog.Header>
    <form onsubmit={insert} class="space-y-4">
      <label for="editor-embed-url">{$t("editor.embedUrl", "URL")}</label>
      <Input
        id="editor-embed-url"
        bind:value={url}
        placeholder="https://"
        aria-invalid={!!error}
        aria-describedby={error ? "embed-link-error" : undefined}
      />
      {#if error}<p
          id="embed-link-error"
          role="alert"
          class="text-sm text-destructive"
        >
          {error}
        </p>{/if}
      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" onclick={() => (open = false)}
          >{$t("common.cancel", "Cancel")}</Button
        >
        <Button type="submit">{$t("editor.insertEmbed", "Insert embed")}</Button
        >
      </div>
    </form>
  </Dialog.Content>
</Dialog.Root>
