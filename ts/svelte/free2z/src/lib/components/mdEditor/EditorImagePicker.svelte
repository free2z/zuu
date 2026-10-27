<script lang="ts">
  import * as env from "$app/env/public";
  import { onDestroy, onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tabs from "$lib/components/ui/tabs";
  import {
    VIDEO_ACCEPT,
    supportedVideo,
    supportedVideoFile,
  } from "./videoMedia";
  import { videoPickerCopy } from "./videoPickerCopy";
  import type { TranslationFunction } from "$lib/i18n";
  import { tStore as t } from "$lib/i18n";
  import {
    ClipboardPaste,
    ImagePlus,
    Images,
    LayoutGrid,
    List,
    Loader2,
    RefreshCw,
    Search,
    UploadCloud,
    Video,
    X,
  } from "@lucide/svelte";
  import { toast, captureAccountToast } from "$lib/toast.js";
  import { apiFetch } from "$lib/api/config";
  import MediaAccessBadge from "$lib/components/media/MediaAccessBadge.svelte";
  import {
    requiredAccessForSlot,
    satisfiesSlot,
    type MediaAccess,
    type MediaSlotContext,
  } from "$lib/components/media/mediaAccess";
  import {
    promoteMediaAccess,
    readCurrentUpload,
  } from "$lib/components/media/promoteMediaAccess";
  import type { CoverLibraryImage, CoverLibraryResponse } from "./coverTypes";
  import { appendMediaPage } from "./mediaLibrary.js";

  interface Props {
    mediaType?: "image" | "video";
    onChooseCloudImage: (item: CoverLibraryImage) => void | Promise<void>;
    /** Resolving `false` means "refused": the picker stays open. */
    onUploadLocalImages: (
      files: File[],
    ) => void | boolean | Promise<void | boolean>;
    /**
     * `zPage.is_subscriber_only`. It widens what the body accepts rather than
     * narrowing it: the body of a subscriber-only page is already redacted for
     * non-subscribers, so a `members` image in it is correct. See
     * `mediaAccess.ts`.
     */
    subscriberOnly?: boolean;
    /**
     * Which slot the chosen image goes into. `post` (a Converse post or
     * reply) is public-only whatever `subscriberOnly` says — see
     * `mediaAccess.ts`.
     */
    accessSlot?: "body" | "post";
    /** Public uploads are disabled for members-only Converse replies. */
    localUploadsAllowed?: boolean;
    /**
     * Refresh the audience (`accessSlot`/`subscriberOnly`) before a saved
     * image's required tier is judged or promoted. Resolves `false` when the
     * audience could not be confirmed; the choice is then refused. Without
     * it a stale public slot asks to make a paid `members` image PUBLIC on a
     * page that has since gone subscribers-only.
     */
    beforeChooseCloudImage?: () => Promise<boolean>;
  }

  type LocalImage = {
    id: string;
    file: File;
    previewUrl: string;
  };

  type CloudView = "grid" | "list";

  let {
    onChooseCloudImage,
    onUploadLocalImages,
    mediaType = "image",
    subscriberOnly = false,
    accessSlot = "body",
    localUploadsAllowed = true,
    beforeChooseCloudImage,
  }: Props = $props();

  const PickerIcon = $derived(mediaType === "video" ? Video : ImagePlus);
  const LibraryIcon = $derived(mediaType === "video" ? Video : Images);
  const mimePrefix = $derived(`${mediaType}/`);
  const translate: TranslationFunction = (key, fallback, params) =>
    mediaType === "video" && videoPickerCopy[key]
      ? $t(
          key.replace("editor.", "editor.videoPicker."),
          videoPickerCopy[key],
          params,
        )
      : $t(key, fallback, params);

  const slotContext = $derived<MediaSlotContext>({
    slot: accessSlot,
    subscriberOnly,
  });

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";
  const CLOUD_SEARCH_DELAY = 250;

  let open = $state(false);
  let tab = $state("device");
  let localFiles = $state<LocalImage[]>([]);
  let localSearch = $state("");
  let localDragActive = $state(false);
  let cloudItems = $state<CoverLibraryImage[]>([]);
  let cloudPage = $state(1);
  let cloudHasNext = $state(false);
  let cloudLoading = $state(false);
  let cloudLoadingMore = $state(false);
  let cloudError = $state("");
  let choosingCloudImageId = $state<number | null>(null);
  let cloudSearch = $state("");
  let cloudView = $state<CloudView>("grid");
  let cloudViewChosen = false;
  let cloudSearchTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastCloudSearch = "";
  let cloudRequestId = 0;
  let localInputRef = $state<HTMLInputElement | null>(null);
  let localImageSequence = 0;
  /**
   * The image the creator clicked that their readers could not open, held
   * while they decide. Nothing is inserted and nothing is PATCHed until they
   * answer — the whole point is that neither refusing silently nor proceeding
   * silently is acceptable.
   */
  let pendingItem = $state<CoverLibraryImage | null>(null);
  let pendingAccess = $state<MediaAccess | null>(null);
  let promoting = $state(false);
  /**
   * Generation counter for the pre-insert access check. Bumped on every pick
   * and on every close, so an in-flight check whose picker has moved on
   * resolves into nothing instead of inserting into an article the creator
   * already left.
   */
  let chooseRequestId = 0;

  const filteredLocalFiles = $derived(
    localFiles.filter((image) =>
      image.file.name.toLowerCase().includes(localSearch.trim().toLowerCase()),
    ),
  );

  function buildMediaUrl(path?: string | null) {
    if (!path) {
      return "";
    }

    if (/^https?:\/\//i.test(path) || !apiBase) {
      return path;
    }

    return `${apiBase}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  function imageFilesFromList(files: FileList | File[]) {
    return Array.from(files).filter((file) =>
      mediaType === "video"
        ? supportedVideoFile(file.type, file.name)
        : file.type.startsWith(mimePrefix),
    );
  }

  function imageFilesFromClipboard(clipboardData: DataTransfer | null) {
    if (!clipboardData) {
      return [];
    }

    const clipboardFiles = imageFilesFromList(clipboardData.files);

    if (clipboardFiles.length) {
      return clipboardFiles;
    }

    return Array.from(clipboardData.items)
      .filter(
        (item) =>
          item.kind === "file" &&
          (mediaType === "video" || item.type.startsWith(mimePrefix)),
      )
      .map((item) => item.getAsFile())
      .filter(
        (file): file is File =>
          file !== null &&
          (mediaType !== "video" || supportedVideoFile(file.type, file.name)),
      );
  }

  function chooseCloudView(view: CloudView) {
    cloudViewChosen = true;
    cloudView = view;
  }

  function createLocalImage(file: File): LocalImage {
    localImageSequence += 1;

    return {
      id: `${file.name}-${file.lastModified}-${localImageSequence}`,
      file,
      previewUrl: URL.createObjectURL(file),
    };
  }

  function clearLocalFiles() {
    localFiles.forEach((image) => URL.revokeObjectURL(image.previewUrl));
    localFiles = [];
  }

  function closePicker() {
    open = false;
    chooseRequestId += 1;
    choosingCloudImageId = null;
    clearLocalFiles();
    localSearch = "";
    localDragActive = false;
    pendingItem = null;
    pendingAccess = null;
  }

  function addLocalFiles(files: FileList | File[]) {
    if (!localUploadsAllowed) {
      return;
    }

    const images = imageFilesFromList(files);

    if (!images.length) {
      return;
    }

    localFiles = [...localFiles, ...images.map(createLocalImage)];
  }

  function removeLocalFile(imageToRemove: LocalImage) {
    URL.revokeObjectURL(imageToRemove.previewUrl);
    localFiles = localFiles.filter((image) => image !== imageToRemove);
  }

  function handleLocalInputChange(
    event: Event & { currentTarget: EventTarget & HTMLInputElement },
  ) {
    addLocalFiles(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
  }

  function handleLocalDrag(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();

    if (event.type === "dragenter" || event.type === "dragover") {
      localDragActive = true;
      return;
    }

    if (event.type === "dragleave") {
      const nextTarget = event.relatedTarget;
      const dropArea = event.currentTarget as HTMLElement;

      if (nextTarget instanceof Node && dropArea.contains(nextTarget)) {
        return;
      }

      localDragActive = false;
    }
  }

  function handleLocalDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    localDragActive = false;
    if (!localUploadsAllowed) {
      return;
    }
    addLocalFiles(event.dataTransfer?.files ?? []);
  }

  function handleLocalPaste(event: ClipboardEvent) {
    if (!open || tab !== "device" || !localUploadsAllowed) {
      return;
    }

    const images = imageFilesFromClipboard(event.clipboardData);

    if (!images.length) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    localDragActive = false;
    addLocalFiles(images);
  }

  async function uploadLocalFiles(images: LocalImage[]) {
    if (!images.length) {
      return;
    }

    const accepted = await onUploadLocalImages(
      images.map((image) => image.file),
    );
    if (accepted === false) return;
    closePicker();
  }

  function imageName(item: CoverLibraryImage) {
    return (
      item.title ||
      item.name ||
      translate("editor.imageFallback", "Image {id}", { id: item.id })
    );
  }

  async function insertCloudItem(item: CoverLibraryImage) {
    const operationNotice = captureAccountToast();
    choosingCloudImageId = item.id;

    try {
      await onChooseCloudImage(item);
      closePicker();
    } catch (error: any) {
      operationNotice.error(
        error?.message ||
          translate(
            "editor.cloudImageOpenFailed",
            "Unable to open that image.",
          ),
      );
    } finally {
      choosingCloudImageId = null;
    }
  }

  /**
   * Everything the creator can see renders; the gate is on INSERT, not on the
   * query. Filtering the list would hide a `members` image that a
   * subscribers-only page is perfectly entitled to use — the mistake the old
   * React picker made with its hardcoded `access=public`.
   */
  async function chooseCloudImage(item: CoverLibraryImage) {
    const operationNotice = captureAccountToast();
    // Decide from the server, not from the list. The list is a snapshot, and
    // an image demoted in another tab since it was fetched keeps the SAME URL
    // (`private` and `members` share a prefix) — so nothing about the markdown
    // would look wrong while every reader got a 401.
    const chooseId = ++chooseRequestId;
    choosingCloudImageId = item.id;

    if (!(await refreshAudience())) {
      if (chooseId !== chooseRequestId || !open) return;
      choosingCloudImageId = null;
      return;
    }
    if (chooseId !== chooseRequestId || !open) return;

    const current = await readCurrentUpload<CoverLibraryImage>({
      id: item.id,
      request: apiFetch,
      apiBase,
    });

    // The creator can close the picker, or pick something else, while this is
    // in flight. Inserting anyway puts an image into an article they walked
    // away from — and, if they switched translations in the meantime, into a
    // DIFFERENT article than the one the click happened in.
    if (chooseId !== chooseRequestId || !open) return;

    choosingCloudImageId = null;

    // Falling back to the snapshot would defeat the gate in exactly the
    // conditions it matters — a stale `members` record inserted into a
    // subscribers-only page after the file went private renders for the owner
    // and 401s for every subscriber, and the publish-sheet hint stays quiet
    // because that page IS subscribers-only. A refused click is recoverable;
    // this is not.
    if (
      !current ||
      !current.mime_type?.startsWith(mimePrefix) ||
      (mediaType === "video" && !supportedVideo(current.mime_type, current.url))
    ) {
      operationNotice.error(
        translate(
          "editor.imageAccessCheckFailed",
          "Could not check who can open that image. Please try again.",
        ),
      );
      return;
    }

    cloudItems = cloudItems.map((entry) =>
      entry.id === current.id ? current : entry,
    );

    const needed = requiredAccessForSlot(current.access, slotContext);

    if (!needed) {
      return insertCloudItem(current);
    }

    pendingItem = current;
    pendingAccess = needed;
  }

  /** `beforeChooseCloudImage`, with a refusal toast when it fails. */
  async function refreshAudience() {
    const operationNotice = captureAccountToast();
    if (!beforeChooseCloudImage) return true;
    let ok = false;
    try {
      ok = await beforeChooseCloudImage();
    } catch {
      ok = false;
    }
    if (!ok && open) {
      operationNotice.error(
        translate(
          "editor.imageAccessCheckFailed",
          "Could not check who can open that image. Please try again.",
        ),
      );
    }
    return ok;
  }

  function cancelPromotion() {
    pendingItem = null;
    pendingAccess = null;
  }

  async function confirmPromotion() {
    const operationNotice = captureAccountToast();
    const item = pendingItem;
    const access = pendingAccess;

    if (!item || !access || promoting) {
      return;
    }

    promoting = true;

    try {
      // The consent dialog can sit open while the page's tier changes. Judge
      // the PATCH against the refreshed audience: if the tier this dialog
      // asked for is no longer the least that works, start the choice over
      // (server re-read, then insert or re-ask) instead of widening the file
      // to a stale tier.
      if (!(await refreshAudience())) return;
      if (pendingItem !== item || !open) return;
      if (requiredAccessForSlot(item.access, slotContext) !== access) {
        pendingItem = null;
        pendingAccess = null;
        await chooseCloudImage(item);
        return;
      }

      // `promoteMediaAccess` returns the server's re-serialized object and
      // nothing else. That is load-bearing: `_get_prefix()` derives the URL
      // from the access level, so `item.url` is stale the instant this
      // succeeds, and inserting it would ship exactly the broken image this
      // dialog exists to prevent.
      const updated = await promoteMediaAccess({
        item,
        access,
        request: apiFetch,
        apiBase,
        // Checked against the server's CURRENT object, not this list's
        // snapshot: a file made public in another tab must not be PATCHed
        // down to `members` because the picker still remembers it as private.
        satisfies: (candidate) => satisfiesSlot(candidate.access, slotContext),
      });

      cloudItems = cloudItems.map((entry) =>
        entry.id === updated.id ? updated : entry,
      );
      pendingItem = null;
      pendingAccess = null;
      await insertCloudItem(updated);
    } catch (error: any) {
      // An indeterminate result is NOT "nothing happened": the file may now be
      // public. Re-read the library so the badge shows what is actually true,
      // and say that rather than "it failed".
      if (error?.indeterminate) {
        pendingItem = null;
        pendingAccess = null;
        void loadCloud(true);
        operationNotice.error(
          translate(
            "editor.imageAccessChangeUnknown",
            "We could not confirm that change. Your library has been reloaded — check who can see the image before you publish.",
          ),
        );
        return;
      }

      operationNotice.error(
        error?.message ||
          translate(
            "editor.imageAccessChangeFailed",
            "Could not change who can see that image.",
          ),
      );
    } finally {
      promoting = false;
    }
  }

  async function loadCloud(reset = false) {
    if (!reset && (cloudLoading || cloudLoadingMore)) {
      return;
    }

    const requestId = ++cloudRequestId;
    const nextPage = reset ? 1 : cloudPage;
    const params = new URLSearchParams({
      page: String(nextPage),
      mime_type: mimePrefix,
    });
    const searchTerm = cloudSearch.trim();

    if (searchTerm) {
      params.set("search", searchTerm);
    }

    if (reset) {
      cloudLoading = true;
      cloudLoadingMore = false;
      cloudPage = 1;
      cloudError = "";
    } else {
      cloudLoadingMore = true;
    }

    try {
      const response = await fetch(`${apiBase}/api/myuploads/?${params}`, {
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(
          translate(
            "editor.cloudImagesLoadFailed",
            "Failed to load your cloud.",
          ),
        );
      }

      const data = (await response.json()) as CoverLibraryResponse;

      if (requestId !== cloudRequestId) {
        return;
      }

      const nextItems = (data.results ?? []).filter(
        (item) =>
          item.mime_type?.startsWith(mimePrefix) &&
          (mediaType !== "video" || supportedVideo(item.mime_type, item.url)),
      );

      cloudItems = reset ? nextItems : appendMediaPage(cloudItems, nextItems);
      cloudHasNext = Boolean(data.next);
      cloudPage = nextPage + 1;
      cloudError = "";
    } catch (error: any) {
      if (requestId === cloudRequestId) {
        cloudError =
          error?.message ||
          translate(
            "editor.cloudImagesLoadFailed",
            "Failed to load your cloud.",
          );
      }
    } finally {
      if (requestId === cloudRequestId) {
        cloudLoading = false;
        cloudLoadingMore = false;
      }
    }
  }

  function scheduleCloudSearch() {
    if (cloudSearchTimeout) {
      clearTimeout(cloudSearchTimeout);
    }

    cloudSearchTimeout = setTimeout(() => {
      cloudSearchTimeout = null;
      void loadCloud(true);
    }, CLOUD_SEARCH_DELAY);
  }

  function handleOpenChange(nextOpen: boolean) {
    open = nextOpen;

    if (!nextOpen) {
      chooseRequestId += 1;
      choosingCloudImageId = null;
      clearLocalFiles();
      localSearch = "";
      localDragActive = false;
      pendingItem = null;
      pendingAccess = null;
      return;
    }

    if (nextOpen && tab === "cloud" && !cloudItems.length && !cloudLoading) {
      void loadCloud(true);
    }
  }

  export function openPicker(defaultTab: "device" | "cloud" = "device") {
    tab =
      !localUploadsAllowed && defaultTab === "device" ? "cloud" : defaultTab;
    open = true;

    if (defaultTab === "cloud" && !cloudItems.length && !cloudLoading) {
      void loadCloud(true);
    }
  }

  $effect(() => {
    if (!localUploadsAllowed && tab === "device") {
      tab = "cloud";
      clearLocalFiles();
      localSearch = "";
      localDragActive = false;
    }

    if (open && tab === "cloud" && !cloudItems.length && !cloudLoading) {
      void loadCloud(true);
    }
  });

  onMount(() => {
    const mobileQuery = window.matchMedia("(max-width: 639px)");
    const applyResponsiveDefault = () => {
      if (!cloudViewChosen) {
        cloudView = mobileQuery.matches ? "list" : "grid";
      }
    };

    applyResponsiveDefault();
    mobileQuery.addEventListener("change", applyResponsiveDefault);

    return () => {
      mobileQuery.removeEventListener("change", applyResponsiveDefault);
    };
  });

  $effect(() => {
    cloudSearch;

    if (open && tab === "cloud") {
      if (cloudSearch === lastCloudSearch) {
        return;
      }

      lastCloudSearch = cloudSearch;
      scheduleCloudSearch();
    }
  });

  onDestroy(() => {
    if (cloudSearchTimeout) {
      clearTimeout(cloudSearchTimeout);
    }
    cloudRequestId += 1;
    clearLocalFiles();
  });
</script>

<svelte:window onpaste={handleLocalPaste} />

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <!-- The slot this picker enforces, on the element: the only place a browser
       test can see which rule a host actually wired in. -->
  <Dialog.Content
    class="flex h-[calc(100dvh-2rem)] max-h-[720px] flex-col overflow-hidden p-4 sm:max-w-[780px] sm:p-6"
    data-media-access-slot={slotContext.slot}
    data-subscriber-only={slotContext.subscriberOnly ? "true" : "false"}
  >
    <Dialog.Header class="shrink-0 pr-6">
      <Dialog.Title>{translate("editor.addImage", "Add Image")}</Dialog.Title>
      <Dialog.Description>
        {translate(
          "editor.imageDialogDescription",
          "Upload from this device or choose an image already saved in your Free2Z cloud.",
        )}
      </Dialog.Description>
    </Dialog.Header>

    <Tabs.Root bind:value={tab} class="min-h-0 flex-1 gap-4 overflow-hidden">
      <Tabs.List class="shrink-0">
        {#if localUploadsAllowed}
          <Tabs.Trigger value="device">
            <UploadCloud class="h-4 w-4" />
            {translate("editor.deviceImagesTab", "Device")}
          </Tabs.Trigger>
        {/if}
        <Tabs.Trigger value="cloud">
          <LibraryIcon class="h-4 w-4" />
          {translate("editor.libraryTab", "Your Cloud")}
        </Tabs.Trigger>
      </Tabs.List>

      {#if localUploadsAllowed}
        <Tabs.Content
          value="device"
          class="flex min-h-0 flex-col overflow-hidden"
          ondragenter={handleLocalDrag}
          ondragover={handleLocalDrag}
          ondragleave={handleLocalDrag}
          ondrop={handleLocalDrop}
        >
          <input
            bind:this={localInputRef}
            type="file"
            accept={mediaType === "video" ? VIDEO_ACCEPT : "image/*"}
            multiple
            class="hidden"
            onchange={handleLocalInputChange}
          />

          <div
            class={`relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border transition-all duration-200 ${
              localDragActive
                ? "border-primary bg-primary/8 shadow-[inset_0_0_0_1px_var(--color-primary)]"
                : "border-border/60 bg-gradient-to-b from-muted/25 to-muted/10"
            }`}
            role="region"
            aria-label={translate(
              "editor.deviceImageDropzone",
              "Select device images",
            )}
            data-drag-active={localDragActive}
          >
            {#if localDragActive}
              <div
                class="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/70 bg-background/92 p-6 text-center backdrop-blur-sm"
              >
                <div class="flex flex-col items-center gap-4">
                  <div
                    class="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20"
                  >
                    <UploadCloud class="h-7 w-7" />
                  </div>
                  <div class="space-y-1">
                    <p class="text-lg font-semibold text-foreground">
                      {translate(
                        "editor.dropImagesNow",
                        "Drop images to add them",
                      )}
                    </p>
                    <p class="text-sm text-muted-foreground">
                      {translate(
                        "editor.dropImagesMultipleHint",
                        "You can add multiple images at once.",
                      )}
                    </p>
                  </div>
                </div>
              </div>
            {:else if !localFiles.length}
              <div
                class="flex min-h-[280px] flex-1 items-center justify-center p-6 sm:p-10"
              >
                <div
                  class="mx-auto flex max-w-md flex-col items-center text-center"
                >
                  <div
                    class="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border bg-background text-primary shadow-sm ring-4 ring-primary/5"
                  >
                    <UploadCloud class="h-7 w-7" />
                  </div>
                  <div class="space-y-2">
                    <h3 class="text-base font-semibold text-foreground">
                      {translate(
                        "editor.dropImagesTitle",
                        "Drop images anywhere here",
                      )}
                    </h3>
                    <p class="text-sm leading-relaxed text-muted-foreground">
                      {translate(
                        "editor.dropImagesDescription",
                        "Drag and drop, paste from your clipboard, or choose files from your device.",
                      )}
                    </p>
                  </div>
                  <Button class="mt-5" onclick={() => localInputRef?.click()}>
                    <PickerIcon class="h-4 w-4" />
                    {translate("editor.selectImages", "Select Images")}
                  </Button>
                  <div
                    class="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground/80"
                  >
                    <span>
                      {translate(
                        "editor.imageFileHint",
                        "Images only · Multiple files supported",
                      )}
                    </span>
                    <span
                      class="hidden text-border sm:inline"
                      aria-hidden="true">·</span
                    >
                    <span class="inline-flex items-center gap-1.5">
                      <ClipboardPaste class="h-3.5 w-3.5" />
                      {translate(
                        "editor.pasteImageHint",
                        "Paste with ⌘/Ctrl + V",
                      )}
                    </span>
                  </div>
                </div>
              </div>
            {:else}
              <div
                class="flex shrink-0 items-center gap-2 border-b bg-background/60 p-2.5 sm:p-3"
              >
                <div class="relative min-w-0 flex-1">
                  <Search
                    class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    type="search"
                    bind:value={localSearch}
                    placeholder={translate(
                      "editor.searchSelectedImages",
                      "Search selected images",
                    )}
                    class="bg-background pl-9"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  class="shrink-0"
                  aria-label={translate(
                    "editor.addMoreImages",
                    "Add more images",
                  )}
                  title={translate("editor.addMoreImages", "Add more images")}
                  onclick={() => localInputRef?.click()}
                >
                  <PickerIcon class="h-4 w-4" />
                </Button>
              </div>

              {#if filteredLocalFiles.length}
                <div
                  class="grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-2 overflow-y-auto overscroll-contain p-2 sm:grid-cols-2 sm:p-3"
                >
                  {#each filteredLocalFiles as image (image.id)}
                    <div
                      class="flex min-w-0 items-center gap-3 rounded-xl border bg-card p-2 shadow-xs"
                    >
                      {#if mediaType === "video"}
                        <video
                          src={image.previewUrl}
                          muted
                          playsinline
                          preload="metadata"
                          aria-label={image.file.name}
                          class="h-14 w-14 shrink-0 rounded-lg bg-muted object-cover"
                        ></video>
                      {:else}
                        <img
                          src={image.previewUrl}
                          alt={image.file.name}
                          class="h-14 w-14 shrink-0 rounded-lg bg-muted object-cover"
                        />
                      {/if}
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-sm font-medium text-foreground">
                          {image.file.name}
                        </p>
                        <p class="truncate text-xs text-muted-foreground">
                          {image.file.type}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        class="shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={translate(
                          "editor.removeImage",
                          "Remove image",
                        )}
                        onclick={() => removeLocalFile(image)}
                      >
                        <X class="h-4 w-4" />
                      </Button>
                    </div>
                  {/each}
                </div>
              {:else}
                <div
                  class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
                  role="status"
                >
                  <Search class="h-6 w-6 text-muted-foreground/50" />
                  <p class="text-sm font-medium text-foreground">
                    {translate(
                      "editor.noSelectedImagesFound",
                      "No matching images",
                    )}
                  </p>
                  <p class="text-xs text-muted-foreground">
                    {translate(
                      "editor.tryAnotherImageSearch",
                      "Try a different search term.",
                    )}
                  </p>
                </div>
              {/if}

              <div
                class="flex shrink-0 items-center justify-between gap-3 border-t bg-background/75 px-3 py-2.5 sm:px-4"
              >
                <p
                  class="text-xs font-medium text-muted-foreground"
                  aria-live="polite"
                >
                  {localFiles.length}
                  {localFiles.length === 1
                    ? translate("editor.imageSelected", "image selected")
                    : translate("editor.imagesSelected", "images selected")}
                </p>
                <Button
                  size="sm"
                  onclick={() => void uploadLocalFiles(localFiles)}
                  disabled={!localFiles.length}
                >
                  <UploadCloud class="h-4 w-4" />
                  {translate("editor.insertSelectedImages", "Insert Selected")}
                </Button>
              </div>
            {/if}
          </div>
        </Tabs.Content>
      {/if}

      <Tabs.Content
        value="cloud"
        class="flex min-h-0 flex-col gap-4 overflow-hidden"
      >
        <div class="flex shrink-0 items-center gap-2">
          <div class="relative min-w-0 flex-1">
            <Search
              class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              bind:value={cloudSearch}
              placeholder={translate(
                "editor.searchCloudImages",
                "Search Free2Z cloud",
              )}
              class="pl-9"
            />
          </div>
          <div
            class="flex shrink-0 items-center rounded-md border bg-muted/40 p-0.5"
            role="group"
            aria-label={translate("editor.libraryView", "Library view")}
          >
            <Button
              type="button"
              variant={cloudView === "grid" ? "secondary" : "ghost"}
              size="icon-sm"
              class="h-8 w-8"
              aria-label={translate("editor.gridView", "Grid view")}
              aria-pressed={cloudView === "grid"}
              title={translate("editor.gridView", "Grid view")}
              onclick={() => chooseCloudView("grid")}
            >
              <LayoutGrid class="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant={cloudView === "list" ? "secondary" : "ghost"}
              size="icon-sm"
              class="h-8 w-8"
              aria-label={translate("editor.listView", "List view")}
              aria-pressed={cloudView === "list"}
              title={translate("editor.listView", "List view")}
              onclick={() => chooseCloudView("list")}
            >
              <List class="h-4 w-4" />
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            class="h-9 w-9 shrink-0"
            aria-label={translate("editor.refreshLibrary", "Refresh")}
            title={translate("editor.refreshLibrary", "Refresh")}
            onclick={() => void loadCloud(true)}
            disabled={cloudLoading}
          >
            {#if cloudLoading}
              <Loader2 class="h-4 w-4 animate-spin" />
            {:else}
              <RefreshCw class="h-4 w-4" />
            {/if}
          </Button>
        </div>

        <div
          class="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-xl border bg-muted/10 p-2 sm:p-3"
          data-media-results
          role="region"
          aria-label={translate(
            "editor.cloudImageResults",
            "Uploaded image results",
          )}
          aria-busy={cloudLoading || cloudLoadingMore}
        >
          {#if cloudLoading && !cloudItems.length}
            <p class="sr-only" role="status">
              {translate("editor.loadingLibrary", "Loading uploaded images…")}
            </p>
            <div
              class={cloudView === "grid"
                ? "grid grid-cols-2 gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3"
                : "flex flex-col gap-2"}
            >
              {#each Array.from({ length: 6 }) as _, index (index)}
                <div
                  class={`overflow-hidden rounded-lg border bg-card ${cloudView === "list" ? "flex items-center" : ""}`}
                >
                  <div
                    class={`${cloudView === "list" ? "h-20 w-24 shrink-0" : "aspect-square sm:aspect-[4/3]"} animate-pulse bg-muted`}
                  ></div>
                  <div
                    class={`${cloudView === "list" ? "min-w-0 flex-1" : ""} space-y-2 p-3`}
                  >
                    <div class="h-3 animate-pulse rounded bg-muted"></div>
                    <div class="h-3 w-2/3 animate-pulse rounded bg-muted"></div>
                  </div>
                </div>
              {/each}
            </div>
          {:else if cloudError && !cloudItems.length}
            <div
              class="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-6 text-center text-sm text-destructive"
              role="alert"
            >
              <p>{cloudError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onclick={() => void loadCloud(true)}
              >
                <RefreshCw class="h-4 w-4" />
                {translate("editor.retryLibrary", "Try Again")}
              </Button>
            </div>
          {:else if !cloudItems.length}
            <div
              class="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-border/50 px-4 py-12 text-center text-sm text-muted-foreground"
              role="status"
            >
              {translate(
                "editor.libraryEmpty",
                "You do not have any uploaded images yet.",
              )}
            </div>
          {:else}
            {#if cloudError}
              <div
                class="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                role="alert"
              >
                {cloudError}
              </div>
            {/if}

            <div
              class={cloudView === "grid"
                ? "grid grid-cols-2 gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3"
                : "flex flex-col gap-2"}
            >
              {#each cloudItems as item (item.id)}
                <button
                  type="button"
                  class={`group relative overflow-hidden rounded-lg border bg-card text-left transition hover:border-primary/35 hover:shadow-md ${cloudView === "list" ? "flex min-h-20 items-center" : ""}`}
                  onclick={() => void chooseCloudImage(item)}
                  disabled={choosingCloudImageId !== null}
                >
                  <div
                    class={`${cloudView === "list" ? "h-20 w-24 shrink-0 sm:h-24 sm:w-32" : "aspect-square sm:aspect-[4/3]"} overflow-hidden bg-muted`}
                  >
                    {#if mediaType === "video" && !item.thumbnail}
                      <video
                        src={buildMediaUrl(item.url)}
                        muted
                        playsinline
                        preload="metadata"
                        aria-label={item.title ||
                          item.name ||
                          translate(
                            "editor.cloudImageAlt",
                            "Image from your cloud",
                          )}
                        class="h-full w-full object-cover"
                      ></video>
                    {:else}
                      <img
                        src={buildMediaUrl(item.thumbnail || item.url)}
                        alt={item.title ||
                          item.name ||
                          translate(
                            "editor.cloudImageAlt",
                            "Image from your cloud",
                          )}
                        class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                        loading="lazy"
                      />
                    {/if}
                  </div>
                  <div
                    class={`${cloudView === "list" ? "min-w-0 flex-1" : ""} space-y-1 p-2.5 sm:p-3`}
                  >
                    <p class="truncate text-sm font-medium text-foreground">
                      {imageName(item)}
                    </p>
                    <!-- Who can open this file, on every row, before the
                         creator commits to it — not only in the dialog that
                         appears when they pick a broken one. -->
                    <div class="flex min-w-0 items-center gap-1.5">
                      <MediaAccessBadge access={item.access} />
                      <span
                        class={`truncate text-xs text-muted-foreground ${cloudView === "grid" ? "hidden sm:block" : ""}`}
                      >
                        {item.mime_type}
                      </span>
                    </div>
                  </div>
                  {#if choosingCloudImageId === item.id}
                    <div
                      class="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[2px]"
                    >
                      <Loader2 class="h-5 w-5 animate-spin text-primary" />
                    </div>
                  {/if}
                </button>
              {/each}
            </div>

            {#if cloudHasNext}
              <div class="flex justify-center pt-4 pb-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onclick={() => void loadCloud(false)}
                  disabled={cloudLoadingMore}
                >
                  {#if cloudLoadingMore}
                    <Loader2 class="h-4 w-4 animate-spin" />
                  {/if}
                  {translate("editor.loadMoreImages", "Load More")}
                </Button>
              </div>
            {/if}
          {/if}
        </div>
      </Tabs.Content>
    </Tabs.Root>

    <!--
      The insert gate. It covers the dialog rather than replacing the results
      so the creator keeps their place in the library when they cancel, and it
      is INSIDE Dialog.Content so the dialog's own focus trap and Escape
      handling still apply — a second nested Dialog.Root would fight both.
    -->
    {#if pendingItem && pendingAccess}
      <div
        class="absolute inset-0 z-30 flex items-center justify-center bg-background/92 p-4 backdrop-blur-[2px] sm:p-6"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="image-access-gate-title"
        data-media-access-gate={pendingAccess}
      >
        <div class="w-full max-w-md space-y-4">
          <div class="space-y-2">
            <h3
              id="image-access-gate-title"
              class="text-base font-semibold text-foreground"
            >
              {translate(
                "editor.imageAccessTitle",
                "Your readers would not see this image",
              )}
            </h3>
            <p class="text-sm leading-relaxed text-muted-foreground">
              {pendingAccess === "members"
                ? translate(
                    "editor.imageAccessMakeMembersBody",
                    "“{name}” is private, so not even your subscribers can open it. Sharing it with subscribers matches the rest of this page — everyone who has subscribed sees it, and nobody else does.",
                    { name: imageName(pendingItem) },
                  )
                : translate(
                    "editor.imageAccessMakePublicBody",
                    "“{name}” is not public, so everyone reading this page would get a broken image. Making it public lets anyone who opens the page — or the link — see it.",
                    { name: imageName(pendingItem) },
                  )}
            </p>
          </div>

          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{translate("editor.imageAccessCurrent", "Right now:")}</span>
            <MediaAccessBadge access={pendingItem.access} />
          </div>

          <div class="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              data-media-access-gate-action="cancel"
              onclick={cancelPromotion}
              disabled={promoting}
            >
              {translate("common.cancel", "Cancel")}
            </Button>
            <Button
              type="button"
              data-media-access-gate-action="promote"
              onclick={() => void confirmPromotion()}
              disabled={promoting}
            >
              {#if promoting}
                <Loader2 class="h-4 w-4 animate-spin" />
              {/if}
              {pendingAccess === "members"
                ? translate(
                    "editor.imageAccessMakeMembers",
                    "Share with subscribers",
                  )
                : translate("editor.imageAccessMakePublic", "Make it public")}
            </Button>
          </div>
        </div>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
