<script lang="ts">
  import { browser } from "$app/environment";
  import { beforeNavigate, goto, replaceState } from "$app/navigation";
  import { onDestroy } from "svelte";
  import type { PageData } from "./$types";
  import { toast } from "svelte-sonner";
  import { tStore as t } from "$lib/i18n";
  import { apiFetch } from "$lib/api/config";
  import EditorComposer from "$lib/components/mdEditor/EditorComposer.svelte";
  import EditorPreview from "$lib/components/mdEditor/EditorPreview.svelte";
  import EditorStats from "$lib/components/mdEditor/EditorStats.svelte";
  import EditorTopbar from "$lib/components/mdEditor/EditorTopbar.svelte";
  import type {
    EditorCurrentUser,
    EditorMode,
    EditorValidationErrors,
  } from "$lib/components/mdEditor/types";
  import {
    UNTITLED_DRAFT_TITLE,
    hydrateEditorState,
    renderMarkdown,
    resolveMediaUrl,
    slugify,
    stripUploadPlaceholders,
    toDatetimeLocal,
  } from "$lib/components/mdEditor/utils";
  import type { ZPage } from "$lib/types/zpage";

  interface Props {
    data: PageData;
  }

  type SavePayload = {
    title: string;
    content: string;
    description: string;
    tags: string[];
    vanity: string;
    p2paddr: string;
    featured_image?: number | null;
    is_published: boolean;
    is_subscriber_only: boolean;
    publish_at: string | null;
  };

  interface SaveOptions {
    isAuto?: boolean;
    overrides?: Partial<SavePayload>;
    successMessage?: string;
  }

  const AUTOSAVE_DELAY = 2500;
  const AUTOSAVE_MAX_WAIT = 15000;
  const MAX_AUTOSAVE_RETRIES = 3;
  const DESCRIPTION_MAX_LENGTH = 250;

  let { data }: Props = $props();

  type EditPageData = PageData & {
    currentUser: EditorCurrentUser;
    requestedId: string;
    zpage: ZPage | null;
  };

  let currentZPage = $state<ZPage | null>(null);
  let title = $state("");
  let description = $state("");
  let coverImage = $state("");
  let coverImageId = $state<number | null>(null);
  let selectedCategories = $state<string[]>([]);
  let zcashAddress = $state("");
  let content = $state("");
  let vanity = $state("");
  let isPublished = $state(false);
  let isSubscriberOnly = $state(false);
  let publishAt = $state("");
  let showCover = $state(false);
  let showSubtitle = $state(false);
  let mode = $state<EditorMode>("write");
  let isSaving = $state(false);
  let saveError = $state<string | null>(null);
  let lastSavedAt = $state<number | null>(null);
  let validationErrors = $state<EditorValidationErrors>({});
  let autoSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastHydratedKey = $state("");
  let changeVersion = $state(0);
  let savedVersion = $state(0);
  let firstPendingChangeAt: number | null = null;
  let autoSaveRetries = 0;
  let destroyed = false;
  let currentSavePromise: Promise<boolean> | null = null;
  let pendingNavigationFlush = false;
  let bypassNextNavigationGuard = false;

  const isDirty = $derived(changeVersion !== savedVersion);

  function clearAutoSaveTimer() {
    if (!autoSaveTimeout) {
      return;
    }

    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = null;
  }

  function scheduleAutoSave(delay = AUTOSAVE_DELAY) {
    if (destroyed) {
      return;
    }

    clearAutoSaveTimer();

    const now = Date.now();

    if (firstPendingChangeAt === null) {
      firstPendingChangeAt = now;
    }

    // Debounce, but never defer past AUTOSAVE_MAX_WAIT from the first
    // pending change — continuous typing must not starve autosave forever.
    const maxWaitRemaining = Math.max(
      0,
      firstPendingChangeAt + AUTOSAVE_MAX_WAIT - now,
    );

    autoSaveTimeout = setTimeout(
      () => {
        autoSaveTimeout = null;
        firstPendingChangeAt = null;
        void handleSave({ isAuto: true });
      },
      Math.min(delay, maxWaitRemaining),
    );
  }

  function markDirty() {
    changeVersion += 1;
    autoSaveRetries = 0;
    scheduleAutoSave();
  }

  function getRouteData() {
    return data as EditPageData;
  }

  function applyHydratedState() {
    const hydratedState = hydrateEditorState(getRouteData().zpage);

    currentZPage = hydratedState.currentZPage;
    title = hydratedState.title;
    description = hydratedState.description;
    coverImage = hydratedState.coverImage;
    coverImageId = hydratedState.coverImageId;
    selectedCategories = hydratedState.selectedCategories;
    zcashAddress = hydratedState.zcashAddress;
    content = hydratedState.content;
    vanity = hydratedState.vanity;
    isPublished = hydratedState.isPublished;
    isSubscriberOnly = hydratedState.isSubscriberOnly;
    publishAt = hydratedState.publishAt;
    showCover = hydratedState.showCover;
    showSubtitle = hydratedState.showSubtitle;
    validationErrors = {};
    saveError = null;
    lastSavedAt = null;
    changeVersion = 0;
    savedVersion = 0;
    firstPendingChangeAt = null;
    autoSaveRetries = 0;
    clearAutoSaveTimer();
  }

  $effect(() => {
    const routeData = getRouteData();
    const nextHydrationKey = `${routeData.requestedId}:${routeData.zpage?.updated_at ?? "new"}`;

    if (nextHydrationKey === lastHydratedKey) {
      return;
    }

    lastHydratedKey = nextHydrationKey;
    applyHydratedState();
  });

  function updateEditorUrl(identifier: string) {
    if (!browser) {
      return;
    }

    const nextUrl =
      identifier === "new"
        ? "/edit"
        : `/edit?id=${encodeURIComponent(identifier)}`;
    replaceState(nextUrl, {});
  }

  function buildSavePayload() {
    return {
      // The backend requires a title, but drafts should autosave before the
      // user has typed one — fall back to a placeholder (Medium-style).
      // Publishing a real article still requires a real title.
      title: title.trim() || UNTITLED_DRAFT_TITLE,
      // Strip in-flight "Uploading image…" placeholders from the outgoing
      // payload only — local state keeps them until the upload resolves.
      content: stripUploadPlaceholders(content).trim(),
      // Keep cleared optional fields in the payload. Omitting them from a
      // PUT makes DRF preserve the previous value instead of clearing it.
      description: description.trim(),
      tags: [...selectedCategories],
      vanity: vanity.trim(),
      p2paddr: zcashAddress.trim(),
      featured_image: showCover ? coverImageId : null,
      is_published: isPublished,
      is_subscriber_only: isSubscriberOnly,
      publish_at: publishAt ? new Date(publishAt).toISOString() : null,
    } satisfies SavePayload;
  }

  function applySavedZPage(
    zpage: ZPage & { featured_image?: any },
    isClean: boolean,
  ) {
    currentZPage = zpage;
    isPublished = zpage.is_published;

    // Never write title/description/content back from the response: the user
    // may have kept typing while the request was in flight, and overwriting
    // those fields would drop keystrokes and reset the cursor.
    if (!isClean) {
      // Edits arrived mid-save — keep all local state; the rescheduled
      // autosave will sync it.
      return;
    }

    vanity = zpage.vanity || "";
    zcashAddress = zpage.p2paddr || zcashAddress;
    selectedCategories = zpage.tags ?? selectedCategories;
    isSubscriberOnly = zpage.is_subscriber_only;
    publishAt = toDatetimeLocal(zpage.publish_at);

    if (typeof zpage.featured_image === "number") {
      coverImageId = zpage.featured_image;
      showCover = true;
      return;
    }

    if (zpage.featured_image?.url || zpage.featured_image?.thumbnail) {
      coverImageId = zpage.featured_image.id;
      coverImage = resolveMediaUrl(
        zpage.featured_image.url || zpage.featured_image.thumbnail,
      );
      showCover = true;
      return;
    }

    coverImageId = null;
    coverImage = "";
    showCover = false;
  }

  function handleTitleChange() {
    validationErrors.title = undefined;

    // Keep auto-slugging the vanity from the title until a vanity has been
    // saved — untitled drafts autosave early, so "has been saved" can't be
    // inferred from currentZPage alone.
    if (title && !isPublished && !currentZPage?.vanity) {
      vanity = slugify(title);
    }

    markDirty();
  }

  function handleDescriptionChange() {
    markDirty();
  }

  function handleCoverImageChange() {
    markDirty();
  }

  function handleContentChange() {
    markDirty();
  }

  function handleMetadataChange() {
    validationErrors.vanity = undefined;

    // A description added from the publish sheet should surface the subtitle
    // in the composer and preview, which are gated on showSubtitle.
    if (description.trim()) {
      showSubtitle = true;
    }

    markDirty();
  }

  async function handleSave(options: SaveOptions = {}): Promise<boolean> {
    if (isSaving) {
      if (options.isAuto) {
        // The in-flight save reschedules on completion if changes remain.
        return false;
      }

      // Manual save / publish: wait for the in-flight save instead of
      // silently dropping the user's action.
      while (currentSavePromise) {
        await currentSavePromise;
      }
    }

    const savePromise = performSave(options);
    currentSavePromise = savePromise;

    try {
      return await savePromise;
    } finally {
      currentSavePromise = null;
    }
  }

  async function performSave(options: SaveOptions): Promise<boolean> {
    const { isAuto = false, overrides, successMessage } = options;

    if (isSaving) {
      return false;
    }

    if (!isAuto) {
      clearAutoSaveTimer();
      validationErrors = {};
      saveError = null;
    }

    // Drafts may save without a title (a placeholder is sent instead), but a
    // live article must keep a real one.
    const willBePublished = overrides?.is_published ?? isPublished;

    if (!title.trim() && willBePublished) {
      if (!isAuto) {
        validationErrors.title = "Title is required";
        toast.error("Title is required");
      }
      return false;
    }

    if (!content.trim()) {
      if (!isAuto) {
        saveError = "Content is required";
        toast.error(saveError);
      }
      return false;
    }

    if (description.trim().length > DESCRIPTION_MAX_LENGTH) {
      if (!isAuto) {
        validationErrors.description = `Description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer`;
        toast.error(validationErrors.description);
      }
      return false;
    }

    isSaving = true;
    const versionAtSaveStart = changeVersion;

    try {
      const payload = { ...buildSavePayload(), ...overrides };
      const currentIdentifier = currentZPage?.free2zaddr;
      const isCreate = !currentIdentifier;
      const saveUrl = currentIdentifier
        ? `/api/zpage/${encodeURIComponent(currentIdentifier)}/`
        : "/api/zpage/";
      const response = await apiFetch(saveUrl, {
        method: isCreate ? "POST" : "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        const vanityError = Array.isArray(result.vanity)
          ? result.vanity[0]
          : result.vanity;
        const titleError = Array.isArray(result.title)
          ? result.title[0]
          : result.title;
        validationErrors = {
          vanity: vanityError,
          title: titleError,
        };
        saveError =
          result.detail ||
          result.message ||
          result.error ||
          (vanityError || titleError
            ? "Please fix the validation errors"
            : "Failed to save article");

        if (
          response.status === 401 ||
          (response.status === 403 &&
            /authentication|credentials|session/i.test(saveError || ""))
        ) {
          goto("/?login=true");
          return false;
        }

        if (!isAuto && saveError) {
          toast.error(saveError);
        }

        if (
          isAuto &&
          response.status >= 500 &&
          autoSaveRetries < MAX_AUTOSAVE_RETRIES
        ) {
          autoSaveRetries += 1;
          scheduleAutoSave(AUTOSAVE_DELAY * 2 ** autoSaveRetries);
        }

        return false;
      }

      if (!result.free2zaddr) {
        saveError = "The API did not confirm that the article was saved.";

        if (!isAuto) {
          toast.error(saveError);
        }

        return false;
      }

      const isClean = changeVersion === versionAtSaveStart;
      const savedZPage = result as ZPage;
      const savedIdentifier = savedZPage.vanity || savedZPage.free2zaddr;

      applySavedZPage(savedZPage, isClean);
      updateEditorUrl(savedIdentifier);

      validationErrors = {};
      saveError = null;
      lastSavedAt = Date.now();
      savedVersion = versionAtSaveStart;
      autoSaveRetries = 0;

      if (!isClean) {
        scheduleAutoSave();
      }

      if (!isAuto) {
        toast.success(
          successMessage ||
            (isCreate
              ? "Article saved successfully"
              : "Article updated successfully"),
        );
      }

      return true;
    } catch (error: any) {
      saveError = error?.message || "Failed to save article";

      if (!isAuto && saveError) {
        toast.error(saveError);
      }

      if (isAuto && autoSaveRetries < MAX_AUTOSAVE_RETRIES) {
        autoSaveRetries += 1;
        scheduleAutoSave(AUTOSAVE_DELAY * 2 ** autoSaveRetries);
      }

      return false;
    } finally {
      isSaving = false;
    }
  }

  async function handlePublish(): Promise<boolean> {
    if (!title.trim()) {
      // Scheduling sends is_published=false, so guard here too — an article
      // must not go live (now or later) as "Untitled".
      validationErrors.title = "Title is required";
      toast.error("Title is required");
      return false;
    }

    const isScheduling =
      Boolean(publishAt) && new Date(publishAt).getTime() > Date.now();

    return handleSave({
      overrides: { is_published: !isScheduling },
      successMessage: isScheduling
        ? "Article scheduled — it will go live automatically 🗓️"
        : "Article published 🎉",
    });
  }

  async function handleUnpublish(): Promise<boolean> {
    return handleSave({
      overrides: { is_published: false },
      successMessage: "Article reverted to draft",
    });
  }

  async function handleManualSave(): Promise<boolean> {
    return handleSave({
      successMessage: isPublished ? "Article updated" : "Draft saved",
    });
  }

  const renderedHtml = $derived(renderMarkdown(content));

  const canFlushSave = $derived(
    Boolean(content.trim() && (title.trim() || !isPublished)),
  );

  async function navigateWithoutUnsavedGuard(destination: string) {
    bypassNextNavigationGuard = true;

    try {
      await goto(destination);
    } finally {
      // Usually the editor is destroyed by a successful navigation. Reset
      // this if navigation is rejected so later attempts remain protected.
      bypassNextNavigationGuard = false;
    }
  }

  beforeNavigate((navigation) => {
    if (bypassNextNavigationGuard) {
      return;
    }

    if (navigation.type === "leave") {
      // Tab close / hard reload: cancel() triggers the native
      // "leave site?" confirmation.
      if (isDirty || isSaving) {
        navigation.cancel();
      }
      return;
    }

    clearAutoSaveTimer();

    if (!isDirty) {
      return;
    }

    if (!isSaving && canFlushSave && navigation.to?.url) {
      navigation.cancel();

      if (pendingNavigationFlush) {
        return;
      }

      const destination = navigation.to.url.href;
      pendingNavigationFlush = true;

      void (async () => {
        const saved = await handleSave({ isAuto: true });
        pendingNavigationFlush = false;

        if (destroyed) {
          return;
        }

        if (saved && !isDirty) {
          await navigateWithoutUnsavedGuard(destination);
          return;
        }

        const confirmed = confirm(
          $t("editor.unsavedLeave", "You have unsaved changes. Leave anyway?"),
        );

        if (confirmed) {
          await navigateWithoutUnsavedGuard(destination);
        } else if (isDirty) {
          scheduleAutoSave();
        }
      })();
      return;
    }

    const confirmed = confirm(
      $t("editor.unsavedLeave", "You have unsaved changes. Leave anyway?"),
    );

    if (!confirmed) {
      navigation.cancel();
    }
  });

  onDestroy(() => {
    destroyed = true;
    clearAutoSaveTimer();
  });

  const metadataResetKey = $derived(
    currentZPage?.free2zaddr ?? getRouteData().requestedId,
  );

  const viewHref = $derived(
    currentZPage
      ? `/${getRouteData().currentUser.username}/zpage/${
          currentZPage.vanity || currentZPage.free2zaddr
        }`
      : null,
  );
</script>

<svelte:head>
  <title>{$t("editor.title", "Write Article")} - Free2Z</title>
</svelte:head>

<div class="flex min-h-[calc(100vh-4rem)] w-full flex-col bg-background">
  <EditorTopbar
    currentUser={getRouteData().currentUser}
    bind:mode
    {isSaving}
    {saveError}
    {lastSavedAt}
    {isDirty}
    {isPublished}
    {title}
    {content}
    handleSave={handleManualSave}
    bind:description
    bind:vanity
    bind:selectedCategories
    bind:zcashAddress
    bind:isSubscriberOnly
    bind:publishAt
    {validationErrors}
    resetKey={metadataResetKey}
    {viewHref}
    onMetadataChange={handleMetadataChange}
    onPublish={handlePublish}
    onUnpublish={handleUnpublish}
  />

  <div class="relative flex flex-1 flex-col lg:flex-row">
    {#if mode === "write" || mode === "split"}
      <div
        class="flex flex-col bg-background {mode === 'split'
          ? 'w-full border-b border-border lg:w-1/2 lg:border-r lg:border-b-0'
          : 'w-full'}"
      >
        <EditorComposer
          bind:title
          bind:description
          bind:coverImage
          bind:coverImageId
          bind:content
          bind:showCover
          bind:showSubtitle
          {validationErrors}
          onTitleChange={handleTitleChange}
          onDescriptionChange={handleDescriptionChange}
          onCoverImageChange={handleCoverImageChange}
          onContentChange={handleContentChange}
        />
      </div>
    {/if}

    {#if mode === "preview" || mode === "split"}
      <EditorPreview
        {title}
        {description}
        {content}
        {showCover}
        {coverImage}
        {showSubtitle}
        {mode}
        {renderedHtml}
      />
    {/if}
  </div>

  <EditorStats {content} {mode} />
</div>

<svelte:window
  onkeydown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
      event.preventDefault();
      void handleManualSave();
    }
  }}
/>

<svelte:document
  onvisibilitychange={() => {
    if (
      document.visibilityState === "hidden" &&
      isDirty &&
      !isSaving &&
      canFlushSave
    ) {
      clearAutoSaveTimer();
      void handleSave({ isAuto: true });
    }
  }}
/>
