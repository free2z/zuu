<script lang="ts">
  import { env } from "$env/dynamic/public";
  import { onDestroy } from "svelte";
  import { uploadPublicFile } from "$lib/api/uploads";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Tabs from "$lib/components/ui/tabs";
  import { tStore as t } from "$lib/i18n";
  import { isAuthenticated } from "$lib/stores/auth";
  import { toast } from "svelte-sonner";
  import {
    ImagePlus,
    Images,
    Sparkles,
    Trash2,
    UploadCloud,
  } from "@lucide/svelte";
  import CoverAIPanel from "./CoverAIPanel.svelte";
  import CoverCropDialog from "./CoverCropDialog.svelte";
  import CoverLibraryPanel from "./CoverLibraryPanel.svelte";
  import CoverUploadPanel from "./CoverUploadPanel.svelte";
  import type { CoverLibraryImage, CoverLibraryResponse } from "./coverTypes";
  import { appendMediaPage } from "./mediaLibrary.js";
  import { resolveMediaUrl, slugify } from "./utils";

  interface Props {
    title: string;
    coverImage: string;
    coverImageId: number | null;
    showCover: boolean;
    onCoverImageChange?: () => void;
  }

  const COVER_WIDTH = 1600;
  const COVER_HEIGHT = 400;
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";

  let {
    title,
    coverImage = $bindable(),
    coverImageId = $bindable(),
    showCover = $bindable(),
    onCoverImageChange,
  }: Props = $props();

  let dragActive = $state(false);
  let assetDialogOpen = $state(false);
  let assetDialogTab = $state("upload");
  let cropDialogOpen = $state(false);

  let libraryItems = $state<CoverLibraryImage[]>([]);
  let libraryPage = $state(1);
  let libraryHasNext = $state(false);
  let libraryLoading = $state(false);
  let libraryLoadingMore = $state(false);
  let libraryError = $state("");
  let loadingLibraryItemId = $state<number | null>(null);

  let cropSourceUrl = $state("");
  let cropSourceObjectUrl = $state<string | null>(null);
  let cropSourceTitle = $state("");
  let cropUploading = $state(false);

  function buildMediaUrl(path?: string | null) {
    if (!path) {
      return "";
    }

    if (/^https?:\/\//i.test(path) || !apiBase) {
      return path;
    }

    return `${apiBase}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  function hasCover() {
    return showCover && Boolean(coverImage);
  }

  function notifyCoverChange() {
    onCoverImageChange?.();
  }

  function openAssetDialog(tab: "upload" | "library" = "upload") {
    assetDialogTab = tab;
    assetDialogOpen = true;
  }

  function clearCover() {
    coverImage = "";
    coverImageId = null;
    showCover = false;
    notifyCoverChange();
  }

  function handleHostKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    openAssetDialog("upload");
  }

  function handleDragState(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();

    if (event.type === "dragenter" || event.type === "dragover") {
      dragActive = true;
      return;
    }

    if (event.type === "dragleave") {
      dragActive = false;
    }
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    dragActive = false;

    const file = event.dataTransfer?.files?.[0];
    if (!file) {
      return;
    }

    await beginCropFromFile(file, file.name);
  }

  async function handleDeviceInputChange(
    event: Event & { currentTarget: EventTarget & HTMLInputElement },
  ) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    await beginCropFromFile(file, file.name);
    input.value = "";
  }

  async function loadLibrary(reset = false) {
    if (libraryLoading || libraryLoadingMore) {
      return;
    }

    if (reset) {
      libraryLoading = true;
      libraryPage = 1;
      libraryError = "";
    } else {
      libraryLoadingMore = true;
    }

    try {
      const page = reset ? 1 : libraryPage;
      const response = await fetch(
        `${apiBase}/api/myuploads/?page=${page}&mime_type=image/`,
        {
          credentials: "include",
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to load your cloud (${response.status})`);
      }

      const data = (await response.json()) as CoverLibraryResponse;
      const nextItems = (data.results ?? []).filter((item) =>
        item.mime_type?.startsWith("image/"),
      );

      libraryItems = reset
        ? nextItems
        : appendMediaPage(libraryItems, nextItems);
      libraryHasNext = Boolean(data.next);
      libraryPage = page + 1;
      libraryError = "";
    } catch (error: any) {
      libraryError = error?.message || "Failed to load your cloud";
    } finally {
      libraryLoading = false;
      libraryLoadingMore = false;
    }
  }

  function revokeCropSourceUrl() {
    if (cropSourceObjectUrl) {
      URL.revokeObjectURL(cropSourceObjectUrl);
      cropSourceObjectUrl = null;
    }
  }

  function resetCropState() {
    revokeCropSourceUrl();
    cropSourceUrl = "";
    cropSourceTitle = "";
  }

  async function beginCropFromFile(file: File, suggestedTitle: string) {
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file for the cover.");
      return;
    }

    resetCropState();
    cropSourceObjectUrl = URL.createObjectURL(file);
    cropSourceUrl = cropSourceObjectUrl;
    cropSourceTitle = suggestedTitle;
    assetDialogOpen = false;
    cropDialogOpen = true;
  }

  async function beginCropFromLibraryItem(item: CoverLibraryImage) {
    if (loadingLibraryItemId) {
      return;
    }

    loadingLibraryItemId = item.id;

    try {
      const response = await fetch(buildMediaUrl(item.url), {
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`Failed to load image (${response.status})`);
      }

      const blob = await response.blob();
      const extension = item.mime_type.split("/")[1] || "jpg";
      const fileName = (item.name || item.title || `cover-${item.id}`)
        .replace(/[^\w.-]+/g, "-")
        .toLowerCase();
      const file = new File([blob], `${fileName}.${extension}`, {
        type: blob.type || item.mime_type,
      });

      await beginCropFromFile(file, item.title || item.name || "cover");
    } catch (error: any) {
      toast.error(error?.message || "Unable to open that image.");
    } finally {
      loadingLibraryItemId = null;
    }
  }

  async function beginCropFromGeneratedFile(file: File, prompt: string) {
    await beginCropFromFile(file, prompt || "AI-generated cover");
  }

  function invalidateLibrary() {
    libraryItems = [];
    libraryPage = 1;
    libraryHasNext = false;
    libraryError = "";
  }

  async function uploadCroppedCover(blob: Blob) {
    const articleSlug = slugify(title || cropSourceTitle || "zpage-cover");
    const fileName = `${articleSlug || "zpage-cover"}-cover.jpg`;
    const file = new File([blob], fileName, { type: "image/jpeg" });

    return uploadPublicFile(
      file,
      title.trim() || cropSourceTitle || "Zpage cover",
    );
  }

  async function confirmCrop(blob: Blob) {
    cropUploading = true;

    try {
      const uploaded = await uploadCroppedCover(blob);

      coverImageId = uploaded.id;
      coverImage = resolveMediaUrl(uploaded.url || uploaded.thumbnail || "");
      showCover = true;
      cropDialogOpen = false;
      notifyCoverChange();
      toast.success("Cover image updated.");
    } catch (error: any) {
      toast.error(error?.message || "Failed to update the cover image.");
    } finally {
      cropUploading = false;
    }
  }

  function handleCropDialogChange(open: boolean) {
    cropDialogOpen = open;
    if (!open) {
      resetCropState();
    }
  }

  $effect(() => {
    if (
      assetDialogOpen &&
      assetDialogTab === "library" &&
      !libraryItems.length &&
      !libraryLoading
    ) {
      void loadLibrary(true);
    }
  });

  $effect(() => {
    if (!$isAuthenticated && assetDialogTab === "ai") {
      assetDialogTab = "upload";
    }
  });

  onDestroy(() => {
    revokeCropSourceUrl();
  });
</script>

<div class="relative">
  <div
    class={`group relative cursor-pointer overflow-hidden transition-all duration-300 outline-none ${
      hasCover() ? "h-56 bg-muted/20 md:h-72" : "h-24 md:h-32"
    } ${dragActive ? "bg-primary/5" : ""}`}
    role="button"
    tabindex="0"
    aria-label="Add or change the cover image"
    onclick={() => openAssetDialog("upload")}
    onkeydown={handleHostKeydown}
    ondragenter={handleDragState}
    ondragover={handleDragState}
    ondragleave={handleDragState}
    ondrop={handleDrop}
  >
    {#if hasCover()}
      <img
        src={coverImage}
        alt="Cover"
        class="absolute inset-0 h-full w-full object-cover"
      />
      <div
        class="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background/40"
      ></div>
    {:else}
      <div
        class="absolute inset-0 bg-gradient-to-b from-muted/60 via-muted/25 to-transparent"
      ></div>
      <div
        class={`pointer-events-none absolute inset-x-4 inset-y-3 rounded-xl border border-dashed transition-all duration-300 md:inset-x-6 ${
          dragActive
            ? "border-primary/50 opacity-100"
            : "border-border/70 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        }`}
      ></div>
    {/if}

    {#if hasCover()}
      <div
        class="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent"
      ></div>
    {/if}

    {#if dragActive}
      <div
        class="absolute inset-0 flex items-center justify-center bg-background/30 px-6"
      >
        <div
          class="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-background/92 px-4 py-2 text-sm text-foreground shadow-sm"
        >
          <UploadCloud class="h-4 w-4 text-primary" />
          <span>{$t("editor.dropCover", "Drop an image here")}</span>
        </div>
      </div>
    {:else if !hasCover()}
      <div
        class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6"
      >
        <span
          class="flex h-8 w-8 items-center justify-center rounded-full bg-background/80 text-muted-foreground/70 shadow-sm ring-1 ring-border/40 transition-colors duration-300 group-hover:text-foreground/80 md:h-9 md:w-9"
        >
          <ImagePlus class="h-4 w-4" />
        </span>
        <p
          class="text-xs font-medium text-muted-foreground/70 transition-colors duration-300 group-hover:text-foreground/80 md:text-sm"
        >
          {$t("editor.coverInlineHint", "Add a cover image")}
        </p>
        <p class="hidden text-[11px] text-muted-foreground/50 md:block">
          {$t("editor.coverInlineSubhint", "Drag and drop, or click to browse")}
        </p>
      </div>
    {/if}

    {#if hasCover()}
      <div
        class="absolute top-4 right-4 flex items-center gap-2 opacity-0 transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <Button
          variant="secondary"
          size="sm"
          class="h-8 rounded-full bg-background/88 px-3 text-xs shadow-sm backdrop-blur-sm"
          onclick={(event) => {
            event.stopPropagation();
            openAssetDialog("upload");
          }}
        >
          <ImagePlus class="h-3.5 w-3.5" />
          {$t("editor.changeCover", "Change")}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          class="h-8 rounded-full bg-background/72 px-3 text-xs text-foreground shadow-sm backdrop-blur-sm"
          onclick={(event) => {
            event.stopPropagation();
            clearCover();
          }}
        >
          <Trash2 class="h-3.5 w-3.5" />
          {$t("editor.removeCover", "Remove")}
        </Button>
      </div>
    {/if}
  </div>
</div>

<Dialog.Root bind:open={assetDialogOpen}>
  <Dialog.Content
    class="flex h-[calc(100dvh-2rem)] max-h-[720px] flex-col overflow-hidden p-4 sm:max-w-[760px] sm:p-6"
  >
    <Dialog.Header class="shrink-0 pr-6">
      <Dialog.Title
        >{$t("editor.coverDialogTitle", "Choose a cover image")}</Dialog.Title
      >
      <Dialog.Description>
        {$t(
          "editor.coverDialogDescription",
          "Every cover is cropped to a standard 1600 × 400 banner before it is attached to the zpage.",
        )}
      </Dialog.Description>
    </Dialog.Header>

    <Tabs.Root
      bind:value={assetDialogTab}
      class="min-h-0 flex-1 gap-4 overflow-hidden"
    >
      <Tabs.List class="shrink-0">
        <Tabs.Trigger value="upload">
          <UploadCloud class="h-4 w-4" />
          {$t("editor.uploadTab", "Upload")}
        </Tabs.Trigger>
        <Tabs.Trigger value="library">
          <Images class="h-4 w-4" />
          {$t("editor.libraryTab", "Your Cloud")}
        </Tabs.Trigger>
        {#if $isAuthenticated}
          <Tabs.Trigger value="ai">
            <Sparkles class="h-4 w-4" />
            {$t("editor.aiCoverTab", "AI")}
          </Tabs.Trigger>
        {/if}
      </Tabs.List>

      <Tabs.Content
        value="upload"
        class="min-h-0 space-y-4 overflow-y-auto overscroll-contain pr-1"
      >
        <CoverUploadPanel
          onDragState={handleDragState}
          onDrop={handleDrop}
          onDeviceInputChange={handleDeviceInputChange}
        />
      </Tabs.Content>

      <Tabs.Content
        value="library"
        class="flex min-h-0 flex-col overflow-hidden"
      >
        <CoverLibraryPanel
          items={libraryItems}
          hasNext={libraryHasNext}
          isLoading={libraryLoading}
          isLoadingMore={libraryLoadingMore}
          error={libraryError}
          loadingItemId={loadingLibraryItemId}
          {buildMediaUrl}
          onRefresh={() => loadLibrary(true)}
          onLoadMore={() => loadLibrary(false)}
          onChoose={beginCropFromLibraryItem}
        />
      </Tabs.Content>

      {#if $isAuthenticated}
        <Tabs.Content value="ai" class="flex min-h-0 flex-col overflow-hidden">
          <CoverAIPanel
            {apiBase}
            {buildMediaUrl}
            onGenerated={invalidateLibrary}
            onChoose={beginCropFromGeneratedFile}
          />
        </Tabs.Content>
      {/if}
    </Tabs.Root>
  </Dialog.Content>
</Dialog.Root>

<CoverCropDialog
  bind:open={cropDialogOpen}
  sourceUrl={cropSourceUrl}
  uploading={cropUploading}
  coverWidth={COVER_WIDTH}
  coverHeight={COVER_HEIGHT}
  onOpenChange={handleCropDialogChange}
  onConfirm={confirmCrop}
/>
