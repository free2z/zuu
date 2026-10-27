<script lang="ts">
  import * as env from "$app/env/public";
  import { onDestroy, onMount, createEventDispatcher } from "svelte";
  import { fade, fly, slide, scale } from "svelte/transition";
  import { apiFetch, ensureCSRFToken } from "$lib/api/config";
  import { toast, captureAccountToast } from "$lib/toast.js";
  import {
    UploadCloud,
    File as FileIcon,
    X,
    Check,
    AlertCircle,
    RotateCcw,
    Copy,
    ExternalLink,
    Eye,
  } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { getCurrentLocale, tStore as t } from "$lib/i18n";
  import MediaPreviewDialog from "./MediaPreviewDialog.svelte";
  import { absoluteMediaUrl } from "./mediaUrl.js";
  import { copyTextToClipboard } from "./clipboard.js";
  import { createDropZone } from "./dropZone.js";
  import {
    UPLOAD_ACCEPT_ATTRIBUTE,
    documentLabel,
    isSupportedUploadFile,
  } from "./supportedUploadTypes";
  import {
    DEFAULT_UPLOAD_ACCESS,
    isShareableAccess,
    normalizeMediaAccess,
    type MediaAccess,
  } from "./mediaAccess";
  import {
    checkUploadSize,
    confirmOversize,
    formatByteLimit,
    isEnvelopeOverage,
    loadUploadLimit,
    nextUploadTier,
    refreshUploadLimit,
    type OversizeUpload,
    type UploadLimit,
  } from "./uploadLimit";
  import {
    UploadRequestError,
    uploadErrorMessage,
    watchUploadStall,
  } from "./uploadRequest";

  const dispatch = createEventDispatcher();

  type UploadStatus = "queued" | "uploading" | "processing" | "done" | "error";

  type UploadItem = {
    notice: ReturnType<typeof captureAccountToast>;
    id: string;
    file: File;
    /**
     * The access level chosen when this file was QUEUED, not the live value of
     * the picker. Changing the picker mid-batch must not retroactively publish
     * a file the user already dropped under a different setting.
     */
    access: MediaAccess;
    previewUrl?: string;
    progress: number;
    status: UploadStatus;
    error?: string;
    /** Complete absolute public URL, from the API response. */
    publicUrl?: string;
    remoteMime?: string;
    remoteTitle?: string;
    /** Server-side access level of the stored file, as it came back. */
    remoteAccess?: string;
    /** The <img>/<video> failed to load; actions must still be reachable. */
    previewFailed?: boolean;
  };

  const apiBase = (env.PUBLIC_API_BASE_URL || "").replace(/\/$/, "");
  const buildApiUrl = (path: string) => `${apiBase}${path}`;

  const formatBytes = (bytes?: number) => {
    if (!bytes || Number.isNaN(bytes)) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 || value % 1 === 0 ? 0 : 1)} ${units[unitIndex]}`;
  };

  let dragActive = false;
  /**
   * One picker for the whole batch rather than a control per queued file. The
   * queue starts uploading the moment a file lands (there is no "start" step
   * to hang a per-file choice off), so a per-row control would either be a
   * setting that arrives too late or would have to stop the drop-and-go flow.
   * Anything the batch got wrong is fixable per file from the library.
   */
  let uploadAccess: MediaAccess = DEFAULT_UPLOAD_ACCESS;
  let uploadQueue: UploadItem[] = [];
  let isUploading = false;
  let destroyed = false;
  const activeRequests = new Map<string, XMLHttpRequest>();
  const cancelledUploads = new Set<string>();

  /**
   * The creator's upload ceiling, as the SERVER reports it
   * (`GET /api/uploads/limits/`). `null` until the first answer arrives — and
   * `null` for good if it cannot be read, in which case nothing here refuses
   * anything and nothing claims a number. There is no fallback table: a
   * hardcoded copy of the server's tiers is the bug this replaces.
   */
  let uploadLimit: UploadLimit | null = null;

  onMount(() => {
    // Fired on mount rather than on the first drop: the whole point is that
    // the limit is on screen BEFORE the creator picks a file.
    void loadUploadLimit({ request: apiFetch, apiBase }).then((limit) => {
      if (!destroyed) uploadLimit = limit;
    });
  });

  // `$:` and not `const` for the three below: they read `$t`, and a template
  // expression that merely calls a const would not re-run on a locale switch.

  /**
   * "Hold N 2Z and you get X" — or "" at the top of the ladder.
   *
   * `min_tuzis` is stated as the server sent it, with no "any 2Z" shorthand:
   * the server compares the balance TRUNCATED to a whole number, so 0.5 2Z is
   * still the free tier and "hold any 2Z" would be a promise the ladder does
   * not keep. (Raised by the codex review of this PR.)
   */
  $: upgradeSentence = (
    tier: { min_tuzis: number; max_bytes: number } | null,
  ) => {
    if (!tier) return "";
    const locale = getCurrentLocale();
    return $t(
      "media.uploadLimitUpgrade",
      "Hold {tuzis} 2Z to raise the upload request cap to {limit}.",
      {
        tuzis: tier.min_tuzis.toLocaleString(locale),
        limit: formatByteLimit(tier.max_bytes, locale),
      },
    );
  };

  /** Why one named file was refused, and what would let it through. */
  $: oversizeMessage = (oversize: OversizeUpload) => {
    const locale = getCurrentLocale();
    const size = formatByteLimit(oversize.fileBytes, locale);
    const limit = formatByteLimit(oversize.maxBytes, locale);

    // A file that fits but whose REQUEST did not gets its own sentence.
    // "Your 5 MB file is over your 5 MB limit" reads as a bug, and the way
    // out is different: trim the file, not buy 2Z.
    if (isEnvelopeOverage(oversize)) {
      return $t(
        "media.fileAtLimit",
        "{filename} is {size} and your limit is {limit} — the upload carries a little more than the file itself, so this one still does not fit. Try a slightly smaller file.",
        { filename: oversize.fileName, size, limit },
      );
    }

    const reason = $t(
      "media.fileTooLarge",
      "{filename} is {size} — your upload limit is {limit}.",
      { filename: oversize.fileName, size, limit },
    );
    const upgrade = upgradeSentence(oversize.nextTier);
    return upgrade ? `${reason} ${upgrade}` : reason;
  };

  /**
   * The standing note under the drop zone. Empty while the limit is unknown —
   * an uploader that says nothing is honest; one that guesses is not.
   */
  $: uploadLimitHint = uploadLimit
    ? [
        $t(
          "media.uploadLimitHint",
          "Upload request cap: {limit} (includes multipart overhead).",
          {
            limit: formatByteLimit(uploadLimit.max_bytes, getCurrentLocale()),
          },
        ),
        upgradeSentence(nextUploadTier(uploadLimit)),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  // The accepted-type gate is DERIVED, not restated — see
  // supportedUploadTypes.ts. This component used to carry its own literal set
  // (jpeg/png/gif/webp/mp4) which had fallen ~10 types behind the server,
  // rejecting PDFs in the browser before any request was made.
  //
  // image/svg+xml is absent for the same reason it is absent server-side
  //an SVG is a scriptable document served inline from the
  // cookie-bearing origin. It is not on the server allowlist, so it cannot
  // appear here.
  const isMediaFile = (file: File) => isSupportedUploadFile(file);

  const createUploadId = () =>
    globalThis.crypto?.randomUUID?.() ||
    `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const addFiles = async (fileList: FileList | File[]) => {
    const operationNotice = captureAccountToast();
    // SAMPLED AT DROP TIME, before anything is awaited. `UploadItem.access`
    // documents that changing the picker mid-batch must not retroactively
    // publish a file that was dropped under a different setting — and the
    // size confirmation below introduced exactly that window: an await during
    // which the creator can flip the picker to Public, after which a `private`
    // drop would have been queued as public. (Raised by the codex review of
    // this PR; the previous reading of `uploadAccess` was synchronous, so this
    // was safe until the await appeared.)
    const access = uploadAccess;
    const files = Array.from(fileList);
    const acceptedFiles = files.filter(isMediaFile);
    const rejectedCount = files.length - acceptedFiles.length;

    if (rejectedCount > 0) {
      operationNotice.error(
        rejectedCount === 1
          ? $t(
              "media.unsupportedFile",
              "That file type cannot be uploaded. Images, video, audio and PDF documents are supported.",
            )
          : $t(
              "media.unsupportedFiles",
              "{count} files were skipped — only images, video, audio and PDF documents can be uploaded.",
              { count: rejectedCount },
            ),
      );
    }

    if (acceptedFiles.length === 0) return;

    // Size gate, BEFORE a byte goes up. nginx refuses an oversize body with a
    // bodiless 403, so without this the creator waits out a full upload of a
    // file that was never going to be stored and is told only "403".
    //
    // Advisory, and skipped entirely while the limit is unknown: the server is
    // what enforces this, and a limit we could not read must never become a
    // refusal we invented. `confirmOversize` re-reads before refusing anything
    // a stale snapshot may permit, but only a fresh one may refuse.
    const { limit: confirmedLimit, oversize: oversized } =
      await confirmOversize(acceptedFiles, {
        request: apiFetch,
        apiBase,
        limit: uploadLimit,
      });
    // Only a SUCCESSFUL re-read replaces what is on screen. A network blip
    // must not blank the standing hint — the decision above already used the
    // fresh answer (i.e. refused nothing), and the last number we actually
    // heard is still the best thing to show.
    if (!destroyed && confirmedLimit) uploadLimit = confirmedLimit;
    // Re-checked against the CONFIRMED limit rather than filtered by name:
    // a batch can hold two different files called `IMG_0001.jpg`.
    const sendableFiles = acceptedFiles.filter(
      (file) => checkUploadSize(file, confirmedLimit) === null,
    );

    // Same reason the send path checks it below: the confirmation is an await,
    // and a toast is global — a destroyed uploader must not raise its refusal
    // on whatever page the creator moved to. (Round 8 of the codex review;
    // this branch was the one the earlier guards missed.)
    if (destroyed) return;

    if (oversized.length === 1) {
      operationNotice.error(oversizeMessage(oversized[0]));
    } else if (oversized.length > 1) {
      const locale = getCurrentLocale();
      const reason = $t(
        "media.filesTooLarge",
        "{count} files are over your {limit} upload limit.",
        {
          count: oversized.length,
          limit: formatByteLimit(oversized[0].maxBytes, locale),
        },
      );
      const upgrade = upgradeSentence(oversized[0].nextTier);
      operationNotice.error(upgrade ? `${reason} ${upgrade}` : reason);
    }

    // Object URLs below are created only for files that will actually be
    // uploaded; `onDestroy` has already walked an empty queue by now, so one
    // created after this point is never revoked — a multi-gigabyte blob held
    // until a full page reload. The `destroyed` check above covers it.
    if (sendableFiles.length === 0) return;

    const newItems: UploadItem[] = sendableFiles.map((file) => ({
      notice: operationNotice,
      id: createUploadId(),
      file,
      access,
      // Images *and* videos get a local object-URL preview: instant, no
      // round trip, and it works before the file is even uploaded.
      previewUrl:
        file.type.startsWith("image") || file.type.startsWith("video")
          ? URL.createObjectURL(file)
          : undefined,
      progress: 0,
      status: "queued",
    }));
    uploadQueue = [...uploadQueue, ...newItems];
    void startUploads();
  };

  const imageFilesFromClipboard = (clipboard: DataTransfer | null) => {
    if (!clipboard) return [];

    const itemFiles = Array.from(clipboard.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (itemFiles.length > 0) return itemFiles;

    return Array.from(clipboard.files).filter((file) =>
      file.type.startsWith("image/"),
    );
  };

  const handlePaste = (event: ClipboardEvent) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.matches("input, textarea") ||
        target.isContentEditable ||
        target.closest('[contenteditable="true"]'))
    ) {
      return;
    }

    const images = imageFilesFromClipboard(event.clipboardData);
    if (images.length === 0) return;

    event.preventDefault();
    void addFiles(images);
  };

  const {
    handleZoneDrag,
    handleZoneDrop,
    handleWindowDragOver,
    handleWindowDragLeave,
    handleWindowDrop,
  } = createDropZone({
    onFiles: (files) => void addFiles(files),
    onActiveChange: (active) => {
      dragActive = active;
    },
    onStrayDrop: () =>
      toast.error(
        $t(
          "media.dropMissedTarget",
          "Drop files on the upload area to add them.",
        ),
      ),
  });

  type CreatedUpload = {
    url?: string;
    name?: string;
    title?: string;
    mime_type?: string;
    access?: string;
  };

  /**
   * /uploads/handle answers with the created records (a one-element list
   * here — one request per file). Tolerate an empty or non-JSON body: an
   * older backend returned a bare 201, and a missing URL must degrade to
   * "no link actions", never to a failed upload.
   */
  const parseUploadResponse = (body: string): CreatedUpload | null => {
    if (!body) return null;
    try {
      const parsed = JSON.parse(body);
      const record = Array.isArray(parsed) ? parsed[0] : parsed;
      return record && typeof record === "object" ? record : null;
    } catch {
      return null;
    }
  };

  /**
   * Who can open the stored file's link, said plainly next to the link
   * actions. Uploads default to private, and a private blob 401s for every
   * recipient — advertising "copy link" without this is advertising a share
   * that cannot work.
   */
  // `$:` and not `const`: the body reads `$t`, and a template expression that
  // calls this does not depend on `$t`, so a plain const would leave the note
  // in the previous language after a locale switch.
  $: uploadAccessNote = (access?: string | null) => {
    const level = normalizeMediaAccess(access);
    if (level === "public")
      return $t(
        "media.publicLink",
        "Public — anyone with the link can open it",
      );
    if (level === "members")
      return $t(
        "media.membersLink",
        "Subscribers only — nobody else can open it",
      );
    return $t("media.privateLink", "Private — only you can open it");
  };

  let copiedId: string | null = null;
  let copiedResetTimer: ReturnType<typeof setTimeout> | null = null;
  let previewItem: UploadItem | null = null;
  let previewOpen = false;

  const copyPublicUrl = async (item: UploadItem) => {
    if (!item.publicUrl) return;
    const copied = await copyTextToClipboard(item.publicUrl);
    if (!copied) {
      toast.error($t("media.copyFailed", "Failed to copy link"));
      return;
    }
    toast.success($t("media.linkCopied", "Link copied to clipboard"));
    copiedId = item.id;
    if (copiedResetTimer) clearTimeout(copiedResetTimer);
    copiedResetTimer = setTimeout(() => {
      copiedId = null;
      copiedResetTimer = null;
    }, 2000);
  };

  const openPreview = (item: UploadItem) => {
    previewItem = item;
    previewOpen = true;
  };

  // The dialog's Copy and Share buttons had no handlers at all — both fell
  // through to the component's no-op defaults and did nothing. That was
  // invisible while every upload was private and the buttons were equally
  // dead; now that a public upload is possible, Share has to actually share.
  const copyPreviewUrl = () => {
    if (previewItem) void copyPublicUrl(previewItem);
  };

  const sharePreviewUrl = async () => {
    const item = previewItem;
    if (!item?.publicUrl) return;
    if (!isShareableAccess(item.remoteAccess)) {
      await copyPublicUrl(item);
      return;
    }
    if (navigator.share) {
      try {
        await navigator.share({
          title: item.remoteTitle || item.file.name,
          url: item.publicUrl,
        });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
      }
    }
    await copyPublicUrl(item);
  };

  const markPreviewFailed = (id: string) => {
    setUploadState(id, { previewFailed: true });
  };

  const setUploadState = (id: string, partial: Partial<UploadItem>) => {
    uploadQueue = uploadQueue.map((item) =>
      item.id === id ? { ...item, ...partial } : item,
    );
  };

  const uploadSingle = async (item: UploadItem) => {
    setUploadState(item.id, {
      status: "uploading",
      progress: 1,
      error: undefined,
    });

    const formData = new FormData();
    formData.append("files", item.file);
    formData.append(
      "body",
      JSON.stringify([
        {
          title: item.file.name,
          name: item.file.name,
          // The level chosen for this file when it was queued. `access` is a
          // ChoiceField on GenericFileSerializer, so an unrecognised value is
          // a 400 rather than a silently stored one — normalize anyway so a
          // corrupted client state cannot turn a file public.
          access: normalizeMediaAccess(item.access),
        },
      ]),
    );

    try {
      const csrf = await ensureCSRFToken();
      if (
        destroyed ||
        cancelledUploads.has(item.id) ||
        !uploadQueue.some((queuedItem) => queuedItem.id === item.id)
      ) {
        return false;
      }
      return await sendUpload(item, formData, csrf);
    } catch (error) {
      setUploadState(item.id, {
        status: "error",
        error:
          error instanceof Error ? error.message : "Could not start upload",
        progress: 0,
      });
      item.notice.error(`${item.file.name} failed to upload`);
      return false;
    }
  };

  /**
   * Turn a rejection status into something a person can act on.
   *
   * A 403 here is nginx's `@deny_upload`: `return 403` with no body at all,
   * which is also what Django answers a failed CSRF check with. Neither says
   * why. So the limit is re-read — authoritative, and unlike the cached copy
   * it also settles the race the pre-flight check cannot: if the balance
   * dropped a rung while the page was open, the file really was too large and
   * the stale ceiling said otherwise.
   *
   * `status === 0` is the SAME refusal seen from the other side.
   * `@deny_upload` sets `Connection: close` and the body is still being sent
   * (`proxy_request_buffering off`), so the browser can hit a reset before it
   * ever reads the response and dispatch `onerror` instead of `onload`. That
   * path used to end at a hardcoded "Network error", which is the wrong story
   * for the most likely cause of it. (Raised by the codex review of this PR.)
   */
  const describeUploadFailure = async (
    item: UploadItem,
    status: number,
    /**
     * `xhr.upload`'s progress `total`: the exact size of the multipart body,
     * which is the number nginx compared (`X-Original-Content-Length`), not
     * the file's own size. Undefined if no progress event ever fired.
     */
    requestBytes?: number,
  ) => {
    // 403 — nginx's `@deny_upload`, the auth-subrequest refusal.
    // 413 — the INDEPENDENT `client_max_body_size` boundary in both nginx
    //       layers, which a request at the top tier can cross on the envelope
    //       alone before the subrequest ever answers.
    // 0   — either of those seen as a transport error, because the refusal
    //       closes the connection while the body is still going out.
    // Everything else is not a quota story and must not be told as one.
    if (status !== 403 && status !== 413 && status !== 0) {
      return namedFailure(
        item,
        $t("media.uploadFailedStatus", "Upload failed ({status})", {
          status,
        }),
      );
    }

    const fresh = await refreshUploadLimit({ request: apiFetch, apiBase });
    if (!destroyed && fresh) uploadLimit = fresh;

    const oversize = checkUploadSize(item.file, fresh, requestBytes);
    if (oversize) return oversizeMessage(oversize);

    // Not a quota problem as far as we can tell, so name the likeliest cause
    // for the shape of failure we actually saw.
    return namedFailure(
      item,
      status === 0
        ? $t(
            "media.uploadNetworkError",
            "The upload did not reach the server. Check your connection and try again.",
          )
        : $t(
            "media.uploadRefused",
            "The server refused this upload. Your session may have expired — reload the page and try again.",
          ),
    );
  };

  /**
   * "photo.jpg (1.8 MB): …" — which file, and how big. A queue can hold many
   * files and the toast outlives the row it came from; "Upload failed (500)"
   * alone does not say which one to retry.
   */
  const namedFailure = (item: UploadItem, reason: string) =>
    $t("media.uploadFailedNamed", "{filename} ({size}): {reason}", {
      filename: item.file.name,
      size: formatByteLimit(item.file.size, getCurrentLocale()),
      reason,
    });

  const sendUpload = (
    item: UploadItem,
    formData: FormData,
    csrf?: string | null,
  ) =>
    new Promise<boolean>((resolve) => {
      const xhr = new XMLHttpRequest();
      activeRequests.set(item.id, xhr);
      /** Set by the stall watch (armed below) just before it aborts. */
      let stalled = false;
      xhr.open("POST", buildApiUrl("/uploads/handle"), true);
      xhr.withCredentials = true;
      if (csrf) xhr.setRequestHeader("X-CSRFToken", csrf);

      // The size of the multipart body the browser is sending — the file plus
      // the boundaries, part headers, filename and JSON metadata field. THIS
      // is what nginx compares against the limit, so it is what a 403 has to
      // be explained with: a file of exactly `max_bytes` is refused, and
      // saying "your session may have expired" about it is wrong twice over.
      // (Raised by the codex review of this PR.)
      let requestBytes: number | undefined;
      xhr.upload.onloadstart = (event) => {
        if (event.lengthComputable) requestBytes = event.total;
      };

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        requestBytes = event.total;
        const pct = (event.loaded / event.total) * 100;
        setUploadState(item.id, {
          progress: Math.min(99, Math.floor(pct)),
          status: pct >= 100 ? "processing" : "uploading",
        });
      };

      xhr.onload = async () => {
        activeRequests.delete(item.id);
        if (xhr.status >= 200 && xhr.status < 300) {
          const created = parseUploadResponse(xhr.responseText);
          setUploadState(item.id, {
            status: "done",
            progress: 100,
            // absoluteMediaUrl blocks any non-http(s) scheme and leaves the
            // percent-encoded path intact, so this is byte-for-byte usable.
            publicUrl: created?.url
              ? absoluteMediaUrl(created.url, apiBase)
              : undefined,
            remoteMime: created?.mime_type,
            remoteTitle: created?.title || created?.name,
            remoteAccess: created?.access,
          });
          item.notice.success(`${item.file.name} uploaded`);
          resolve(true);
        } else {
          // The status alone was the whole message here, so a quota rejection
          // and an expired session were both just "Upload failed (403)".
          const message = await describeUploadFailure(
            item,
            xhr.status,
            requestBytes,
          );
          // The explanation may have waited on a limit read, and `onDestroy`
          // cannot cancel work that is already past the abort. A toast is
          // global: without this a dead uploader pops an error onto whatever
          // page the creator moved to, seconds later.
          if (destroyed) {
            resolve(false);
            return;
          }
          setUploadState(item.id, {
            status: "error",
            error: message,
            progress: 0,
          });
          item.notice.error(message);
          resolve(false);
        }
      };

      xhr.onerror = async () => {
        activeRequests.delete(item.id);
        // Status 0, through the same explanation: an upload nginx refused
        // mid-body arrives here as a transport error, not as a 403.
        const message = await describeUploadFailure(item, 0, requestBytes);
        if (destroyed) {
          resolve(false);
          return;
        }
        setUploadState(item.id, {
          status: "error",
          error: message,
          progress: 0,
        });
        item.notice.error(message);
        resolve(false);
      };

      xhr.onabort = () => {
        activeRequests.delete(item.id);
        // Aborted by the stall watch rather than by the creator removing the
        // row: that is a failure, and it must say so. Before this an
        // upload nginx stopped reading sat at its last percentage forever.
        if (stalled && !destroyed) {
          const message = uploadErrorMessage(
            new UploadRequestError("Upload stalled", 0, {
              kind: "stalled",
              fileName: item.file.name,
              fileBytes: item.file.size,
            }),
            $t,
            getCurrentLocale(),
          );
          setUploadState(item.id, {
            status: "error",
            error: message,
            progress: 0,
          });
          item.notice.error(message);
        }
        resolve(false);
      };

      // Bounded by PROGRESS, not by a wall clock: a 33 MB video on a slow
      // link is a legitimate long upload, a counter that has not moved for
      // the stall window is not. Armed before `send()` so upload listeners
      // are registered in time. It disarms itself on `loadend`.
      watchUploadStall(xhr, {
        onStall: () => {
          stalled = true;
        },
      });

      xhr.send(formData);
    });

  const startUploads = async () => {
    if (isUploading) return;
    isUploading = true;
    let uploadedAny = false;

    try {
      while (true) {
        if (destroyed) break;
        const nextItem = uploadQueue.find((item) => item.status === "queued");
        if (!nextItem) break;
        uploadedAny = (await uploadSingle(nextItem)) || uploadedAny;
      }
    } finally {
      isUploading = false;
      if (uploadedAny && !destroyed) dispatch("upload-success");

      // Files can be added while an earlier request is completing. Claim any
      // item that arrived at that boundary instead of leaving it queued.
      if (!destroyed && uploadQueue.some((item) => item.status === "queued")) {
        void startUploads();
      }
    }
  };

  const removeUpload = (id: string) => {
    const item = uploadQueue.find((upload) => upload.id === id);
    cancelledUploads.add(id);
    activeRequests.get(id)?.abort();
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    if (previewItem?.id === id) {
      previewOpen = false;
      previewItem = null;
    }
    uploadQueue = uploadQueue.filter((item) => item.id !== id);
  };

  const retryUpload = (id: string) => {
    setUploadState(id, {
      notice: captureAccountToast(),
      status: "queued",
      progress: 0,
      error: undefined,
    });
    void startUploads();
  };

  onDestroy(() => {
    destroyed = true;
    if (copiedResetTimer) clearTimeout(copiedResetTimer);
    activeRequests.forEach((xhr) => xhr.abort());
    activeRequests.clear();
    uploadQueue.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
  });
</script>

<svelte:window
  on:paste={handlePaste}
  on:dragover={handleWindowDragOver}
  on:dragleave={handleWindowDragLeave}
  on:drop={handleWindowDrop}
/>

<div class="space-y-4">
  <!-- Upload Area -->
  <div
    class={`group relative overflow-hidden rounded-xl border-2 border-dashed transition-colors duration-200 ease-out
      ${dragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25"}`}
    role="region"
    aria-label="Upload files by dragging or selecting"
    data-drag-active={dragActive}
    on:dragenter={handleZoneDrag}
    on:dragover={handleZoneDrag}
    on:dragleave={handleZoneDrag}
    on:drop={handleZoneDrop}
  >
    <div
      class="flex flex-col items-center justify-center gap-4 py-8 text-center sm:py-12"
    >
      <div
        class={`rounded-full p-4 transition-colors duration-200 ${dragActive ? "bg-primary/10" : "bg-muted"}`}
      >
        <UploadCloud
          class={`h-8 w-8 transition-colors ${dragActive ? "text-primary" : "text-muted-foreground"}`}
        />
      </div>
      <div class="space-y-1">
        <p class="text-lg font-medium">
          <span class="hidden sm:inline"
            >{$t("media.dropFilesOr", "Drop files or")}&nbsp;</span
          >
          <label
            class="cursor-pointer text-primary underline-offset-4 hover:underline"
            for="file-input"
          >
            {$t("media.browse", "browse")}
          </label>
        </p>
        <p class="text-sm text-muted-foreground" data-upload-hint>
          {$t("media.supportedTypesHint", "Images, video, audio & PDF")}
          <span class="hidden sm:inline"
            >· {$t("media.pasteHint", "Paste with ⌘/Ctrl + V")}</span
          >
        </p>
        <!-- The size ceiling, said BEFORE a file is picked — it used to be
             discoverable only by waiting out a doomed upload and reading
             "403". Absent, rather than guessed, while the limit is unknown. -->
        {#if uploadLimitHint}
          <p class="text-xs text-muted-foreground" data-upload-limit-hint>
            {uploadLimitHint}
          </p>
        {/if}
      </div>
      <!-- Access is chosen BEFORE the drop, because the queue starts
           uploading as soon as a file lands. It applies to files added from
           here on; anything already queued keeps the level it was queued
           with, and every file can be changed afterwards from the library. -->
      <div class="flex flex-wrap items-center justify-center gap-2 px-4">
        <label
          class="text-xs font-medium text-muted-foreground"
          for="upload-access"
        >
          {$t("media.accessLabel", "Who can see it?")}
        </label>
        <select
          id="upload-access"
          data-upload-access-picker
          bind:value={uploadAccess}
          class="h-9 rounded-lg border border-border bg-background px-3 text-sm transition-colors outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        >
          <option value="public">{$t("media.accessPublic", "Public")}</option>
          <option value="members"
            >{$t("media.accessMembers", "Subscribers")}</option
          >
          <option value="private">{$t("media.accessPrivate", "Private")}</option
          >
        </select>
        <span class="text-xs text-muted-foreground"
          >{uploadAccessNote(uploadAccess)}</span
        >
      </div>
      <input
        id="file-input"
        type="file"
        multiple
        accept={UPLOAD_ACCEPT_ATTRIBUTE}
        class="hidden"
        on:change={(event) => {
          const input = event.currentTarget as HTMLInputElement;
          if (input.files) void addFiles(input.files);
          input.value = ""; // Reset input
        }}
      />
    </div>

    {#if dragActive}
      <!-- pointer-events-none: an overlay that swallows pointer events
           would fire its own dragenter/dragleave pairs and, worse, become
           the drop target — the drop would land on a node with no handler. -->
      <div
        class="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-[2px]"
        data-drop-overlay
        in:fade={{ duration: 150 }}
      >
        <div
          class="rounded-full bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground"
          in:scale={{ start: 0.95, duration: 150 }}
        >
          {$t("media.dropToUpload", "Drop files to upload")}
        </div>
      </div>
    {/if}
  </div>

  <!-- Upload Queue -->
  {#if uploadQueue.length > 0}
    <div class="space-y-4" transition:slide={{ axis: "y", duration: 300 }}>
      <div class="flex items-center justify-between">
        <h2
          class="text-sm font-semibold tracking-tight text-muted-foreground uppercase"
        >
          Active Uploads
        </h2>
        <span
          class="rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
        >
          {uploadQueue.filter(
            (i) => i.status === "uploading" || i.status === "queued",
          ).length} remaining
        </span>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        {#each uploadQueue as item (item.id)}
          <div
            class="group relative flex items-start gap-3 overflow-hidden rounded-lg border bg-card p-3 shadow-sm"
            in:fly={{ y: 10, duration: 300 }}
            out:fade={{ duration: 200 }}
          >
            <!-- Preview / Icon -->
            <div
              class="relative h-12 w-12 shrink-0 overflow-hidden rounded-md border bg-muted"
            >
              {#if item.previewUrl && !item.previewFailed && item.file.type.startsWith("image")}
                <img
                  src={item.previewUrl}
                  alt={item.file.name}
                  class="h-full w-full object-cover"
                  on:error={() => markPreviewFailed(item.id)}
                />
              {:else if item.previewUrl && !item.previewFailed && item.file.type.startsWith("video")}
                <!-- svelte-ignore a11y-media-has-caption -->
                <video
                  src={item.previewUrl}
                  title={item.file.name}
                  preload="metadata"
                  muted
                  playsinline
                  class="pointer-events-none h-full w-full object-cover"
                  on:error={() => markPreviewFailed(item.id)}
                ></video>
              {:else}
                <!-- A PDF has no thumbnail. It gets a labelled document tile,
                     not a broken image and not a nondescript grey square. -->
                <div
                  class="flex h-full w-full flex-col items-center justify-center gap-0.5 bg-muted text-muted-foreground"
                  data-upload-document={documentLabel(
                    item.file.type,
                    item.file.name,
                  )}
                >
                  <FileIcon class="h-4 w-4" />
                  <span
                    class="text-[9px] leading-none font-semibold tracking-wide"
                  >
                    {documentLabel(item.file.type, item.file.name)}
                  </span>
                </div>
              {/if}
              {#if item.status === "done"}
                <div
                  class="absolute inset-0 flex items-center justify-center bg-green-500/20 backdrop-blur-[1px]"
                >
                  <Check class="h-5 w-5 text-green-600 drop-shadow-sm" />
                </div>
              {:else if item.status === "error"}
                <div
                  class="absolute inset-0 flex items-center justify-center bg-destructive/20 backdrop-blur-[1px]"
                >
                  <AlertCircle
                    class="h-5 w-5 text-destructive drop-shadow-sm"
                  />
                </div>
              {/if}
            </div>

            <!-- Content -->
            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
              <div class="flex items-start justify-between gap-2">
                <p
                  class="truncate text-sm leading-none font-medium"
                  title={item.file.name}
                >
                  {item.file.name}
                </p>
                <div class="flex items-center gap-1">
                  {#if item.status === "error"}
                    <Button
                      variant="ghost"
                      size="icon"
                      class="h-6 w-6 text-muted-foreground transition-colors hover:bg-transparent hover:text-primary"
                      onclick={() => retryUpload(item.id)}
                      aria-label={`Retry ${item.file.name}`}
                    >
                      <RotateCcw class="h-3.5 w-3.5" />
                    </Button>
                  {/if}
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-6 w-6 text-muted-foreground/50 transition-colors hover:bg-transparent hover:text-destructive"
                    onclick={() => removeUpload(item.id)}
                    aria-label={`Remove ${item.file.name}`}
                  >
                    <X class="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div
                class="flex items-center justify-between text-xs text-muted-foreground"
              >
                <span>{formatBytes(item.file.size)}</span>
                <span
                  class:text-destructive={item.status === "error"}
                  class:text-green-600={item.status === "done"}
                >
                  {#if item.status === "uploading"}
                    {Math.round(item.progress)}%
                  {:else if item.status === "processing"}
                    Processing...
                  {:else}
                    {item.status}
                  {/if}
                </span>
              </div>

              <!-- Progress Bar -->
              <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  class={`h-full transition-all duration-300 ease-out
                    ${item.status === "error" ? "bg-destructive" : "bg-primary"}
                    ${item.status === "done" ? "bg-green-500" : ""}
                  `}
                  style={`width: ${Math.max(5, item.progress)}%`}
                >
                  {#if item.status === "uploading" || item.status === "processing"}
                    <div
                      class="animate-progress-stripe h-full w-full bg-[linear-gradient(45deg,rgba(255,255,255,0.15)_25%,transparent_25%,transparent_50%,rgba(255,255,255,0.15)_50%,rgba(255,255,255,0.15)_75%,transparent_75%,transparent)] bg-[length:1rem_1rem]"
                    ></div>
                  {/if}
                </div>
              </div>

              <!-- Completed-upload actions. Rendered from the URL the
                   API returned, so preview / copy / open all use the exact
                   same complete public URL. A broken preview only removes
                   the preview button, never the link actions. -->
              {#if item.status === "done" && item.publicUrl}
                <div class="flex flex-wrap items-center gap-1 pt-1">
                  {#if item.remoteAccess}
                    <!-- The level the SERVER stored, not the one we asked
                         for. Say who the link works for instead of leaving
                         the user to guess from a copy button. -->
                    <span
                      data-upload-access={item.remoteAccess}
                      class="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
                    >
                      {uploadAccessNote(item.remoteAccess)}
                    </span>
                  {/if}
                  {#if item.previewUrl && !item.previewFailed}
                    <Button
                      variant="ghost"
                      size="sm"
                      class="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-primary"
                      data-upload-action="preview"
                      onclick={() => openPreview(item)}
                      aria-label={`${$t("media.preview", "Preview")} ${item.file.name}`}
                    >
                      <Eye class="h-3.5 w-3.5" />
                      <span>{$t("media.preview", "Preview")}</span>
                    </Button>
                  {/if}
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-primary"
                    data-upload-action="copy"
                    data-copied={copiedId === item.id}
                    onclick={() => copyPublicUrl(item)}
                    aria-label={`${$t("media.copyLink", "Copy link")} ${item.file.name}`}
                  >
                    {#if copiedId === item.id}
                      <Check class="h-3.5 w-3.5" />
                    {:else}
                      <Copy class="h-3.5 w-3.5" />
                    {/if}
                    <span>{$t("media.copyLink", "Copy link")}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-primary"
                    data-upload-action="open"
                    href={item.publicUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${$t("media.openInNewTab", "Open in new tab")} ${item.file.name}`}
                  >
                    <ExternalLink class="h-3.5 w-3.5" />
                    <span>{$t("media.openInNewTab", "Open in new tab")}</span>
                  </Button>
                </div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

{#if previewItem?.publicUrl}
  <MediaPreviewDialog
    bind:open={previewOpen}
    url={previewItem.publicUrl}
    title={previewItem.remoteTitle || previewItem.file.name}
    mimeType={previewItem.remoteMime || previewItem.file.type}
    onCopy={copyPreviewUrl}
    onShare={sharePreviewUrl}
    canShare={isShareableAccess(previewItem.remoteAccess)}
  />
{/if}
