<script lang="ts">
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import * as Select from "$lib/components/ui/select";
  import { Switch } from "$lib/components/ui/switch";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Button } from "$lib/components/ui/button";
  import { CATEGORY_CHOICES } from "$lib/types/zpage";
  import { tStore as t } from "$lib/i18n";
  import {
    CalendarClock,
    FileText,
    Loader2,
    Send,
    Undo2,
  } from "@lucide/svelte";
  import type {
    EditorCurrentUser,
    EditorValidationErrors,
  } from "$lib/components/mdEditor/types";

  const DESCRIPTION_MAX_LENGTH = 250;

  interface Props {
    open: boolean;
    currentUser: EditorCurrentUser;
    isPublished: boolean;
    isSaving: boolean;
    description: string;
    vanity: string;
    selectedCategories: string[];
    zcashAddress: string;
    isSubscriberOnly: boolean;
    publishAt: string;
    validationErrors?: EditorValidationErrors;
    resetKey: string;
    onChange?: () => void;
    onPublish: () => void | Promise<void>;
    onUnpublish: () => void | Promise<void>;
    onSaveSettings: () => void | Promise<void>;
  }

  let {
    open = $bindable(),
    currentUser,
    isPublished,
    isSaving,
    description = $bindable(),
    vanity = $bindable(),
    selectedCategories = $bindable(),
    zcashAddress = $bindable(),
    isSubscriberOnly = $bindable(),
    publishAt = $bindable(),
    validationErrors = {},
    resetKey,
    onChange,
    onPublish,
    onUnpublish,
    onSaveSettings,
  }: Props = $props();

  const availableCategories = CATEGORY_CHOICES.filter(
    (cat) => cat.value !== "",
  );

  const categoryLabelMap = new Map(
    availableCategories.map(
      (category) => [category.value, category.label] as const,
    ),
  );

  const selectedCategoryDetails = $derived(
    selectedCategories.map((value) => ({
      value,
      label: categoryLabelMap.get(value) ?? value,
    })),
  );

  const triggerContent = $derived(
    selectedCategoryDetails.length > 0
      ? selectedCategoryDetails.map((category) => category.label).join(", ")
      : "Select categories...",
  );

  const descriptionTooLong = $derived(
    description.trim().length > DESCRIPTION_MAX_LENGTH,
  );

  const isScheduling = $derived(
    !isPublished &&
      Boolean(publishAt) &&
      new Date(publishAt).getTime() > Date.now(),
  );

  let lastCategorySignature = $state("");
  let lastResetKey = $state("");

  $effect(() => {
    const categorySignature = selectedCategories.join("|");

    if (resetKey !== lastResetKey) {
      lastResetKey = resetKey;
      lastCategorySignature = categorySignature;
      return;
    }

    if (categorySignature !== lastCategorySignature) {
      lastCategorySignature = categorySignature;
      onChange?.();
    }
  });
</script>

<Sheet.Root bind:open>
  <Sheet.Content
    class="flex w-[400px] flex-col border-l-border bg-card sm:w-[540px]"
  >
    <Sheet.Header>
      <Sheet.Title
        class="flex items-center gap-2 text-2xl font-black tracking-tight"
      >
        {isPublished
          ? $t("editor.articleSettings", "Article Settings")
          : $t("editor.readyToPublish", "Ready to publish?")}
      </Sheet.Title>
      <Sheet.Description>
        {isPublished
          ? $t(
              "editor.settingsDescription",
              "Update how your article appears and who can read it. Changes apply immediately.",
            )
          : $t(
              "editor.publishDescription",
              "Add the finishing touches before your article goes live. Everything here is optional.",
            )}
      </Sheet.Description>
    </Sheet.Header>

    <div class="flex-1 space-y-6 overflow-y-auto p-4">
      <div class="space-y-2">
        <Label for="publish-description" class="text-sm font-semibold">
          {$t("editor.subtitleLabel", "Subtitle / Description")}
        </Label>
        <Textarea
          id="publish-description"
          bind:value={description}
          rows={3}
          placeholder={$t(
            "editor.subtitlePlaceholder",
            "A short teaser shown in previews, search, and social shares...",
          )}
          class={descriptionTooLong || validationErrors.description
            ? "border-red-500"
            : ""}
          oninput={() => onChange?.()}
        />
        <p
          class="text-xs {descriptionTooLong
            ? 'text-red-500'
            : 'text-muted-foreground'}"
        >
          {description.trim().length}/{DESCRIPTION_MAX_LENGTH}
          {#if !descriptionTooLong}
            · {$t(
              "editor.subtitleHint",
              "Leave blank to get an AI-generated description.",
            )}
          {:else}
            · {$t("editor.subtitleTooLong", "Too long!")}
          {/if}
        </p>
      </div>

      <div class="space-y-2">
        <Label for="vanity" class="text-sm font-semibold">
          {$t("editor.vanityLabel", "Vanity URL")}
        </Label>
        <Input
          id="vanity"
          type="text"
          bind:value={vanity}
          placeholder="custom-url-slug"
          class={validationErrors.vanity ? "border-red-500" : ""}
          oninput={() => onChange?.()}
        />
        {#if validationErrors.vanity}
          <p class="mt-1 text-xs text-red-500">{validationErrors.vanity}</p>
        {:else if currentUser}
          <p class="mt-1 text-xs text-muted-foreground">
            free2z.cash/{currentUser.username}/zpage/{vanity || "..."}
            {#if !vanity.trim()}
              <br />
              <span class="text-yellow-600">
                If blank, your page will not be publicized on your profile or in
                search!
              </span>
            {/if}
          </p>
        {/if}
      </div>

      <div class="space-y-2">
        <Label class="text-sm font-semibold">
          {$t("editor.categories", "Categories")}
        </Label>
        <Select.Root
          type="multiple"
          bind:value={selectedCategories}
          items={availableCategories}
        >
          <Select.Trigger class="w-full" aria-label="Select categories">
            <span
              class={selectedCategoryDetails.length
                ? "truncate text-left"
                : "truncate text-left text-muted-foreground"}
            >
              {triggerContent}
            </span>
          </Select.Trigger>
          <Select.Content>
            <Select.Group>
              <Select.Label>Categories</Select.Label>
              {#each availableCategories as category (category.value)}
                <Select.Item value={category.value} label={category.label}>
                  {category.label}
                </Select.Item>
              {/each}
            </Select.Group>
          </Select.Content>
        </Select.Root>
      </div>

      {#if !isPublished}
        <div class="space-y-2">
          <Label for="publish-at" class="text-sm font-semibold">
            {$t("editor.scheduleLabel", "Schedule (Optional)")}
          </Label>
          <Input
            id="publish-at"
            type="datetime-local"
            bind:value={publishAt}
            class="w-full"
            oninput={() => onChange?.()}
          />
          <p class="text-xs text-muted-foreground">
            {#if isScheduling}
              {$t(
                "editor.scheduleSetHint",
                "Your article will go live automatically at the chosen time.",
              )}
            {:else}
              {$t("editor.scheduleHint", "Leave empty to publish immediately.")}
            {/if}
          </p>
        </div>
      {/if}

      <div class="space-y-2">
        <Label for="zcash-address" class="text-sm font-semibold">
          {$t("editor.zcashLabel", "Zcash Address (Optional Override)")}
        </Label>
        <Input
          id="zcash-address"
          type="text"
          bind:value={zcashAddress}
          placeholder={currentUser?.p2paddr || "zs... or u..."}
          class="w-full"
          oninput={() => onChange?.()}
        />
        <p class="mt-1 text-xs text-muted-foreground">
          Use if different from profile address. Commonly Zcash.
        </p>
      </div>

      <div class="space-y-2">
        <label class="flex cursor-pointer items-center gap-2">
          <Switch
            bind:checked={isSubscriberOnly}
            onCheckedChange={() => onChange?.()}
          />
          <span class="text-sm font-medium">
            {$t("editor.subscribersOnly", "Subscribers Only")}
          </span>
        </label>
        <p class="text-xs text-muted-foreground">
          Only your subscribers can view this content
        </p>
      </div>
    </div>

    <Sheet.Footer class="gap-2 border-t pt-4">
      {#if isPublished}
        <Button
          class="w-full"
          disabled={isSaving || descriptionTooLong}
          onclick={() => onSaveSettings()}
        >
          {#if isSaving}
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
          {/if}
          {$t("editor.saveSettings", "Save Settings")}
        </Button>
        <Button
          variant="outline"
          class="w-full text-muted-foreground"
          disabled={isSaving}
          onclick={() => onUnpublish()}
        >
          <Undo2 class="mr-2 h-4 w-4" />
          {$t("editor.revertToDraft", "Revert to Draft")}
        </Button>
      {:else}
        <Button
          class="w-full"
          disabled={isSaving || descriptionTooLong}
          onclick={() => onPublish()}
        >
          {#if isSaving}
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
          {:else if isScheduling}
            <CalendarClock class="mr-2 h-4 w-4" />
          {:else}
            <Send class="mr-2 h-4 w-4" />
          {/if}
          {isScheduling
            ? $t("editor.schedule", "Schedule")
            : $t("editor.publishNow", "Publish Now")}
        </Button>
        <Sheet.Close class="w-full">
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              class="w-full text-muted-foreground"
              disabled={isSaving}
            >
              <FileText class="mr-2 h-4 w-4" />
              {$t("editor.keepDraft", "Keep as Draft")}
            </Button>
          {/snippet}
        </Sheet.Close>
      {/if}
    </Sheet.Footer>
  </Sheet.Content>
</Sheet.Root>
