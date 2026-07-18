<script lang="ts">
  import { env } from "$env/dynamic/public";
  import { onDestroy, onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tabs from "$lib/components/ui/tabs";
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
    X,
  } from "@lucide/svelte";
  import { toast } from "svelte-sonner";
  import type { CoverLibraryImage, CoverLibraryResponse } from "./coverTypes";
  import { appendMediaPage } from "./mediaLibrary.js";

  interface Props {
    onChooseCloudImage: (item: CoverLibraryImage) => void | Promise<void>;
    onUploadLocalImages: (files: File[]) => void | Promise<void>;
  }

  type LocalImage = {
    id: string;
    file: File;
    previewUrl: string;
  };

  type CloudView = "grid" | "list";

  let { onChooseCloudImage, onUploadLocalImages }: Props = $props();

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
    return Array.from(files).filter((file) => file.type.startsWith("image/"));
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
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
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
    clearLocalFiles();
    localSearch = "";
    localDragActive = false;
  }

  function addLocalFiles(files: FileList | File[]) {
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
    addLocalFiles(event.dataTransfer?.files ?? []);
  }

  function handleLocalPaste(event: ClipboardEvent) {
    if (!open || tab !== "device") {
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

    await onUploadLocalImages(images.map((image) => image.file));
    closePicker();
  }

  async function chooseCloudImage(item: CoverLibraryImage) {
    choosingCloudImageId = item.id;

    try {
      await onChooseCloudImage(item);
      closePicker();
    } catch (error: any) {
      toast.error(
        error?.message ||
          $t("editor.cloudImageOpenFailed", "Unable to open that image."),
      );
    } finally {
      choosingCloudImageId = null;
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
      mime_type: "image/",
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
          $t("editor.cloudImagesLoadFailed", "Failed to load your cloud."),
        );
      }

      const data = (await response.json()) as CoverLibraryResponse;

      if (requestId !== cloudRequestId) {
        return;
      }

      const nextItems = (data.results ?? []).filter((item) =>
        item.mime_type?.startsWith("image/"),
      );

      cloudItems = reset ? nextItems : appendMediaPage(cloudItems, nextItems);
      cloudHasNext = Boolean(data.next);
      cloudPage = nextPage + 1;
      cloudError = "";
    } catch (error: any) {
      if (requestId === cloudRequestId) {
        cloudError =
          error?.message ||
          $t("editor.cloudImagesLoadFailed", "Failed to load your cloud.");
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
      clearLocalFiles();
      localSearch = "";
      localDragActive = false;
      return;
    }

    if (nextOpen && tab === "cloud" && !cloudItems.length && !cloudLoading) {
      void loadCloud(true);
    }
  }

  export function openPicker(defaultTab: "device" | "cloud" = "device") {
    tab = defaultTab;
    open = true;

    if (defaultTab === "cloud" && !cloudItems.length && !cloudLoading) {
      void loadCloud(true);
    }
  }

  $effect(() => {
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
  <Dialog.Content
    class="flex h-[calc(100dvh-2rem)] max-h-[720px] flex-col overflow-hidden p-4 sm:max-w-[780px] sm:p-6"
  >
    <Dialog.Header class="shrink-0 pr-6">
      <Dialog.Title>{$t("editor.addImage", "Add Image")}</Dialog.Title>
      <Dialog.Description>
        {$t(
          "editor.imageDialogDescription",
          "Upload from this device or choose an image already saved in your Free2Z cloud.",
        )}
      </Dialog.Description>
    </Dialog.Header>

    <Tabs.Root bind:value={tab} class="min-h-0 flex-1 gap-4 overflow-hidden">
      <Tabs.List class="shrink-0">
        <Tabs.Trigger value="device">
          <UploadCloud class="h-4 w-4" />
          {$t("editor.deviceImagesTab", "Device")}
        </Tabs.Trigger>
        <Tabs.Trigger value="cloud">
          <Images class="h-4 w-4" />
          {$t("editor.libraryTab", "Your Cloud")}
        </Tabs.Trigger>
      </Tabs.List>

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
          accept="image/*"
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
          aria-label={$t("editor.deviceImageDropzone", "Select device images")}
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
                    {$t("editor.dropImagesNow", "Drop images to add them")}
                  </p>
                  <p class="text-sm text-muted-foreground">
                    {$t(
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
                    {$t("editor.dropImagesTitle", "Drop images anywhere here")}
                  </h3>
                  <p class="text-sm leading-relaxed text-muted-foreground">
                    {$t(
                      "editor.dropImagesDescription",
                      "Drag and drop, paste from your clipboard, or choose files from your device.",
                    )}
                  </p>
                </div>
                <Button class="mt-5" onclick={() => localInputRef?.click()}>
                  <ImagePlus class="h-4 w-4" />
                  {$t("editor.selectImages", "Select Images")}
                </Button>
                <div
                  class="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground/80"
                >
                  <span>
                    {$t(
                      "editor.imageFileHint",
                      "Images only · Multiple files supported",
                    )}
                  </span>
                  <span class="hidden text-border sm:inline" aria-hidden="true"
                    >·</span
                  >
                  <span class="inline-flex items-center gap-1.5">
                    <ClipboardPaste class="h-3.5 w-3.5" />
                    {$t("editor.pasteImageHint", "Paste with ⌘/Ctrl + V")}
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
                  placeholder={$t(
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
                aria-label={$t("editor.addMoreImages", "Add more images")}
                title={$t("editor.addMoreImages", "Add more images")}
                onclick={() => localInputRef?.click()}
              >
                <ImagePlus class="h-4 w-4" />
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
                    <img
                      src={image.previewUrl}
                      alt={image.file.name}
                      class="h-14 w-14 shrink-0 rounded-lg bg-muted object-cover"
                    />
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
                      aria-label={$t("editor.removeImage", "Remove image")}
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
                  {$t("editor.noSelectedImagesFound", "No matching images")}
                </p>
                <p class="text-xs text-muted-foreground">
                  {$t(
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
                  ? $t("editor.imageSelected", "image selected")
                  : $t("editor.imagesSelected", "images selected")}
              </p>
              <Button
                size="sm"
                onclick={() => void uploadLocalFiles(localFiles)}
                disabled={!localFiles.length}
              >
                <UploadCloud class="h-4 w-4" />
                {$t("editor.insertSelectedImages", "Insert Selected")}
              </Button>
            </div>
          {/if}
        </div>
      </Tabs.Content>

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
              placeholder={$t(
                "editor.searchCloudImages",
                "Search Free2Z cloud",
              )}
              class="pl-9"
            />
          </div>
          <div
            class="flex shrink-0 items-center rounded-md border bg-muted/40 p-0.5"
            role="group"
            aria-label={$t("editor.libraryView", "Library view")}
          >
            <Button
              type="button"
              variant={cloudView === "grid" ? "secondary" : "ghost"}
              size="icon-sm"
              class="h-8 w-8"
              aria-label={$t("editor.gridView", "Grid view")}
              aria-pressed={cloudView === "grid"}
              title={$t("editor.gridView", "Grid view")}
              onclick={() => chooseCloudView("grid")}
            >
              <LayoutGrid class="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant={cloudView === "list" ? "secondary" : "ghost"}
              size="icon-sm"
              class="h-8 w-8"
              aria-label={$t("editor.listView", "List view")}
              aria-pressed={cloudView === "list"}
              title={$t("editor.listView", "List view")}
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
            aria-label={$t("editor.refreshLibrary", "Refresh")}
            title={$t("editor.refreshLibrary", "Refresh")}
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
          aria-label={$t("editor.cloudImageResults", "Uploaded image results")}
          aria-busy={cloudLoading || cloudLoadingMore}
        >
          {#if cloudLoading && !cloudItems.length}
            <p class="sr-only" role="status">
              {$t("editor.loadingLibrary", "Loading uploaded images…")}
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
                {$t("editor.retryLibrary", "Try Again")}
              </Button>
            </div>
          {:else if !cloudItems.length}
            <div
              class="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-border/50 px-4 py-12 text-center text-sm text-muted-foreground"
              role="status"
            >
              {$t(
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
                    <img
                      src={buildMediaUrl(item.thumbnail || item.url)}
                      alt={item.title || item.name || "Cloud image"}
                      class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                      loading="lazy"
                    />
                  </div>
                  <div
                    class={`${cloudView === "list" ? "min-w-0 flex-1" : ""} space-y-1 p-2.5 sm:p-3`}
                  >
                    <p class="truncate text-sm font-medium text-foreground">
                      {item.title || item.name || `Image ${item.id}`}
                    </p>
                    <p
                      class={`truncate text-xs text-muted-foreground ${cloudView === "grid" ? "hidden sm:block" : ""}`}
                    >
                      {item.mime_type}
                    </p>
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
                  {$t("editor.loadMoreImages", "Load More")}
                </Button>
              </div>
            {/if}
          {/if}
        </div>
      </Tabs.Content>
    </Tabs.Root>
  </Dialog.Content>
</Dialog.Root>
