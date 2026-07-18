<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import PublishSheet from "$lib/components/mdEditor/PublishSheet.svelte";
  import AuthUserDropdown from "$lib/components/auth/AuthUserDropdown.svelte";
  import { tStore as t } from "$lib/i18n";
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
  } from "@lucide/svelte";

  interface Props {
    currentUser: EditorCurrentUser;
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
    vanity: string;
    selectedCategories: string[];
    zcashAddress: string;
    isSubscriberOnly: boolean;
    publishAt: string;
    validationErrors: EditorValidationErrors;
    resetKey: string;
    viewHref: string | null;
    onMetadataChange?: () => void;
    onPublish: () => Promise<boolean>;
    onUnpublish: () => Promise<boolean>;
  }

  let {
    currentUser,
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
    vanity = $bindable(),
    selectedCategories = $bindable(),
    zcashAddress = $bindable(),
    isSubscriberOnly = $bindable(),
    publishAt = $bindable(),
    validationErrors,
    resetKey,
    viewHref,
    onMetadataChange,
    onPublish,
    onUnpublish,
  }: Props = $props();

  let publishSheetOpen = $state(false);

  const canSave = $derived(Boolean(title.trim() && content.trim()));

  const isScheduled = $derived(
    !isPublished &&
      Boolean(publishAt) &&
      new Date(publishAt).getTime() > Date.now(),
  );

  const modeOptions = [
    { value: "write", icon: Edit3, label: "Write" },
    { value: "split", icon: SplitSquareHorizontal, label: "Split" },
    { value: "preview", icon: Eye, label: "Preview" },
  ] as const;

  async function runSheetAction(action: () => Promise<boolean>) {
    const succeeded = await action();

    if (succeeded) {
      publishSheetOpen = false;
    }
  }

  let lastScrollY = $state(0);
  let visible = $state(true);
  const threshold = 20;
  const upThreshold = 10;

  function handleScroll() {
    const currentScrollY = window.scrollY;
    const delta = currentScrollY - lastScrollY;

    if (Math.abs(delta) < 5) return;

    if (delta > 0 && currentScrollY > threshold) {
      visible = false;
    } else if (delta < -upThreshold || currentScrollY < threshold) {
      visible = true;
    }
    lastScrollY = currentScrollY;
  }
</script>

<svelte:window onscroll={handleScroll} />

<header
  class="sticky top-0 z-50 shrink-0 border-b border-border/60 bg-background/90 backdrop-blur-md transition-transform duration-300 {visible
    ? 'translate-y-0'
    : '-translate-y-full'}"
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
              {$t("editor.saveError", "Couldn't save")}
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
            <p>{saveError}</p>
          {:else if !isDirty && lastSavedAt}
            <p>
              {$t("editor.lastSaved", "Last saved")}
              {new Date(lastSavedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          {:else}
            <p>Your work is automatically saved as you type</p>
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

      {#if isPublished}
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

      <div class="ml-1">
        <AuthUserDropdown />
      </div>
    </div>
  </div>
</header>

<PublishSheet
  bind:open={publishSheetOpen}
  {currentUser}
  {isPublished}
  {isSaving}
  bind:description
  bind:vanity
  bind:selectedCategories
  bind:zcashAddress
  bind:isSubscriberOnly
  bind:publishAt
  {validationErrors}
  {resetKey}
  onChange={onMetadataChange}
  onPublish={() => runSheetAction(onPublish)}
  onUnpublish={() => runSheetAction(onUnpublish)}
  onSaveSettings={() => runSheetAction(handleSave)}
/>
