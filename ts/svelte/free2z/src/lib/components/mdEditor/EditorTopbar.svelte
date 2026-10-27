<script lang="ts">
  import { afterNavigate } from "$app/navigation";
  import { scrollTopbar } from "$lib/actions/scrollTopbar";
  import { formatDateTime } from "$lib/utils/date";
  import { Button } from "$lib/components/ui/button";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import PublishSheet from "$lib/components/mdEditor/PublishSheet.svelte";
  import AuthUserDropdown from "$lib/components/auth/AuthUserDropdown.svelte";
  import { locale, tStore as t } from "$lib/i18n";
  import type {
    EditorCurrentUser,
    EditorMode,
    EditorValidationErrors,
  } from "$lib/components/mdEditor/types";
  import {
    Eye,
    Edit3,
    Loader2,
    ArrowLeft,
    SplitSquareHorizontal,
    AlertCircle,
    CalendarClock,
    Check,
    CloudUpload,
    Trash2,
  } from "@lucide/svelte";

  interface Props {
    currentUser: EditorCurrentUser;
    canSchedule: boolean;
    mode: EditorMode;
    isSaving: boolean;
    saveError: string | null;
    lastSavedAt: number | null;
    isDirty: boolean;
    isPublished: boolean;
    title: string;
    content: string;
    handleSave: () => Promise<boolean>;
    description: string;
    canonicalUrl: string;
    vanity: string;
    tags: string[];
    /** Saved article identifier; empty until the first save. */
    free2zaddr?: string;
    /** The tag-suggestion endpoint just rewrote this article's tags. */
    onTagSuggestionWrite?: () => void;
    zcashAddress: string;
    isSubscriberOnly: boolean;
    publishAt: string;
    validationErrors: EditorValidationErrors;
    resetKey: string;
    viewHref: string | null;
    onMetadataChange?: () => void;
    onVanityChange?: () => void;
    onCanonicalUrlChange?: (value: string) => void;
    onCanonicalUrlBlur?: (value: string) => void;
    onPublish: (publishAt: string) => Promise<boolean>;
    /**
     * The translation review loop has its own Publish; a second one
     * up here would be a duplicate with different rules ( review).
     */
    hidePublish?: boolean;
    onPublishNow: () => Promise<boolean>;
    onCancelSchedule: () => Promise<boolean>;
    onUnpublish: () => Promise<boolean>;
    onDelete?: () => Promise<boolean>;
    isDeleting?: boolean;
  }

  let {
    currentUser,
    canSchedule,
    mode = $bindable(),
    isSaving,
    saveError,
    lastSavedAt,
    isDirty,
    isPublished,
    title,
    content,
    handleSave,
    description = $bindable(),
    canonicalUrl = $bindable(),
    vanity = $bindable(),
    tags = $bindable(),
    free2zaddr = "",
    onTagSuggestionWrite = undefined,
    zcashAddress = $bindable(),
    isSubscriberOnly = $bindable(),
    publishAt = $bindable(),
    validationErrors,
    resetKey,
    viewHref,
    onMetadataChange,
    onVanityChange,
    onCanonicalUrlChange,
    onCanonicalUrlBlur,
    onPublish,
    onPublishNow,
    onCancelSchedule,
    onUnpublish,
    onDelete = undefined,
    isDeleting = false,
    hidePublish = false,
  }: Props = $props();

  let publishSheetOpen = $state(false);

  const canSave = $derived(Boolean(title.trim() && content.trim()));

  const isScheduled = $derived(
    canSchedule && !isPublished && Boolean(publishAt),
  );

  const modeOptions = $derived.by(
    () =>
      [
        { value: "write", icon: Edit3, label: $t("editor.write", "Write") },
        {
          value: "split",
          icon: SplitSquareHorizontal,
          label: $t("editor.split", "Split"),
        },
        {
          value: "preview",
          icon: Eye,
          label: $t("editor.preview", "Preview"),
        },
      ] as const,
  );

  async function runSheetAction(action: () => Promise<boolean>) {
    const succeeded = await action();

    if (succeeded) {
      publishSheetOpen = false;
    }

    return succeeded;
  }

  let navigationRevision = $state(0);
  afterNavigate(() => {
    navigationRevision += 1;
  });

  let profileOpen = $state(false);
</script>

<header
  use:scrollTopbar={{
    pinned: publishSheetOpen || profileOpen,
    resetKey: navigationRevision,
  }}
  class="scroll-topbar sticky top-0 z-50 shrink-0 border-b border-border/60 bg-background/96"
>
  <div
    class="mx-auto flex h-auto flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2 md:h-16 md:px-6 md:py-0"
  >
    <div class="flex min-w-0 items-center gap-1 md:gap-1.5">
      <Tooltip.Root>
        <Tooltip.Trigger>
          <Button
            variant="ghost"
            size="icon-sm"
            href={currentUser
              ? `/${currentUser.username}/dashboard/pages`
              : "/"}
            class="text-(--f2z-text-secondary) hover:!bg-transparent hover:text-(--f2z-accent-primary)"
            aria-label={$t("editor.backToDashboard", "Back to your articles")}
          >
            <ArrowLeft class="size-4" />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content>
          <p>{$t("editor.backToDashboard", "Back to your articles")}</p>
        </Tooltip.Content>
      </Tooltip.Root>

      {#snippet statusIcon()}
        {#if isScheduled}
          <CalendarClock class="h-3 w-3" />
        {:else}
          <span
            class="h-1.5 w-1.5 rounded-full {isPublished
              ? 'bg-(--f2z-accent-primary)'
              : 'bg-(--f2z-text-secondary)/50'}"
            aria-hidden="true"
          ></span>
        {/if}
      {/snippet}

      {#if isPublished && viewHref}
        <Tooltip.Root>
          <Tooltip.Trigger>
            <a
              href={viewHref}
              target="_blank"
              class="flex items-center gap-1.5 px-1 text-xs font-medium text-(--f2z-accent-primary) hover:underline"
            >
              {@render statusIcon()}
              {$t("editor.published", "Published")}
            </a>
          </Tooltip.Trigger>
          <Tooltip.Content>
            <p>{$t("editor.viewArticle", "View published article")}</p>
          </Tooltip.Content>
        </Tooltip.Root>
      {:else}
        <span
          class="flex items-center gap-1.5 px-1 text-xs font-medium {isScheduled
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-(--f2z-text-secondary)'}"
        >
          {@render statusIcon()}
          {#if isScheduled}
            {$t("editor.scheduled", "Scheduled")}
          {:else}
            {$t("editor.draft", "Draft")}
          {/if}
        </span>
      {/if}

      <span class="mx-0.5 text-(--f2z-text-secondary)/40" aria-hidden="true"
        >·</span
      >

      <Tooltip.Root>
        <Tooltip.Trigger>
          <span
            class="flex items-center gap-1.5 px-1 text-xs {saveError
              ? 'text-destructive'
              : 'text-(--f2z-text-secondary)'}"
            role="status"
            aria-live="polite"
          >
            {#if isSaving}
              <Loader2 class="h-3.5 w-3.5 animate-spin" />
              {$t("editor.saving", "Saving...")}
            {:else if saveError}
              <AlertCircle class="h-3.5 w-3.5" />
              {$t("editor.saveError", "Failed to save article")}
            {:else if isDirty}
              <CloudUpload class="h-3.5 w-3.5" />
              {$t("editor.unsaved", "Unsaved changes")}
            {:else if lastSavedAt}
              <Check class="h-3.5 w-3.5 text-(--f2z-accent-primary)" />
              {$t("editor.saved", "Saved")}
            {:else}
              <CloudUpload class="h-3.5 w-3.5" />
              {$t("editor.autosave", "Autosave on")}
            {/if}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content>
          {#if saveError}
            <!-- The chip has room for a label; this has room for the reason.
                 Rendering the generic key here threw away the one sentence
                 that says which field was refused and what to do. -->
            <p>{saveError}</p>
          {:else if !isDirty && lastSavedAt}
            <p>
              {$t("editor.lastSaved", "Last saved:")}
              {formatDateTime(lastSavedAt, $locale, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          {:else}
            <p>
              {$t(
                "editor.autosaveDescription",
                "Your work is automatically saved as you type.",
              )}
            </p>
          {/if}
        </Tooltip.Content>
      </Tooltip.Root>
    </div>

    <div class="flex items-center gap-1.5 md:gap-2">
      <div
        class="flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/40 p-0.5"
      >
        {#each modeOptions as option (option.value)}
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Button
                variant="ghost"
                size="sm"
                onclick={() => (mode = option.value)}
                class="h-7 w-8 rounded-full p-0 {mode === option.value
                  ? 'bg-background text-(--f2z-accent-primary) shadow-sm hover:bg-background hover:text-(--f2z-accent-primary)'
                  : 'text-(--f2z-text-secondary) hover:bg-transparent hover:text-(--f2z-accent-primary)'}"
                aria-label={option.label}
                aria-pressed={mode === option.value}
              >
                <option.icon class="size-4" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p>{option.label}</p>
            </Tooltip.Content>
          </Tooltip.Root>
        {/each}
      </div>

      {#if hidePublish}
        <!-- Reviewing a translation: its Publish is in the review bar. -->
      {:else if isPublished}
        <Button
          variant="outline"
          size="sm"
          class="rounded-full border-(--f2z-border-primary) px-4"
          onclick={() => (publishSheetOpen = true)}
        >
          {$t("editor.update", "Update")}
        </Button>
      {:else if canSave}
        <Button
          size="sm"
          class="rounded-full px-4 md:px-5"
          onclick={() => (publishSheetOpen = true)}
        >
          {$t("editor.publish", "Publish")}
        </Button>
      {:else}
        <Tooltip.Root>
          <Tooltip.Trigger>
            <Button size="sm" class="rounded-full px-4 md:px-5" disabled>
              {$t("editor.publish", "Publish")}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>
            <p>
              {!title.trim()
                ? $t("editor.publishNeedsTitle", "Add a title to publish")
                : $t(
                    "editor.publishNeedsContent",
                    "Write some content to publish",
                  )}
            </p>
          </Tooltip.Content>
        </Tooltip.Root>
      {/if}

      {#if free2zaddr && onDelete}
        <Button
          variant="ghost"
          size="icon-sm"
          class="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onclick={() => void onDelete?.()}
          disabled={isDeleting}
          aria-label={$t("editor.deletePage", "Delete page")}
          title={$t("editor.deletePage", "Delete page")}
        >
          <Trash2 class="size-4" />
        </Button>
      {/if}

      <div class="ml-1">
        <AuthUserDropdown bind:open={profileOpen} />
      </div>
    </div>
  </div>
</header>

<PublishSheet
  bind:open={publishSheetOpen}
  {currentUser}
  {canSchedule}
  {isPublished}
  {isSaving}
  {content}
  bind:description
  bind:canonicalUrl
  bind:vanity
  bind:tags
  {free2zaddr}
  {onTagSuggestionWrite}
  bind:zcashAddress
  bind:isSubscriberOnly
  {publishAt}
  {validationErrors}
  {resetKey}
  onChange={onMetadataChange}
  {onVanityChange}
  onCanonicalChange={onCanonicalUrlChange}
  onCanonicalBlur={onCanonicalUrlBlur}
  onPublish={(value) => runSheetAction(() => onPublish(value))}
  onPublishNow={() => runSheetAction(onPublishNow)}
  onCancelSchedule={() => runSheetAction(onCancelSchedule)}
  onUnpublish={() => runSheetAction(onUnpublish)}
  onSaveSettings={() => runSheetAction(handleSave)}
/>
