<script lang="ts">
  import { page } from "$app/state";
  import { tStore as t } from "$lib/i18n";

  // Only show messages emitted by this loader. Unexpected errors can contain
  // diagnostics; those get a safe localized fallback instead.
  const loaderMessageKeys = [
    "editor.variantLoadFailed",
    "editor.editorUserLoadFailed",
    "editor.articleLoadFailed",
    "editor.backendUnavailable",
  ];
  const message = $derived(
    page.status === 404
      ? $t("editor.articleNotFound")
      : $t(
          loaderMessageKeys.find((key) => $t(key) === page.error?.message) ??
            "editor.backendUnavailable",
        ),
  );
</script>

<div role="alert" class="mx-auto max-w-xl space-y-4 p-8">
  <h1 class="text-2xl font-semibold">{page.status}</h1>
  <p>{message}</p>
  {#if page.status >= 500}
    <button class="cursor-pointer underline" onclick={() => location.reload()}
      >{$t("editor.saveConflictReload")}</button
    >
  {:else}
    <a class="cursor-pointer underline" href="/">{$t("errors.returnHome")}</a>
  {/if}
</div>
