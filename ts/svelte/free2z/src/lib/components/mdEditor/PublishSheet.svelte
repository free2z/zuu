<script lang="ts">
  import * as Sheet from "$lib/components/ui/sheet/index.js";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { Textarea } from "$lib/components/ui/textarea";
  import { Button } from "$lib/components/ui/button";
  import { sanitizeZcashAddressInput } from "$lib/utils/zcashAddress";
  import { CANONICAL_URL_MAX_LENGTH } from "$lib/canonical-url.js";
  import TagInput from "$lib/components/TagInput.svelte";
  import TagSuggestions from "$lib/components/TagSuggestions.svelte";
  import { tStore as t } from "$lib/i18n";
  import { restrictedMediaPaths } from "$lib/components/media/mediaAccess";
  import { onMount, tick } from "svelte";
  import {
    focusFirstInvalidField,
    setCanonicalDisclosureExpanded,
    shouldExpandCanonicalDisclosure,
  } from "$lib/canonical-publish.js";
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
  import {
    getLocalTimeZone,
    toDatetimeLocalNow,
  } from "$lib/components/mdEditor/utils";
  import { zpageCanonicalPath } from "$lib/zpage-path";
  import { countMentionCandidates } from "./mentionContext";

  const DESCRIPTION_MAX_LENGTH = 250;

  interface Props {
    open: boolean;
    currentUser: EditorCurrentUser;
    canSchedule: boolean;
    isPublished: boolean;
    isSaving: boolean;
    description: string;
    canonicalUrl: string;
    vanity: string;
    tags: string[];
    /**
     * Identifies the saved article the AI has suggestions for. Empty for a
     * page that has never been saved — there is nothing to have suggested
     * about yet, and `TagSuggestions` renders nothing.
     */
    free2zaddr?: string;
    /** Forwarded to TagSuggestions: the server just rewrote tags. */
    onTagSuggestionWrite?: () => void;
    zcashAddress: string;
    /**
     * The article body, read ONLY to spot upload paths that a logged-out
     * reader could not fetch. See `restrictedMediaPaths`.
     */
    content: string;
    isSubscriberOnly: boolean;
    publishAt: string;
    validationErrors?: EditorValidationErrors;
    resetKey: string;
    onChange?: () => void;
    onVanityChange?: () => void;
    onCanonicalChange?: (value: string) => void;
    onCanonicalBlur?: (value: string) => void;
    onPublish: (publishAt: string) => Promise<boolean>;
    onPublishNow: () => Promise<boolean>;
    onCancelSchedule: () => Promise<boolean>;
    onUnpublish: () => Promise<boolean>;
    onSaveSettings: () => Promise<boolean>;
  }

  let {
    open = $bindable(),
    currentUser,
    canSchedule,
    isPublished,
    isSaving,
    description = $bindable(),
    canonicalUrl = $bindable(),
    vanity = $bindable(),
    tags = $bindable(),
    free2zaddr = "",
    onTagSuggestionWrite = undefined,
    zcashAddress = $bindable(),
    content,
    isSubscriberOnly = $bindable(),
    publishAt,
    validationErrors = {},
    resetKey,
    onChange,
    onVanityChange,
    onCanonicalChange,
    onCanonicalBlur,
    onPublish,
    onPublishNow,
    onCancelSchedule,
    onUnpublish,
    onSaveSettings,
  }: Props = $props();

  const descriptionTooLong = $derived(
    description.trim().length > DESCRIPTION_MAX_LENGTH,
  );
  const mentionCount = $derived(countMentionCandidates(content));
  const publicPathPreview = $derived(
    zpageCanonicalPath({
      creator: currentUser,
      vanity: vanity.trim() || "...",
      free2zaddr,
    }) ?? "/article/...",
  );

  /**
   * Body images that only a subscriber (or only the owner) can fetch.
   *
   * The image picker checks reachability against the page's tier when the
   * image goes IN, and this switch can move afterwards — turn "Subscribers
   * Only" back off and a `members` image the picker rightly allowed becomes a
   * 401 for every reader, invisibly, because the creator owns the file and so
   * their own preview keeps working. Nothing on the server re-checks it.
   *
   * So it is said here, next to the switch that causes it. A warning, not a
   * block: the file's tier can be changed from the media dashboard without the
   * body changing, so this can be stale in the harmless direction, and
   * refusing to save over it would be worse than the problem.
   */
  const restrictedBodyMedia = $derived(restrictedMediaPaths(content));

  let scheduleDraft = $state("");

  const hasSchedule = $derived(
    canSchedule && !isPublished && Boolean(scheduleDraft),
  );
  const isFutureSchedule = $derived(
    hasSchedule && new Date(scheduleDraft).getTime() > Date.now(),
  );

  let lastTagSignature = $state("");
  let lastResetKey = $state("");
  let scrollRegion = $state<HTMLDivElement>();
  let canonicalInput = $state<HTMLInputElement>();
  let canonicalExpanded = $state(shouldExpandCanonicalDisclosure(canonicalUrl));
  let scheduleMin = $state("");
  let localTimeZone = $state("local time");
  let scheduleWasOpen = $state(false);
  let scheduleResetKey = $state("");

  const canonicalFeedbackId = "canonical-url-feedback";

  onMount(() => {
    scheduleMin = toDatetimeLocalNow();
    localTimeZone = getLocalTimeZone();
  });

  // The datetime is a confirmation field, not ordinary autosaved metadata.
  // Keep edits local to the sheet until Schedule is clicked. Closing with
  // "Keep as Draft" therefore preserves the last persisted schedule.
  $effect(() => {
    if (!open || !scheduleWasOpen || resetKey !== scheduleResetKey) {
      scheduleDraft = publishAt;
      scheduleResetKey = resetKey;
    }
    scheduleWasOpen = open;
  });

  async function cancelSchedule() {
    scheduleDraft = "";
    const succeeded = await runAction(onCancelSchedule);
    if (!succeeded) {
      scheduleDraft = publishAt;
    }
    return succeeded;
  }

  async function setCanonicalExpanded(expanded: boolean) {
    ({ expanded: canonicalExpanded } = setCanonicalDisclosureExpanded(
      { expanded: canonicalExpanded, value: canonicalUrl },
      expanded,
    ));

    if (expanded) {
      await tick();
      canonicalInput?.focus();
    }
  }

  function notifyCanonicalChange(value: string) {
    canonicalUrl = value;
    if (onCanonicalChange) {
      onCanonicalChange(value);
    } else {
      onChange?.();
    }
  }

  async function runAction(action: () => Promise<boolean>) {
    const succeeded = await action();
    if (!succeeded) {
      await tick();
      if (validationErrors.canonical_url && !canonicalExpanded) {
        canonicalExpanded = true;
        await tick();
      }
      focusFirstInvalidField(scrollRegion);
    }
    return succeeded;
  }

  $effect(() => {
    const tagSignature = tags.join("|");

    if (resetKey !== lastResetKey) {
      lastResetKey = resetKey;
      lastTagSignature = tagSignature;
      canonicalExpanded = shouldExpandCanonicalDisclosure(canonicalUrl);
      return;
    }

    if (tagSignature !== lastTagSignature) {
      lastTagSignature = tagSignature;
      onChange?.();
    }
  });

  $effect(() => {
    if (validationErrors.canonical_url) {
      canonicalExpanded = true;
    }
  });
</script>

<Sheet.Root bind:open>
  <Sheet.Content
    class="flex w-full max-w-full flex-col border-l-border bg-card sm:w-[540px] sm:max-w-[540px]"
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

    <div bind:this={scrollRegion} class="flex-1 space-y-6 overflow-y-auto p-4">
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
          aria-invalid={Boolean(
            descriptionTooLong || validationErrors.description,
          )}
          oninput={() => onChange?.()}
        />
        <p
          class="text-xs {descriptionTooLong
            ? 'text-red-500'
            : 'text-muted-foreground'}"
        >
          {description.trim().length}/{DESCRIPTION_MAX_LENGTH}
          {#if !descriptionTooLong}
            <!-- The mechanism this describes, precisely, because it used to say
                 "we'll create a clean excerpt" and that named nothing:
                 leaving this blank publishes with an EMPTY description, and the
                 `describe_zpage_listener` Pub/Sub consumer
                 (py/dj/apps/openai/management/commands/) then asks an LLM for a
                 meta description and writes it back to `zPage.description`.

                 Every word here is load-bearing, and three of them are hedges
                 that a codex review earned:

                 * "usually" — NOT vagueness dressed up as honesty, which is the
                   sin the issue was filed about. The generation genuinely does
                   not always happen: bodies under 150 characters and pages with
                   no vanity are skipped outright, a failed call is acked and
                   dropped with no retry, and the listener only ever writes the
                   canonical `zPage.description`, so a translated variant
                   published from this same sheet never gets one. Measured on
                   prod: 2,417 of 2,508 published pages have a description.
                   "will" would be a promise the backend does not keep.
                 * "shortly after you publish" + "you won't see it here" — the
                   call is asynchronous and strictly AFTER publish, so there is
                   no preview to offer and the copy must not imply one.
                 * No claim about WHAT the interim fallback contains. The draft
                   of this line said "we show the opening of your article",
                   which is false for a subscriber-only page: both tiers
                   deliberately refuse to derive a description from paywalled
                   copy and emit a generic notice instead. Naming the fallback
                   accurately would cost a sentence and every exception in it;
                   pointing at the decision the creator actually has is worth
                   more than describing the degraded path. -->
            · {$t(
              "editor.subtitleHint",
              "Leave blank and AI usually writes one shortly after you publish — you won’t see it here. Write your own to control exactly what search and social show.",
            )}
          {:else}
            · {$t("editor.subtitleTooLong", "Too long!")}
          {/if}
        </p>
      </div>

      <div class="rounded-lg border border-border/60 p-3 text-sm">
        <p class="font-semibold">
          {$t("editor.mentionNotifications", "Mention notifications")}
        </p>
        <p class="mt-1 text-xs text-muted-foreground" aria-live="polite">
          {$t(
            "editor.mentionNotificationsHint",
            "About {count} unique people are mentioned in the body. The server validates the final title, description, and body, then applies eligibility and notification limits when first published.",
            { count: mentionCount },
          )}
        </p>
        {#if mentionCount > 5}
          <p class="mt-1 text-xs text-yellow-600">
            {$t(
              "editor.mentionNotificationsOverLimit",
              "This approximate body-only preview can include more than the five eligible recipients notified per page; extra mentions remain in your page.",
            )}
          </p>
        {/if}
      </div>

      <div class="space-y-2">
        <Label for="vanity" class="text-sm font-semibold">
          {$t("editor.vanityLabel", "Vanity URL")}
        </Label>
        <Input
          id="vanity"
          type="text"
          bind:value={vanity}
          placeholder={$t("editor.vanityPlaceholder", "custom-url-slug")}
          class={validationErrors.vanity ? "border-red-500" : ""}
          aria-invalid={Boolean(validationErrors.vanity)}
          oninput={() => {
            onVanityChange?.();
            onChange?.();
          }}
        />
        {#if validationErrors.vanity}
          <p class="mt-1 text-xs text-red-500">{validationErrors.vanity}</p>
        {:else if currentUser}
          <p class="mt-1 text-xs text-muted-foreground">
            free2z.cash{publicPathPreview}
            {#if !vanity.trim()}
              <br />
              <span class="text-yellow-600">
                {$t(
                  "editor.vanityBlankWarning",
                  "If left blank, your page will not appear on your profile or in search.",
                )}
              </span>
            {/if}
          </p>
        {/if}
      </div>

      <div class="space-y-3 rounded-lg border border-border/60 p-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 space-y-1">
            <p class="text-sm font-semibold">
              {$t(
                "editor.canonicalUrlQuestion",
                "Originally published elsewhere?",
              )}
            </p>
            {#if !canonicalExpanded}
              <p class="text-xs text-muted-foreground">
                {canonicalUrl.trim()
                  ? $t(
                      "editor.canonicalUrlAdded",
                      "An original article URL is saved with this article.",
                    )
                  : $t(
                      "editor.canonicalUrlBlankHint",
                      "Leave this blank when the article was first published on Free2Z.",
                    )}
              </p>
            {/if}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            class="h-auto shrink-0 px-2 py-1 text-xs"
            aria-expanded={canonicalExpanded}
            aria-controls="canonical-url-fields"
            onclick={() => setCanonicalExpanded(!canonicalExpanded)}
          >
            {canonicalExpanded
              ? $t("editor.canonicalUrlHide", "Hide")
              : canonicalUrl.trim()
                ? $t("editor.canonicalUrlEdit", "Edit original URL")
                : $t("editor.canonicalUrlAdd", "Add the original article URL")}
          </Button>
        </div>

        {#if canonicalExpanded}
          <div id="canonical-url-fields" class="space-y-2">
            <div class="flex items-center justify-between gap-3">
              <Label for="canonical-url" class="text-sm font-semibold">
                {$t("editor.canonicalUrlLabel", "Original article URL")}
              </Label>
              {#if canonicalUrl}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="h-auto px-2 py-1 text-xs text-muted-foreground"
                  onclick={() => {
                    notifyCanonicalChange("");
                    canonicalInput?.focus();
                  }}
                >
                  {$t("editor.canonicalUrlClear", "Clear URL")}
                </Button>
              {/if}
            </div>
            <Input
              bind:ref={canonicalInput}
              id="canonical-url"
              type="url"
              bind:value={canonicalUrl}
              placeholder={$t(
                "editor.canonicalUrlPlaceholder",
                "https://your-blog.example/original-article",
              )}
              spellcheck={false}
              autocapitalize="none"
              autocomplete="url"
              maxlength={CANONICAL_URL_MAX_LENGTH}
              aria-invalid={Boolean(validationErrors.canonical_url)}
              aria-describedby={canonicalFeedbackId}
              aria-errormessage={validationErrors.canonical_url
                ? canonicalFeedbackId
                : undefined}
              class={validationErrors.canonical_url ? "border-red-500" : ""}
              oninput={(event) =>
                notifyCanonicalChange(event.currentTarget.value)}
              onblur={(event) => onCanonicalBlur?.(event.currentTarget.value)}
            />
            <p
              id={canonicalFeedbackId}
              class="text-xs {validationErrors.canonical_url
                ? 'text-red-500'
                : 'text-muted-foreground'}"
              aria-live="polite"
            >
              {validationErrors.canonical_url ||
                $t(
                  "editor.canonicalUrlHint",
                  "This article stays on Free2Z. Search engines are asked to prefer the original URL as the authoritative version.",
                )}
            </p>
          </div>
        {/if}
      </div>

      <div class="space-y-2">
        <Label for="publish-tags" class="text-sm font-semibold">
          {$t("editor.tags", "Tags")}
        </Label>
        <!-- No `onChange` here on purpose: the `$effect` below already turns a
             change in the tag list into one dirty signal, and it is the half
             that knows not to fire on a `resetKey` change.
             `resetKey` is what tells it a hydration happened, so it has to
             change on every hydration and not merely per article — see
             `metadataResetKey` in `/edit` and. Until it did, this effect
             reported a tag change on mount for every article that had tags,
             because its first pass baselined against the pre-hydration `[]`. -->
        <TagInput id="publish-tags" bind:tags />
        <!-- AI proposes, the creator disposes. Below the input on
             purpose: what the creator types comes first, and the machine's
             offer is an addition to it, never a replacement. -->
        <TagSuggestions
          {free2zaddr}
          bind:tags
          onServerWrote={onTagSuggestionWrite}
        />
      </div>

      {#if canSchedule && !isPublished}
        <div class="space-y-2">
          <Label for="publish-at" class="text-sm font-semibold">
            {$t("editor.scheduleLabel", "Schedule (Optional)")}
          </Label>
          <Input
            id="publish-at"
            type="datetime-local"
            bind:value={scheduleDraft}
            min={scheduleMin || undefined}
            aria-invalid={Boolean(validationErrors.publish_at)}
            aria-errormessage={validationErrors.publish_at
              ? "publish-at-error"
              : undefined}
            class="w-full {validationErrors.publish_at ? 'border-red-500' : ''}"
          />
          {#if validationErrors.publish_at}
            <p id="publish-at-error" class="mt-1 text-xs text-red-500">
              {validationErrors.publish_at}
            </p>
          {/if}
          <p class="text-xs text-muted-foreground">
            {$t(
              "editor.scheduleTimezoneHint",
              "Times are shown in your local timezone ({timezone}).",
              { timezone: localTimeZone },
            )}
            {#if isFutureSchedule}
              <br />
              {$t(
                "editor.scheduleSetHint",
                "Your article will go live automatically at the chosen time.",
              )}
            {:else if hasSchedule}
              <br />
              {$t(
                "editor.scheduleDueHint",
                "This scheduled time has arrived; publish now or choose a new time.",
              )}
            {:else}
              <br />
              {$t("editor.scheduleHint", "Leave empty to publish immediately.")}
            {/if}
          </p>
        </div>
      {/if}

      <div class="space-y-2">
        <Label for="zcash-address" class="text-sm font-semibold">
          {$t("editor.zcashLabel", "Zcash Address (Optional Override)")}
        </Label>
        <!-- Wrapping, not a single-line input: the whole payout address must
             stay visible so it can be verified before publish. -->
        <Textarea
          id="zcash-address"
          rows={2}
          bind:value={zcashAddress}
          placeholder={currentUser?.p2paddr ||
            $t("editor.zcashPlaceholder", "zs... or u...")}
          spellcheck={false}
          autocapitalize="none"
          autocomplete="off"
          class="w-full resize-none font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
          oninput={(e) => {
            // Printable ASCII only — a pasted address routinely carries
            // whitespace or zero-width characters that JS `\s` misses.
            const target = e.currentTarget as HTMLTextAreaElement;
            const cleaned = sanitizeZcashAddressInput(target.value);
            if (cleaned !== target.value) {
              target.value = cleaned;
            }
            zcashAddress = cleaned;
            onChange?.();
          }}
        />
        <p class="mt-1 text-xs text-muted-foreground">
          {$t(
            "editor.zcashHint",
            "Use this if it differs from your profile address. Usually a Zcash address.",
          )}
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
          {$t(
            "editor.subscribersOnlyHint",
            "Only your subscribers can view this content.",
          )}
        </p>
        {#if !isSubscriberOnly && restrictedBodyMedia.length > 0}
          <p
            class="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-200"
            data-restricted-body-media={restrictedBodyMedia.length}
            role="status"
          >
            {restrictedBodyMedia.length === 1
              ? $t(
                  "editor.restrictedBodyMediaOne",
                  "One image in this page is linked from a path only you or your subscribers can open. On a page that is not subscribers-only, readers may see it broken — you would not, because you own it. Worth checking in your media library before you publish.",
                )
              : $t(
                  "editor.restrictedBodyMediaMany",
                  "{count} images in this page are linked from paths only you or your subscribers can open. On a page that is not subscribers-only, readers may see them broken — you would not, because you own them. Worth checking in your media library before you publish.",
                  { count: restrictedBodyMedia.length },
                )}
          </p>
        {/if}
      </div>
    </div>

    <Sheet.Footer class="gap-2 border-t pt-4">
      {#if isPublished}
        <Button
          class="w-full"
          disabled={isSaving || descriptionTooLong}
          onclick={() => runAction(onSaveSettings)}
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
          onclick={() => runAction(onUnpublish)}
        >
          <Undo2 class="mr-2 h-4 w-4" />
          {$t("editor.revertToDraft", "Revert to Draft")}
        </Button>
      {:else}
        <Button
          class="w-full"
          disabled={isSaving || descriptionTooLong}
          onclick={() =>
            runAction(() => onPublish(canSchedule ? scheduleDraft : ""))}
        >
          {#if isSaving}
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
          {:else if isFutureSchedule}
            <CalendarClock class="mr-2 h-4 w-4" />
          {:else}
            <Send class="mr-2 h-4 w-4" />
          {/if}
          {isFutureSchedule
            ? $t("editor.schedule", "Schedule")
            : $t("editor.publishNow", "Publish Now")}
        </Button>
        {#if isFutureSchedule}
          <Button
            variant="outline"
            class="w-full"
            disabled={isSaving || descriptionTooLong}
            onclick={() => runAction(onPublishNow)}
          >
            <Send class="mr-2 h-4 w-4" />
            {$t("editor.publishNow", "Publish Now")}
          </Button>
        {/if}
        {#if hasSchedule}
          <Button
            variant="ghost"
            class="w-full text-muted-foreground"
            disabled={isSaving}
            onclick={cancelSchedule}
          >
            {$t("editor.cancelSchedule", "Cancel schedule")}
          </Button>
        {/if}
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
