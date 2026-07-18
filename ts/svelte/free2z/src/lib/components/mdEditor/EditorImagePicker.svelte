<script lang="ts">
  import { env } from "$env/dynamic/public";
  import { onDestroy } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tabs from "$lib/components/ui/tabs";
  import { t } from "$lib/i18n";
  import {
    Images,
    Loader2,
    RefreshCw,
    Search,
    UploadCloud,
    X,
  } from "@lucide/svelte";
  import { toast } from "svelte-sonner";
  import type { CoverLibraryImage, CoverLibraryResponse } from "./coverTypes";

  interface Props {
    onChooseCloudImage: (item: CoverLibraryImage) => void | Promise<void>;
    onUploadLocalImages: (files: File[]) => void | Promise<void>;
  }

  type LocalImage = {
    id: string;
    file: File;
    previewUrl: string;
  };

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
      localDragActive = false;
    }
  }

  function handleLocalDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    localDragActive = false;
    addLocalFiles(event.dataTransfer?.files ?? []);
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
          t("editor.cloudImageOpenFailed", "Unable to open that image."),
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
          t("editor.cloudImagesLoadFailed", "Failed to load your cloud."),
        );
      }

      const data = (await response.json()) as CoverLibraryResponse;

      if (requestId !== cloudRequestId) {
        return;
      }

      const nextItems = (data.results ?? []).filter((item) =>
        item.mime_type?.startsWith("image/"),
      );

      cloudItems = reset ? nextItems : [...cloudItems, ...nextItems];
      cloudHasNext = Boolean(data.next);
      cloudPage = nextPage + 1;
      cloudError = "";
    } catch (error: any) {
      if (requestId === cloudRequestId) {
        cloudError =
          error?.message ||
          t("editor.cloudImagesLoadFailed", "Failed to load your cloud.");
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
    clearLocalFiles();
  });
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-[780px]">
    <Dialog.Header>
      <Dialog.Title>{t("editor.addImage", "Add Image")}</Dialog.Title>
      <Dialog.Description>
        {t(
          "editor.imageDialogDescription",
          "Upload from this device or choose an image already saved in your Free2Z cloud.",
        )}
      </Dialog.Description>
    </Dialog.Header>

    <Tabs.Root bind:value={tab} class="gap-4">
      <Tabs.List>
        <Tabs.Trigger value="device">
          <UploadCloud class="h-4 w-4" />
          {t("editor.deviceImagesTab", "Device")}
        </Tabs.Trigger>
        <Tabs.Trigger value="cloud">
          <Images class="h-4 w-4" />
          {t("editor.libraryTab", "Your Cloud")}
        </Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="device" class="space-y-4">
        <div
          class={`rounded-2xl border border-dashed p-6 text-center transition ${
            localDragActive
              ? "border-primary bg-primary/5"
              : "border-border/60 bg-muted/20"
          }`}
          role="region"
          aria-label={t("editor.deviceImageDropzone", "Select device images")}
          ondragenter={handleLocalDrag}
          ondragover={handleLocalDrag}
          ondragleave={handleLocalDrag}
          ondrop={handleLocalDrop}
        >
          <div class="mx-auto flex max-w-md flex-col items-center gap-3">
            <div class="rounded-full bg-background p-4 shadow-sm">
              <UploadCloud class="h-6 w-6 text-primary" />
            </div>
            <Button size="sm" onclick={() => localInputRef?.click()}>
              {t("editor.selectImages", "Select Images")}
            </Button>
            <input
              bind:this={localInputRef}
              type="file"
              accept="image/*"
              multiple
              class="hidden"
              onchange={handleLocalInputChange}
            />
          </div>
        </div>

        {#if localFiles.length}
          <div class="relative">
            <Search
              class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              bind:value={localSearch}
              placeholder={t(
                "editor.searchSelectedImages",
                "Search selected images",
              )}
              class="pl-9"
            />
          </div>

          <div class="max-h-[310px] overflow-y-auto rounded-xl border">
            {#each filteredLocalFiles as image (image.id)}
              <div class="flex items-center gap-3 border-b p-3 last:border-b-0">
                <img
                  src={image.previewUrl}
                  alt={image.file.name}
                  class="h-12 w-12 shrink-0 rounded-md bg-muted object-cover"
                />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium">{image.file.name}</p>
                  <p class="text-xs text-muted-foreground">
                    {image.file.type}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("editor.removeImage", "Remove image")}
                  onclick={() => removeLocalFile(image)}
                >
                  <X class="h-4 w-4" />
                </Button>
              </div>
            {/each}
          </div>

          <div class="flex justify-end">
            <Button
              onclick={() => void uploadLocalFiles(localFiles)}
              disabled={!localFiles.length}
            >
              <UploadCloud class="h-4 w-4" />
              {t("editor.insertSelectedImages", "Insert Selected")}
            </Button>
          </div>
        {/if}
      </Tabs.Content>

      <Tabs.Content value="cloud" class="space-y-4">
        <div class="flex flex-col gap-3 sm:flex-row">
          <div class="relative flex-1">
            <Search
              class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              bind:value={cloudSearch}
              placeholder={t("editor.searchCloudImages", "Search Free2Z cloud")}
              class="pl-9"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onclick={() => void loadCloud(true)}
            disabled={cloudLoading}
          >
            {#if cloudLoading}
              <Loader2 class="h-4 w-4 animate-spin" />
            {:else}
              <RefreshCw class="h-4 w-4" />
            {/if}
            {t("editor.refreshLibrary", "Refresh")}
          </Button>
        </div>

        {#if cloudError}
          <div
            class="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {cloudError}
          </div>
        {/if}

        {#if cloudLoading && !cloudItems.length}
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {#each Array.from({ length: 6 }) as _, index (index)}
              <div class="overflow-hidden rounded-xl border bg-card">
                <div class="aspect-[4/3] animate-pulse bg-muted"></div>
                <div class="space-y-2 p-3">
                  <div class="h-3 animate-pulse rounded bg-muted"></div>
                  <div class="h-3 w-2/3 animate-pulse rounded bg-muted"></div>
                </div>
              </div>
            {/each}
          </div>
        {:else if !cloudItems.length}
          <div
            class="rounded-2xl border border-dashed border-border/50 py-12 text-center text-sm text-muted-foreground"
          >
            {t(
              "editor.libraryEmpty",
              "You do not have any uploaded images yet.",
            )}
          </div>
        {:else}
          <div
            class="grid max-h-[420px] gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3"
          >
            {#each cloudItems as item (item.id)}
              <button
                type="button"
                class="group relative overflow-hidden rounded-xl border bg-card text-left transition hover:border-primary/35 hover:shadow-md"
                onclick={() => void chooseCloudImage(item)}
                disabled={choosingCloudImageId !== null}
              >
                <div class="aspect-[4/3] overflow-hidden bg-muted">
                  <img
                    src={buildMediaUrl(item.thumbnail || item.url)}
                    alt={item.title || item.name || "Cloud image"}
                    class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    loading="lazy"
                  />
                </div>
                <div class="space-y-1 p-3">
                  <p class="truncate text-sm font-medium text-foreground">
                    {item.title || item.name || `Image ${item.id}`}
                  </p>
                  <p class="truncate text-xs text-muted-foreground">
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
            <div class="flex justify-center pt-2">
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
                {t("editor.loadMoreImages", "Load More")}
              </Button>
            </div>
          {/if}
        {/if}
      </Tabs.Content>
    </Tabs.Root>
  </Dialog.Content>
</Dialog.Root>
