<script lang="ts">
  import { formatDate as formatApiDate } from "$lib/utils/date";
  import * as env from "$app/env/public";
  import { onDestroy, onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { page } from "$lib/kit-stores";
  import { toast, captureAccountToast } from "$lib/toast.js";
  import { locale, tStore as t } from "$lib/i18n";
  import MediaUploader from "$lib/components/media/MediaUploader.svelte";
  import MediaPreviewDialog from "$lib/components/media/MediaPreviewDialog.svelte";
  import {
    absoluteMediaUrl,
    resolveMediaUrl,
  } from "$lib/components/media/mediaUrl.js";
  import { copyTextToClipboard } from "$lib/components/media/clipboard.js";
  import {
    documentLabel,
    mediaKind,
  } from "$lib/components/media/supportedUploadTypes";
  import {
    isShareableAccess,
    normalizeMediaAccess,
    type MediaAccess,
  } from "$lib/components/media/mediaAccess";
  import { apiFetch } from "$lib/api/config";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import {
    File as FileIcon,
    Files as FilesIcon,
    RefreshCw,
    Copy,
    Download,
    Share2,
    Trash2,
    AlertCircle,
    Loader2,
    LayoutGrid,
    List,
    Search,
    X,
    ArrowDownUp,
    Check,
    Pencil,
  } from "@lucide/svelte";

  type ViewMode = "grid" | "list";
  /**
   * `document` maps to the `application/` prefix. `GenericFileFilter.mime_type`
   * is an `istartswith` filter, so a prefix is exactly what the server wants —
   * and `application/pdf` is the only allowlisted type under it today.
   */
  type MediaTypeFilter = "all" | "image" | "video" | "audio" | "document";
  /**
   * `GenericFileFilter.access` is an exact-match `CharFilter`, so the value is
   * the stored tier verbatim. "all" is our own sentinel and is never sent.
   */
  type AccessFilter = "all" | MediaAccess;
  type SortOrder = "newest" | "oldest";

  const MIME_PREFIX_FOR_FILTER: Record<
    Exclude<MediaTypeFilter, "all">,
    string
  > = {
    image: "image/",
    video: "video/",
    audio: "audio/",
    document: "application/",
  };

  type UploadedMedia = {
    id: number;
    url: string;
    name: string;
    thumbnail?: string | null;
    title?: string;
    description?: string;
    mime_type?: string;
    access?: string;
    created_at: string;
    sizeBytes?: number;
  };

  const apiBase = (env.PUBLIC_API_BASE_URL || "").replace(/\/$/, "");

  let media: UploadedMedia[] = [];
  let mediaError = "";
  let loadingMedia = true;
  let loadingMore = false;
  let hasNext = true;
  let pageIndex = 1;
  let previewOpen = false;
  let previewItem: UploadedMedia | null = null;
  let mediaRequestController: AbortController | null = null;
  let requestSequence = 0;
  let searchQuery = "";
  let mediaType: MediaTypeFilter = "all";
  let accessFilter: AccessFilter = "all";
  let sortOrder: SortOrder = "newest";
  let viewMode: ViewMode = "grid";
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let copiedMediaId: number | null = null;
  let copiedResetTimer: ReturnType<typeof setTimeout> | null = null;
  let userRefreshing = false;

  $: vanityUsername = $page.params.username || "";

  const buildApiUrl = (path: string) => `${apiBase}${path}`;

  const buildMediaUrl = (path?: string | null, absolute = false) =>
    absolute
      ? absoluteMediaUrl(path || "", apiBase)
      : resolveMediaUrl(path || "", apiBase);

  const formatBytes = (bytes?: number) => {
    if (!bytes || Number.isNaN(bytes)) return "—";
    const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return new Intl.NumberFormat($locale, {
      style: "unit",
      unit: units[unitIndex],
      unitDisplay: "short",
      maximumFractionDigits: value >= 10 || value % 1 === 0 ? 0 : 1,
    }).format(value);
  };

  const formatDate = (dateString: string) =>
    formatApiDate(dateString, $locale, undefined, "");

  // These four are `$:` rather than `const` on purpose. They read `$t` inside
  // the function body, and a template expression like `{accessLabel(x)}` does
  // not list `$t` among its dependencies — as a plain const, the badges and
  // hints would keep the old language until something else invalidated the
  // row. A reactive assignment depends on `$t` and re-runs the template.
  $: accessLabel = (access?: string | null) => {
    const level = normalizeMediaAccess(access);
    if (level === "public") return $t("dashboard.media.accessPublic", "Public");
    if (level === "members")
      return $t("dashboard.media.accessMembers", "Subscribers");
    return $t("dashboard.media.accessPrivate", "Private");
  };

  /**
   * Who the file's link actually works for. The dashboard says this next to
   * every link affordance instead of offering a Share button that 401s: a
   * `private` blob is owner-only for every recipient (`uploads/views.py`).
   */
  $: linkNote = (access?: string | null) => {
    const level = normalizeMediaAccess(access);
    if (level === "public")
      return $t(
        "dashboard.media.linkPublicNote",
        "Anyone with the link can open it",
      );
    if (level === "members")
      return $t(
        "dashboard.media.linkMembersNote",
        "Only your subscribers can open this link",
      );
    return $t("dashboard.media.linkPrivateNote", "Only you can open this link");
  };

  $: accessHint = (access: MediaAccess) => {
    if (access === "public")
      return $t(
        "dashboard.media.accessPublicHint",
        "Anyone with the link can open it, and it can be used on a published page.",
      );
    if (access === "members")
      return $t(
        "dashboard.media.accessMembersHint",
        "Only people subscribed to you can open it. Everyone else gets nothing.",
      );
    return $t(
      "dashboard.media.accessPrivateHint",
      "Only you can open it. A link you send to someone else will not work.",
    );
  };

  $: linkCopiedMessage = (access?: string | null) => {
    const level = normalizeMediaAccess(access);
    if (level === "public")
      return $t(
        "dashboard.media.linkCopiedPublic",
        "Link copied — anyone with it can open the file",
      );
    if (level === "members")
      return $t(
        "dashboard.media.linkCopiedMembers",
        "Link copied — only your subscribers can open it",
      );
    return $t(
      "dashboard.media.linkCopiedPrivate",
      "Link copied — only you can open it",
    );
  };

  const copyToClipboard = async (text: string, successMessage?: string) => {
    const operationNotice = captureAccountToast();
    try {
      const copied = await copyTextToClipboard(text);
      if (!copied) throw new Error("Clipboard unavailable");
      operationNotice.success(
        successMessage ||
          $t("dashboard.media.linkCopied", "Link copied to clipboard"),
      );
      return true;
    } catch (err) {
      operationNotice.error(
        $t("dashboard.media.copyFailed", "Failed to copy link"),
      );
      return false;
    }
  };

  const copyMediaLink = async (
    item: UploadedMedia,
    successMessage?: string,
  ) => {
    const copied = await copyToClipboard(
      buildMediaUrl(item.url, true),
      successMessage || linkCopiedMessage(item.access),
    );
    if (!copied) return;

    copiedMediaId = item.id;
    if (copiedResetTimer) clearTimeout(copiedResetTimer);
    copiedResetTimer = setTimeout(() => {
      copiedMediaId = null;
      copiedResetTimer = null;
    }, 2000);
  };

  const shareMedia = async (item: UploadedMedia) => {
    // Belt and braces: the Share affordance is not rendered for a private
    // file, but the preview dialog and any future caller reach this directly,
    // and handing somebody a URL that 401s for them is the bug being fixed.
    if (!isShareableAccess(item.access)) {
      await copyMediaLink(item);
      return;
    }
    const url = buildMediaUrl(item.url, true);
    const title =
      item.title ||
      item.name ||
      $t("dashboard.media.shareTitle", "Free2Z file");

    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
      }
    }

    await copyMediaLink(item);
  };

  const openPreview = (item: UploadedMedia) => {
    previewItem = item;
    previewOpen = true;
  };

  /**
   * A PDF has no thumbnail, so "open it" is the whole interaction. The href is
   * the SAME-ORIGIN form on purpose: browsers ignore `download` on a
   * cross-origin link, and `buildMediaUrl(url, true)` is deliberately absolute
   * because that is the value the clipboard and the share sheet need.
   */
  const downloadHref = (item: UploadedMedia) => buildMediaUrl(item.url);

  const downloadName = (item: UploadedMedia) => {
    const stored = (item.name || "").split("/").pop() || "";
    return stored || item.title || "download";
  };

  let deleteTarget: UploadedMedia | null = null;
  let deleteOpen = false;
  let deleting = false;

  const confirmDelete = (item: UploadedMedia) => {
    deleteTarget = item;
    deleteOpen = true;
  };

  const performDelete = async () => {
    const operationNotice = captureAccountToast();
    if (!deleteTarget || deleting) return;
    const item = deleteTarget;
    deleting = true;
    try {
      const response = await apiFetch(
        buildApiUrl(`/api/myuploads/${item.id}/`),
        {
          method: "DELETE",
        },
      );
      // 404 means it is already gone; treat that as success rather than
      // stranding a row the user cannot remove.
      if (!response.ok && response.status !== 404) {
        // 409 is the server refusing because something else would be deleted
        // with it (a story page — the one CASCADE reference). Its `detail`
        // names what has to go first, and a generic "could not delete" would
        // throw that away and leave the user with no next step.
        let detail = "";
        if (response.status === 409) {
          detail = await response
            .json()
            .then((body) => body?.detail || "")
            .catch(() => "");
        }
        operationNotice.error(
          detail ||
            $t("dashboard.media.deleteFailed", "Could not delete {name}", {
              name: item.title || item.name,
            }),
        );
        return;
      }
      media = media.filter((entry) => entry.id !== item.id);
      if (previewItem?.id === item.id) {
        previewOpen = false;
        previewItem = null;
      }
      operationNotice.success($t("dashboard.media.deleted", "File deleted"));
      deleteOpen = false;
      deleteTarget = null;
    } catch {
      operationNotice.error(
        $t("dashboard.media.deleteFailed", "Could not delete {name}", {
          name: item.title || item.name,
        }),
      );
    } finally {
      deleting = false;
    }
  };

  let editTarget: UploadedMedia | null = null;
  let editOpen = false;
  let saving = false;
  let editAccess: MediaAccess = "private";
  let editTitle = "";
  let editDescription = "";

  /**
   * Exactly the fields the user changed in this dialog — never the whole form.
   *
   * A PATCH that replays every field turns an unrelated title edit into a
   * privacy write: open the dialog on a public file, let something else make
   * it private (another tab, an operator), then save the title, and the stale
   * `access` republishes it. This endpoint has no ETag/precondition, so
   * sending only what actually changed is the whole defence — and it is not
   * one for the fields that DID change, which still last-write-wins.
   */
  const changedFields = () => {
    const payload: Record<string, string> = {};
    if (!editTarget) return payload;
    if (editAccess !== normalizeMediaAccess(editTarget.access))
      payload.access = editAccess;
    if (editTitle !== (editTarget.title || "")) payload.title = editTitle;
    if (editDescription !== (editTarget.description || ""))
      payload.description = editDescription;
    return payload;
  };

  /**
   * What actually happens to the file's LINK, which is not the same question
   * as what happens to its permissions.
   *
   * `_get_prefix()` returns `/uploadz/public/` only for `public`, so the URL
   * changes only when the transition crosses that boundary — private<->members
   * keeps the identical URL. And the two directions are not symmetric:
   * `uploads_auth_private` grants anything `_public_access_ok()` accepts, so a
   * file's old `/uploadz/` link starts working for everyone once it goes
   * public, while a public link that is withdrawn can still be served from a
   * cache we cannot purge (`s-maxage=3600` on the public tier).
   */
  $: accessNote = (() => {
    if (!editTarget) return "";
    const from = normalizeMediaAccess(editTarget.access);
    if (from === editAccess) return "";
    if (from === "public")
      return $t(
        "dashboard.media.accessNoteLeavingPublic",
        "The public link stops working for other people, and the file gets a new link. A browser or CDN that already fetched it may keep serving the old one for up to an hour.",
      );
    if (editAccess === "public")
      return $t(
        "dashboard.media.accessNoteBecomingPublic",
        "The file gets a public link, and the link it already has starts working for anyone who has it.",
      );
    return $t(
      "dashboard.media.accessNoteRestrictedSwap",
      "The link stays the same — only who can open it changes.",
    );
  })();

  const openEdit = (item: UploadedMedia) => {
    editTarget = item;
    editAccess = normalizeMediaAccess(item.access);
    editTitle = item.title || "";
    editDescription = item.description || "";
    editOpen = true;
  };

  /**
   * DRF answers a rejected write either as `{"detail": "..."}` or as
   * `{"<field>": ["..."]}`. Showing the server's own words beats a generic
   * "could not save" — the value it rejected is the one the user just chose.
   */
  const readErrorDetail = async (response: Response) => {
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== "object") return "";
    const record = body as Record<string, unknown>;
    if (typeof record.detail === "string") return record.detail;
    for (const value of Object.values(record)) {
      if (typeof value === "string") return value;
      if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    }
    return "";
  };

  /**
   * Replace one row with the server's re-serialized object.
   *
   * It has to be the WHOLE object, not just the `access` string: the URL
   * prefix is derived from the access level server-side
   * (`GenericFile._get_prefix()` sends `public` to `/uploadz/public/` and
   * everything else to `/uploadz/`), so a level change rewrites `url`,
   * `thumbnail`, `thumb`/`card`/`banner` and every `variants[].url`. Patching
   * the string locally would leave the thumbnail and the copy-link button
   * pointing at a prefix that now 401s — or, worse, at a public prefix for a
   * file that is no longer public.
   *
   * `sizeBytes` is ours, not the serializer's (it comes from a HEAD on the
   * blob), so it is carried across rather than dropped.
   */
  const applyUpdatedItem = (id: number, updated: UploadedMedia) => {
    const merge = (entry: UploadedMedia) => ({
      ...updated,
      sizeBytes: entry.sizeBytes,
    });
    media = media.map((entry) => (entry.id === id ? merge(entry) : entry));
    if (previewItem?.id === id) previewItem = merge(previewItem);
  };

  const saveEdit = async () => {
    const operationNotice = captureAccountToast();
    if (!editTarget || saving) return;
    const item = editTarget;
    // `mime_type` is never here even though the serializer accepts it: it
    // holds the SNIFFED type  and no UI gets to overwrite it.
    const payload = changedFields();
    if (Object.keys(payload).length === 0) {
      editOpen = false;
      editTarget = null;
      return;
    }
    saving = true;
    try {
      const response = await apiFetch(
        buildApiUrl(`/api/myuploads/${item.id}/`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        operationNotice.error(
          detail ||
            $t("dashboard.media.saveFailed", "Could not save {name}", {
              name: item.title || item.name,
            }),
        );
        return;
      }
      const updated = await response.json().catch(() => null);
      if (updated && typeof updated === "object" && "id" in updated) {
        applyUpdatedItem(item.id, updated as UploadedMedia);
      } else {
        // The write landed but we cannot see the new representation, and the
        // stale one may carry the wrong URL prefix. Refetching costs the
        // scroll position; showing a dead link costs more.
        await refreshMedia();
      }
      operationNotice.success($t("dashboard.media.saved", "Changes saved"));
      editOpen = false;
      editTarget = null;
    } catch {
      operationNotice.error(
        $t("dashboard.media.saveFailed", "Could not save {name}", {
          name: item.title || item.name,
        }),
      );
    } finally {
      saving = false;
    }
  };

  const copyPreviewLink = () => {
    if (previewItem) void copyMediaLink(previewItem);
  };

  const sharePreview = () => {
    if (previewItem) void shareMedia(previewItem);
  };

  const scheduleSearch = () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void refreshMedia();
    }, 300);
  };

  const changeMediaType = (event: Event) => {
    mediaType = (event.currentTarget as HTMLSelectElement)
      .value as MediaTypeFilter;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
    void refreshMedia();
  };

  const changeAccessFilter = (event: Event) => {
    accessFilter = (event.currentTarget as HTMLSelectElement)
      .value as AccessFilter;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
    void refreshMedia();
  };

  const toggleSortOrder = () => {
    sortOrder = sortOrder === "newest" ? "oldest" : "newest";
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
    void refreshMedia();
  };

  const clearFilters = () => {
    searchQuery = "";
    mediaType = "all";
    accessFilter = "all";
    sortOrder = "newest";
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
    void refreshMedia();
  };

  const changeViewMode = (mode: ViewMode) => {
    viewMode = mode;
    localStorage.setItem("free2z-media-view", mode);
  };

  const refreshMedia = async () => {
    pageIndex = 1;
    hasNext = true;
    await loadMedia(true);
  };

  const handleUserRefresh = async () => {
    userRefreshing = true;
    try {
      await refreshMedia();
    } finally {
      userRefreshing = false;
    }
  };

  const fetchSizeForItem = async (item: UploadedMedia) => {
    const url = buildMediaUrl(item.url);
    if (!url) return item;
    try {
      const response = await fetch(url, {
        method: "HEAD",
        credentials: "include",
      });
      const sizeHeader = response.headers.get("content-length");
      if (sizeHeader) {
        const size = Number(sizeHeader);
        if (!Number.isNaN(size)) {
          return { ...item, sizeBytes: size } as UploadedMedia;
        }
      }
    } catch (err) {
      console.warn("Failed to fetch size for", item.name, err);
    }
    return item;
  };

  const enrichSizes = async (items: UploadedMedia[]) => {
    const updated = await Promise.all(items.map((i) => fetchSizeForItem(i)));
    const sizes = new Map(
      updated
        .filter((item) => item.sizeBytes !== undefined)
        .map((item) => [item.id, item.sizeBytes]),
    );
    if (sizes.size === 0) return;
    media = media.map((item) =>
      sizes.has(item.id) ? { ...item, sizeBytes: sizes.get(item.id) } : item,
    );
  };

  const loadMedia = async (reset = false) => {
    if ((!hasNext && !reset) || ((loadingMedia || loadingMore) && !reset))
      return;

    if (reset) mediaRequestController?.abort();
    const controller = new AbortController();
    mediaRequestController = controller;
    const requestId = ++requestSequence;
    const requestedPage = reset ? 1 : pageIndex;

    loadingMedia = reset;
    loadingMore = !reset;
    mediaError = "";
    const params = new URLSearchParams({ page: String(requestedPage) });
    const normalizedSearch = searchQuery.trim();
    if (normalizedSearch) params.set("search", normalizedSearch);
    if (mediaType !== "all")
      params.set("mime_type", MIME_PREFIX_FOR_FILTER[mediaType]);
    if (accessFilter !== "all") params.set("access", accessFilter);
    params.set(
      "ordering",
      sortOrder === "newest" ? "-created_at,-id" : "created_at,id",
    );
    const url = buildApiUrl(`/api/myuploads/?${params.toString()}`);
    try {
      const response = await fetch(url, {
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          $t(
            "dashboard.media.loadFailedWithStatus",
            "Failed to load your files ({status})",
            { status: response.status },
          ),
        );
      }
      const data = await response.json();
      const results = (data?.results || []) as UploadedMedia[];
      if (requestId !== requestSequence) return;

      if (reset) {
        media = results;
      } else {
        const knownIds = new Set(media.map((item) => item.id));
        media = [...media, ...results.filter((item) => !knownIds.has(item.id))];
      }
      hasNext = Boolean(data?.next);
      pageIndex = requestedPage + 1;
      void enrichSizes(results);
    } catch (error: any) {
      if (error?.name === "AbortError") return;
      if (requestId !== requestSequence) return;
      mediaError =
        error?.message ||
        $t("dashboard.media.loadFailed", "Failed to load your files");
    } finally {
      if (requestId === requestSequence) {
        loadingMedia = false;
        loadingMore = false;
      }
    }
  };

  onMount(() => {
    const savedView = localStorage.getItem("free2z-media-view");
    if (savedView === "grid" || savedView === "list") viewMode = savedView;
    loadMedia(true);
  });

  onDestroy(() => {
    if (searchTimer) clearTimeout(searchTimer);
    if (copiedResetTimer) clearTimeout(copiedResetTimer);
    mediaRequestController?.abort();
  });
</script>

<svelte:head>
  <title
    >{$t("dashboard.media.metaTitle", "Media | {username}", {
      username: vanityUsername,
    })}</title
  >
</svelte:head>

<div
  class="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8"
>
  <!-- Upload Area -->
  <MediaUploader on:upload-success={refreshMedia} />

  <!-- Media Library -->
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold tracking-tight">
        {$t("dashboard.media.library", "Library")}
      </h2>
      {#if loadingMedia && !loadingMore}
        <div
          class="flex items-center gap-2 text-sm text-muted-foreground"
          in:fade
        >
          <Loader2 class="h-3 w-3 animate-spin" />
          <span>{$t("dashboard.media.syncing", "Syncing...")}</span>
        </div>
      {/if}
    </div>

    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div class="relative min-w-0 flex-1">
        <Search
          class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          bind:value={searchQuery}
          on:input={scheduleSearch}
          placeholder={$t(
            "dashboard.media.searchPlaceholder",
            "Search your files",
          )}
          aria-label={$t(
            "dashboard.media.searchLabel",
            "Search your file library",
          )}
          class="h-10 w-full appearance-none rounded-lg border border-border bg-background pr-10 pl-9 text-sm transition-colors outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
        />
        {#if searchQuery}
          <button
            type="button"
            on:click={() => {
              searchQuery = "";
              scheduleSearch();
            }}
            class="absolute top-1/2 right-2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={$t("dashboard.media.clearSearch", "Clear search")}
            title={$t("dashboard.media.clearSearch", "Clear search")}
          >
            <X class="size-4" />
          </button>
        {/if}
      </div>

      <!-- flex-wrap, and a floor under each select: two of them now share this
           row, and at a 390px viewport an unwrapped row squeezes both below
           the width of their own longest option ("Cualquier acceso"). UI copy
           never truncates — the row wraps instead. -->
      <div class="flex flex-wrap items-center gap-2">
        <label class="sr-only" for="media-type-filter"
          >{$t("dashboard.media.filterByType", "Filter by type")}</label
        >
        <select
          id="media-type-filter"
          value={mediaType}
          on:change={changeMediaType}
          class="h-10 min-w-36 flex-1 rounded-lg border border-border bg-background px-3 text-sm transition-colors outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-36 sm:flex-none"
          aria-label={$t(
            "dashboard.media.filterByType",
            "Filter files by type",
          )}
        >
          <option value="all"
            >{$t("dashboard.media.allFiles", "All files")}</option
          >
          <option value="image">{$t("dashboard.media.images", "Images")}</option
          >
          <option value="video">{$t("dashboard.media.videos", "Videos")}</option
          >
          <option value="audio">{$t("dashboard.media.audio", "Audio")}</option>
          <option value="document"
            >{$t("dashboard.media.documents", "Documents")}</option
          >
        </select>

        <label class="sr-only" for="media-access-filter"
          >{$t("dashboard.media.filterByAccess", "Filter by access")}</label
        >
        <select
          id="media-access-filter"
          value={accessFilter}
          on:change={changeAccessFilter}
          data-media-filter="access"
          class="h-10 min-w-36 flex-1 rounded-lg border border-border bg-background px-3 text-sm transition-colors outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-36 sm:flex-none"
          aria-label={$t(
            "dashboard.media.filterByAccess",
            "Filter files by who can see them",
          )}
        >
          <option value="all"
            >{$t("dashboard.media.anyAccess", "Any access")}</option
          >
          <option value="public"
            >{$t("dashboard.media.accessPublic", "Public")}</option
          >
          <option value="members"
            >{$t("dashboard.media.accessMembers", "Subscribers")}</option
          >
          <option value="private"
            >{$t("dashboard.media.accessPrivate", "Private")}</option
          >
        </select>

        <button
          type="button"
          on:click={toggleSortOrder}
          data-sort-order={sortOrder}
          class="inline-flex h-10 w-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-0 text-sm font-medium transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none sm:w-36 sm:px-3"
          aria-label={sortOrder === "newest"
            ? $t(
                "dashboard.media.sortNewestAria",
                "Sort: Newest first. Click to reverse order.",
              )
            : $t(
                "dashboard.media.sortOldestAria",
                "Sort: Oldest first. Click to reverse order.",
              )}
          title={sortOrder === "newest"
            ? $t("dashboard.media.showingNewest", "Showing newest first")
            : $t("dashboard.media.showingOldest", "Showing oldest first")}
        >
          <ArrowDownUp
            class={`size-4 shrink-0 transition-transform duration-300 motion-reduce:transition-none ${sortOrder === "oldest" ? "rotate-180" : "rotate-0"}`}
          />
          <span class="hidden truncate sm:inline">
            {sortOrder === "newest"
              ? $t("dashboard.media.newest", "Newest")
              : $t("dashboard.media.oldest", "Oldest")}
          </span>
        </button>

        <div
          class="inline-flex h-10 items-center rounded-lg border border-border bg-background p-1"
        >
          <button
            type="button"
            on:click={() => changeViewMode("grid")}
            class={`inline-flex size-8 items-center justify-center rounded-md transition-colors ${viewMode === "grid" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            aria-label={$t("editor.gridView", "Grid view")}
            aria-pressed={viewMode === "grid"}
            title={$t("editor.gridView", "Grid view")}
          >
            <LayoutGrid class="size-4" />
          </button>
          <button
            type="button"
            on:click={() => changeViewMode("list")}
            class={`inline-flex size-8 items-center justify-center rounded-md transition-colors ${viewMode === "list" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            aria-label={$t("editor.listView", "List view")}
            aria-pressed={viewMode === "list"}
            title={$t("editor.listView", "List view")}
          >
            <List class="size-4" />
          </button>
        </div>

        <button
          class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background shadow-sm transition-all hover:bg-muted hover:text-foreground active:scale-95 disabled:opacity-50"
          on:click={handleUserRefresh}
          disabled={loadingMedia}
          aria-label={$t("dashboard.media.refreshLabel", "Refresh file list")}
          title={$t("dashboard.media.refreshLabel", "Refresh file list")}
        >
          <RefreshCw
            class={`h-4 w-4 ${userRefreshing ? "animate-spin" : ""}`}
          />
        </button>
      </div>
    </div>

    {#if mediaError}
      <div
        class="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive"
      >
        <AlertCircle class="h-4 w-4" />
        {mediaError}
      </div>
    {/if}

    {#if loadingMedia && !loadingMore && media.length === 0}
      <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each Array.from({ length: 8 }) as _, i}
          <div class="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div class="aspect-video w-full animate-pulse bg-muted"></div>
            <div class="space-y-3 p-4">
              <div class="h-4 w-3/4 animate-pulse rounded bg-muted"></div>
              <div class="flex justify-between">
                <div class="h-3 w-1/4 animate-pulse rounded bg-muted"></div>
                <div class="h-3 w-1/4 animate-pulse rounded bg-muted"></div>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {:else if media.length === 0 && !loadingMedia}
      <div
        class="flex flex-col items-center justify-center rounded-xl border border-dashed py-16 text-center"
        in:fade={{ duration: 300 }}
      >
        <div class="mb-4 rounded-full bg-muted p-4">
          <FilesIcon class="h-8 w-8 text-muted-foreground/50" />
        </div>
        {#if searchQuery.trim() || mediaType !== "all" || accessFilter !== "all"}
          <h3 class="text-lg font-semibold">
            {$t("dashboard.media.noMatchingTitle", "No matching files")}
          </h3>
          <p class="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
            {$t(
              "dashboard.media.noMatchingDescription",
              "Try another search or clear the current filter.",
            )}
          </p>
          <button
            type="button"
            on:click={clearFilters}
            class="mt-4 inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            {$t("dashboard.media.clearFilters", "Clear filters")}
          </button>
        {:else}
          <h3 class="text-lg font-semibold">
            {$t("dashboard.media.emptyTitle", "No files yet")}
          </h3>
          <p class="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
            {$t(
              "dashboard.media.emptyDescription",
              "Upload an image, video, audio file or PDF document to get started.",
            )}
          </p>
        {/if}
      </div>
    {:else}
      <div
        class={viewMode === "grid"
          ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          : "flex flex-col gap-3"}
        data-view={viewMode}
      >
        {#each media as item (item.id)}
          <article
            class={`group relative overflow-hidden rounded-xl border bg-card shadow-sm transition-all duration-300 hover:border-primary/20 hover:shadow-lg ${viewMode === "grid" ? "flex flex-col hover:-translate-y-1" : "flex min-h-28 flex-row"}`}
          >
            <!-- Thumbnail -->
            <div
              class={viewMode === "grid"
                ? "relative aspect-video w-full overflow-hidden bg-muted"
                : "relative w-28 shrink-0 overflow-hidden bg-muted sm:w-40"}
            >
              <button
                type="button"
                class={`block h-full w-full focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none focus-visible:ring-inset ${
                  mediaKind(item.mime_type, item.name) === "image"
                    ? "cursor-zoom-in"
                    : "cursor-pointer"
                }`}
                on:click={() => openPreview(item)}
                aria-label={$t("dashboard.media.preview", "Preview {name}", {
                  name: item.title || item.name,
                })}
              >
                {#if item.thumbnail || mediaKind(item.mime_type, item.name) === "image"}
                  <img
                    src={buildMediaUrl(item.thumbnail || item.url)}
                    alt={item.title || item.name}
                    class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                    loading="lazy"
                  />
                {:else if mediaKind(item.mime_type, item.name) === "video"}
                  <video
                    src={buildMediaUrl(item.url)}
                    title={item.title || item.name}
                    preload="metadata"
                    muted
                    playsinline
                    class="pointer-events-none h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  >
                    <track kind="captions" />
                  </video>
                {:else}
                  <!-- No thumbnail exists for these (get_thumbnail() returns
                       None for anything that is not an image), so the tile is
                       the identity of the file, not a placeholder for a
                       picture that failed: a type badge on a tinted panel. -->
                  <div
                    class={`flex h-full w-full flex-col items-center justify-center gap-1.5 bg-gradient-to-br transition-transform duration-500 group-hover:scale-105 ${
                      mediaKind(item.mime_type, item.name) === "audio"
                        ? "from-violet-500/10 to-violet-500/25 text-violet-700 dark:text-violet-300"
                        : "from-primary/5 to-primary/20 text-primary"
                    }`}
                    data-media-kind={mediaKind(item.mime_type, item.name)}
                    data-media-label={documentLabel(item.mime_type, item.name)}
                  >
                    <FileIcon class="h-8 w-8 opacity-70" />
                    <span
                      class="rounded border border-current px-1.5 py-0.5 text-[10px] font-bold tracking-widest uppercase"
                    >
                      {documentLabel(item.mime_type, item.name)}
                    </span>
                  </div>
                {/if}
              </button>

              <!-- Overlay Actions -->
              <div
                class="pointer-events-none absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/10"
              ></div>

              <div
                class="absolute top-2 right-2 z-10 flex gap-1.5 opacity-100 transition-all duration-200 sm:translate-y-2 sm:opacity-0 sm:group-focus-within:translate-y-0 sm:group-focus-within:opacity-100 sm:group-hover:translate-y-0 sm:group-hover:opacity-100"
              >
                <button
                  data-media-action="copy"
                  data-copied={copiedMediaId === item.id}
                  class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/95 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background hover:text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                  on:click={() => copyMediaLink(item)}
                  title={`${$t("dashboard.media.copyFullLink", "Copy full link")} — ${linkNote(item.access)}`}
                  aria-label={$t(
                    "dashboard.media.copyFullLinkFor",
                    "Copy full link for {name}",
                    { name: item.title || item.name },
                  )}
                >
                  {#if copiedMediaId === item.id}
                    <Check class="h-4 w-4 text-green-500" />
                  {:else}
                    <Copy class="h-4 w-4" />
                  {/if}
                </button>
                <!-- No Share on a private file. `/uploadz/` 401s every
                     recipient, so the sheet would hand out a link that cannot
                     work; Copy stays because the owner still wants the URL
                     (to paste into a draft they will publish later). -->
                {#if isShareableAccess(item.access)}
                  <button
                    data-media-action="share"
                    class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/95 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background hover:text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                    on:click={() => shareMedia(item)}
                    title={`${$t("dashboard.media.share", "Share")} — ${linkNote(item.access)}`}
                    aria-label={$t(
                      "dashboard.media.shareItem",
                      "Share {name}",
                      {
                        name: item.title || item.name,
                      },
                    )}
                  >
                    <Share2 class="h-4 w-4" />
                  </button>
                {/if}
              </div>
            </div>

            <!-- Info -->
            <div
              class={`flex min-w-0 flex-1 flex-col ${viewMode === "grid" ? "p-4" : "justify-center p-3 sm:p-4"}`}
            >
              <div class="mb-2">
                <h3
                  class="truncate text-sm font-semibold text-foreground"
                  title={item.title || item.name}
                >
                  {item.title || item.name}
                </h3>
                <p
                  class="truncate text-xs text-muted-foreground"
                  title={item.name}
                >
                  {item.name}
                </p>
              </div>

              <div
                class="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-3 text-xs text-muted-foreground"
              >
                <span class="font-medium">{formatBytes(item.sizeBytes)}</span>
                <span aria-hidden="true">·</span>
                <span>{formatDate(item.created_at)}</span>
                {#if item.access}
                  <!-- Access level, spelled out. A `private` file 401s for
                       everyone but the owner, so "copy link" needs this next
                       to it or it advertises a share that cannot work. -->
                  <span
                    data-media-access={item.access}
                    title={linkNote(item.access)}
                    class={`ml-auto rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                      normalizeMediaAccess(item.access) === "public"
                        ? "border-green-600/40 text-green-700 dark:text-green-400"
                        : "border-border"
                    }`}
                  >
                    {accessLabel(item.access)}
                  </span>
                {/if}
              </div>

              <!-- Actions. In the info block rather than floating over the
                   thumbnail: a document tile is only ~112px wide in list view
                   on a phone, and a hover-revealed overlay is unreachable by
                   touch anyway. -->
              <div class="mt-3 flex items-center gap-1">
                <button
                  type="button"
                  data-media-action="edit"
                  class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background text-foreground transition-colors hover:bg-muted hover:text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                  on:click={() => openEdit(item)}
                  title={$t("dashboard.media.edit", "Edit access and details")}
                  aria-label={$t(
                    "dashboard.media.editItem",
                    "Edit access and details for {name}",
                    { name: item.title || item.name },
                  )}
                >
                  <Pencil class="h-4 w-4" />
                </button>
                <a
                  data-media-action="download"
                  href={downloadHref(item)}
                  download={downloadName(item)}
                  class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background text-foreground transition-colors hover:bg-muted hover:text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                  title={$t("dashboard.media.download", "Download")}
                  aria-label={$t(
                    "dashboard.media.downloadItem",
                    "Download {name}",
                    { name: item.title || item.name },
                  )}
                >
                  <Download class="h-4 w-4" />
                </a>
                <button
                  type="button"
                  data-media-action="delete"
                  class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background text-foreground transition-colors hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-destructive focus-visible:outline-none"
                  on:click={() => confirmDelete(item)}
                  title={$t("dashboard.media.delete", "Delete")}
                  aria-label={$t(
                    "dashboard.media.deleteItem",
                    "Delete {name}",
                    {
                      name: item.title || item.name,
                    },
                  )}
                >
                  <Trash2 class="h-4 w-4" />
                </button>
              </div>
            </div>
          </article>
        {/each}
      </div>
    {/if}

    {#if hasNext}
      <div class="flex justify-center pt-8">
        <button
          class="group inline-flex items-center justify-center gap-2 rounded-full border border-border bg-background px-6 py-2.5 text-sm font-medium shadow-sm transition-all hover:bg-muted hover:shadow-md disabled:opacity-50"
          on:click={() => loadMedia(false)}
          disabled={loadingMore || loadingMedia}
        >
          {#if loadingMore}
            <Loader2 class="h-4 w-4 animate-spin" />
            <span>{$t("dashboard.media.loadingMore", "Loading more...")}</span>
          {:else}
            <span>{$t("dashboard.media.loadMore", "Load more")}</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="transition-transform group-hover:translate-y-0.5"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          {/if}
        </button>
      </div>
    {/if}
  </div>
</div>

{#if previewItem}
  <MediaPreviewDialog
    bind:open={previewOpen}
    url={buildMediaUrl(previewItem.url, true)}
    downloadUrl={downloadHref(previewItem)}
    title={previewItem.title || previewItem.name}
    mimeType={previewItem.mime_type || ""}
    onCopy={copyPreviewLink}
    onShare={sharePreview}
    canShare={isShareableAccess(previewItem.access)}
  />
{/if}

<Dialog.Root bind:open={editOpen}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>
        {$t("dashboard.media.editTitle", "Who can see this file?")}
      </Dialog.Title>
      <Dialog.Description>
        {$t(
          "dashboard.media.editDescription",
          "Change the access level, and give {name} a title and description you will recognise later.",
          { name: editTarget?.name || "" },
        )}
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4">
      <div class="space-y-1.5">
        <label
          class="text-sm font-medium"
          for="media-edit-access"
          data-media-edit="access-label"
        >
          {$t("dashboard.media.accessLabel", "Access")}
        </label>
        <select
          id="media-edit-access"
          data-media-edit="access"
          bind:value={editAccess}
          disabled={saving}
          class="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm transition-colors outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        >
          <option value="public"
            >{$t("dashboard.media.accessPublic", "Public")}</option
          >
          <option value="members"
            >{$t("dashboard.media.accessMembers", "Subscribers")}</option
          >
          <option value="private"
            >{$t("dashboard.media.accessPrivate", "Private")}</option
          >
        </select>
        <p class="text-xs text-muted-foreground">{accessHint(editAccess)}</p>
      </div>

      {#if accessNote}
        <!-- What happens to the LINK, which is a different question from what
             happens to the permissions, and is not the same in both
             directions. See the `accessNote` comment. -->
        <p
          class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200"
          data-media-edit="access-change-note"
        >
          {accessNote}
        </p>
      {/if}

      <div class="space-y-1.5">
        <label class="text-sm font-medium" for="media-edit-title">
          {$t("dashboard.media.titleLabel", "Title")}
        </label>
        <input
          id="media-edit-title"
          data-media-edit="title"
          type="text"
          bind:value={editTitle}
          disabled={saving}
          maxlength="128"
          placeholder={editTarget?.name || ""}
          class="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm transition-colors outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <div class="space-y-1.5">
        <label class="text-sm font-medium" for="media-edit-description">
          {$t("dashboard.media.descriptionLabel", "Description")}
        </label>
        <!-- 255 is `GenericFile.description`'s max_length; without this the
             server rejects the write after the user has typed the whole
             thing. -->
        <textarea
          id="media-edit-description"
          data-media-edit="description"
          bind:value={editDescription}
          disabled={saving}
          maxlength="255"
          rows="3"
          class="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
        ></textarea>
      </div>
    </div>

    <Dialog.Footer class="gap-2">
      <Button
        variant="outline"
        onclick={() => (editOpen = false)}
        disabled={saving}
      >
        {$t("dashboard.media.cancel", "Cancel")}
      </Button>
      <Button
        data-media-action="save-edit"
        onclick={saveEdit}
        disabled={saving}
      >
        {#if saving}
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {/if}
        {$t("dashboard.media.save", "Save")}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>
        {$t("dashboard.media.deleteTitle", "Delete this file?")}
      </Dialog.Title>
      <Dialog.Description>
        {$t(
          "dashboard.media.deleteDescription",
          "{name} will be removed permanently. Anywhere you have used it — a page cover, an attachment, your avatar — will lose it.",
          { name: deleteTarget?.title || deleteTarget?.name || "" },
        )}
      </Dialog.Description>
      <!-- Deliberately NOT "shared links will stop working": /uploadz/public/
           now sends `Cache-Control: public, max-age=300, s-maxage=3600,
           proxy-revalidate`. A rollout of that header does not rewrite a
           response already cached by a browser, and browser caches cannot be
           purged. Promising otherwise is a promise the system does not keep
           (codex review of, findings 1 and 2). -->
      <p class="text-sm text-muted-foreground">
        {$t(
          "dashboard.media.deleteCacheNote",
          "A link that has already been opened may keep working for a while from cache.",
        )}
      </p>
    </Dialog.Header>
    <Dialog.Footer class="gap-2">
      <Button
        variant="outline"
        onclick={() => (deleteOpen = false)}
        disabled={deleting}
      >
        {$t("dashboard.media.cancel", "Cancel")}
      </Button>
      <Button
        variant="destructive"
        data-media-action="confirm-delete"
        onclick={performDelete}
        disabled={deleting}
      >
        {#if deleting}
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {/if}
        {$t("dashboard.media.delete", "Delete")}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
