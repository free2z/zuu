/**
 * The one way the browser sends an upload: pre-checked, bounded, and loud
 * when it fails (RCA ).
 *
 * For 19 days every upload over 1 MiB failed. nginx answered 500 while the
 * browser was still streaming a body it never read, and `fetch` never
 * settled. So from the creator's side nothing happened at all: the Save
 * button spun forever, no toast appeared, and one creator retried the same
 * 33 MB video 24 times over 17 hours without ever seeing an error. 57
 * failures, zero reports. The server bug is fixed. This module exists
 * so that the NEXT one cannot hide on the client:
 *
 *   1. **Pre-check** the file against the server's own limit
 *      (`GET /api/uploads/limits/`, via `uploadLimit.ts`) and refuse locally,
 *      naming the limit, before a byte goes up.
 *   2. **Bound the request** with a STALL timeout, not a wall clock. A 33 MB
 *      video on a slow link is a legitimate ten-minute upload; a request whose
 *      upload counter has not moved for {@link UPLOAD_STALL_TIMEOUT_MS} is
 *      not. XHR is used rather than `fetch` because only XHR reports upload
 *      progress, and progress is the only honest liveness signal an upload
 *      has.
 *   3. **Every failure is an {@link UploadRequestError}** carrying the file
 *      name, its size, the HTTP status (0 when there was none) and a `kind`,
 *      and {@link uploadErrorMessage} turns it into one sentence that says
 *      which file, how big, and what to do next.
 *   4. **nginx's bodiless 403** (`@deny_upload`: quota exceeded, or signed
 *      out) is explained by re-reading the limit, exactly as the media
 *      uploader already did — see {@link explainUploadRejection}.
 *
 * No SvelteKit imports: every runtime dependency (the XHR constructor, the
 * limit request, the translator) is injected, so
 * `tests/upload-request.test.mjs` drives it in node against stubs.
 */
import type { TranslationFunction } from "$lib/i18n";
import {
  checkUploadSize,
  confirmOversize,
  formatByteLimit,
  isEnvelopeOverage,
  refreshUploadLimit,
  type OversizeUpload,
  type UploadLimit,
  type UploadLimitRequest,
} from "./uploadLimit";
import { UPLOAD_RESPONSE_TIMEOUT_MS } from "../../api/request-timeout.js";

/**
 * How long the upload counter may sit still before we give up.
 *
 * Idle time, not total time: the timer is re-armed by every upload progress
 * event, so a slow link that is still moving bytes is never cut off. Chromium
 * and Firefox dispatch `xhr.upload` progress at least every ~50 ms while bytes
 * move, so 30 s of silence is a dead connection, not a slow one.
 */
export const UPLOAD_STALL_TIMEOUT_MS = 30_000;

/**
 * How long to wait for the RESPONSE once the whole body has been sent.
 *
 * A separate, longer bound because the server legitimately works after the
 * last byte arrives (saving to GCS synchronously, writing a thumbnail) and
 * sends nothing while it does. It sits just ABOVE the proxies' own budget —
 * `proxy_read_timeout 600s` on `/uploads` in both `k8s/free2z/nginx.conf`
 * and `k8s/new-ui/nginx-configmap.yaml` — so the browser never abandons a
 * request the server is still allowed to finish (and may already have
 * committed; a retry would store a second copy). A live proxy has always
 * answered, if only with a 504, by the time this fires; it exists for the
 * case where nothing answers at all. Raised from 120 s by the codex review.
 *
 * Defined once in `$lib/api/request-timeout.js`, which also bounds a
 * binary body sent through `apiFetch` (KYC documents) with it — re-exported
 * here so the two request paths cannot drift. Imported by relative path so
 * `tests/upload-request.test.mjs` still loads this module in plain node.
 */
export { UPLOAD_RESPONSE_TIMEOUT_MS };

export type UploadFailureKind =
  /** Refused locally: the file is over the server's own limit. */
  | "too-large"
  /** 403 or 413 — nginx's upload gate (quota, signed out, body cap). */
  | "refused"
  /**
   * 429 — the pod is already spooling its maximum number of uploads
   * (`limit_conn upload_spool` in k8s/free2z/nginx.conf, ). Nothing is
   * wrong with the file or the account; a retry a few seconds later lands.
   */
  | "busy"
  /** Any other non-2xx status. */
  | "http"
  /** The connection failed (`xhr.onerror`); no status. */
  | "network"
  /** No bytes moved for the stall window; we aborted it. */
  | "stalled"
  /** The caller aborted it (e.g. removed from the queue). Say nothing. */
  | "cancelled";

/**
 * A failed upload that still knows what it was and what the server said.
 *
 * `status` is the HTTP status, or 0 when there was none (network, stall,
 * local refusal). It used to be a plain `Error`, which threw the status away,
 * and the status is the whole story here: nginx refuses an oversize body with
 * a bodiless 403 or 413, neither of which carries any text to read.
 */
export class UploadRequestError extends Error {
  readonly status: number;
  readonly kind: UploadFailureKind;
  readonly fileName: string;
  readonly fileBytes: number;
  /**
   * The multipart body's exact size from `xhr.upload` progress `total` — the
   * number nginx compared, not the file's own size. Undefined if no progress
   * event fired.
   */
  readonly requestBytes?: number;
  /** Set when the limit explains the failure (pre-check or re-read). */
  oversize: OversizeUpload | null;

  constructor(
    message: string,
    status: number,
    details: {
      kind?: UploadFailureKind;
      fileName?: string;
      fileBytes?: number;
      requestBytes?: number;
      oversize?: OversizeUpload | null;
    } = {},
  ) {
    super(message);
    this.name = "UploadRequestError";
    this.status = status;
    this.kind = details.kind ?? kindForStatus(status);
    this.fileName = details.fileName ?? "";
    this.fileBytes = Number.isFinite(details.fileBytes)
      ? (details.fileBytes as number)
      : 0;
    this.requestBytes = details.requestBytes;
    this.oversize = details.oversize ?? null;
  }
}

function kindForStatus(status: number): UploadFailureKind {
  if (status === 403 || status === 413) return "refused";
  if (status === 429) return "busy";
  if (status === 0) return "network";
  return "http";
}

/**
 * Is this a failure nginx's upload gate could have produced — and therefore
 * one the limit might explain?
 *
 * 403 is the auth-subrequest refusal, 413 the independent
 * `client_max_body_size` boundary, and a network error is either of them seen
 * from the other side: the refusal closes the connection while the body is
 * still going out. A `TypeError` is how `fetch` reports that same thing. A
 * stall is NOT one: a refusal ends the request, it does not freeze it.
 */
export function isUploadRejection(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    error instanceof UploadRequestError &&
    (error.kind === "refused" || error.kind === "network")
  );
}

/** The slice of `XMLHttpRequest` this module touches. Injected for tests. */
export interface UploadXhr {
  open(method: string, url: string, async?: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: unknown): void;
  abort(): void;
  withCredentials: boolean;
  readonly status: number;
  readonly responseText: string;
  readonly upload: Pick<
    EventTarget,
    "addEventListener" | "removeEventListener"
  >;
  addEventListener: EventTarget["addEventListener"];
  removeEventListener: EventTarget["removeEventListener"];
}

export interface StallWatch {
  /** Disarm. Idempotent; call it whenever the request settles. */
  stop(): void;
}

/**
 * Abort `xhr` when it stops making progress. The shared primitive: the
 * media uploader keeps its own XHR (its progress bar and 403 explanation are
 * wired to it) and arms this on it; {@link sendUploadRequest} arms it on
 * its own.
 *
 * Listeners, not `on*` properties, so it never displaces the caller's own
 * handlers. Must be called BEFORE `xhr.send()`: upload listeners registered
 * after send are not guaranteed to fire. The clock starts now, so a request
 * that never produces a single progress event (the connection never opened)
 * is bounded too — by the long window, since it may only be queued.
 *
 * `onStall` runs BEFORE the abort, so a caller whose `onabort` means
 * "cancelled by the user" can tell the two apart.
 */
export function watchUploadStall(
  xhr: UploadXhr,
  {
    onStall,
    stallTimeoutMs = UPLOAD_STALL_TIMEOUT_MS,
    responseTimeoutMs = UPLOAD_RESPONSE_TIMEOUT_MS,
  }: {
    onStall: () => void;
    stallTimeoutMs?: number;
    responseTimeoutMs?: number;
  },
): StallWatch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Once the body is fully sent, only the response can move us forward.
  let waitingForResponse = false;
  // Until the first upload progress event the request may not have a
  // connection yet: over HTTP/1.1 the browser queues past six per origin, and
  // a batch drop (inline uploads run concurrently) can hold a healthy request
  // there for longer than the stall window. So the short STALL window starts
  // only once bytes have started moving; before that the request gets the
  // long bound, which still guarantees it ends. (Raised by the codex review.)
  let bytesMoving = false;

  const arm = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      fire,
      bytesMoving && !waitingForResponse ? stallTimeoutMs : responseTimeoutMs,
    );
  };
  const fire = () => {
    if (stopped) return;
    stop();
    onStall();
    xhr.abort();
  };
  const onUploadProgress = () => {
    bytesMoving = true;
    arm();
  };
  const onUploadDone = () => {
    waitingForResponse = true;
    arm();
  };
  // Response bytes (headers, body) are progress too.
  const onResponseProgress = () => {
    waitingForResponse = true;
    arm();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    xhr.upload.removeEventListener("progress", onUploadProgress);
    xhr.upload.removeEventListener("load", onUploadDone);
    xhr.removeEventListener("progress", onResponseProgress);
    xhr.removeEventListener("readystatechange", onResponseProgress);
    xhr.removeEventListener("loadend", stop);
  };

  xhr.upload.addEventListener("progress", onUploadProgress);
  xhr.upload.addEventListener("load", onUploadDone);
  xhr.addEventListener("progress", onResponseProgress);
  // `readystatechange` fires on HEADERS_RECEIVED, before any body progress.
  // It also fires on `open()` (state 1) — harmless, it only re-arms.
  xhr.addEventListener("readystatechange", onResponseProgress);
  xhr.addEventListener("loadend", stop);
  arm();
  return { stop };
}

export interface UploadResponse {
  status: number;
  responseText: string;
}

export interface SendUploadOptions {
  url: string;
  body: FormData | Blob | string;
  /** The file being sent — named in every error. */
  file: { name?: string; size?: number };
  headers?: Record<string, string>;
  withCredentials?: boolean;
  stallTimeoutMs?: number;
  responseTimeoutMs?: number;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  createXhr?: () => UploadXhr;
}

/**
 * POST `body` with a stall bound. Resolves on 2xx; rejects with an
 * {@link UploadRequestError} on anything else — a non-2xx status, a network
 * error, a stall, or `signal` aborting. It never stays pending: every path
 * through an XHR ends in `load`, `error` or `abort`, and the stall watch
 * guarantees one of them.
 */
export function sendUploadRequest(
  options: SendUploadOptions,
): Promise<UploadResponse> {
  const {
    url,
    body,
    file,
    headers = {},
    withCredentials = true,
    onProgress,
    signal,
  } = options;
  const createXhr =
    options.createXhr ?? (() => new XMLHttpRequest() as unknown as UploadXhr);
  const details = { fileName: file?.name ?? "", fileBytes: file?.size };

  return new Promise<UploadResponse>((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new UploadRequestError("Upload cancelled", 0, {
          ...details,
          kind: "cancelled",
        }),
      );
      return;
    }

    const xhr = createXhr();
    let requestBytes: number | undefined;
    let stalled = false;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      watch.stop();
      signal?.removeEventListener("abort", onSignalAbort);
      fn();
    };
    const fail = (kind: UploadFailureKind, status: number, message: string) =>
      finish(() =>
        reject(
          new UploadRequestError(message, status, {
            ...details,
            kind,
            requestBytes,
          }),
        ),
      );
    const onSignalAbort = () => xhr.abort();

    xhr.open("POST", url, true);
    xhr.withCredentials = withCredentials;
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }

    xhr.upload.addEventListener("progress", (event) => {
      const progress = event as ProgressEvent;
      if (!progress.lengthComputable) return;
      requestBytes = progress.total;
      onProgress?.(progress.loaded, progress.total);
    });

    const watch = watchUploadStall(xhr, {
      onStall: () => {
        stalled = true;
      },
      stallTimeoutMs: options.stallTimeoutMs,
      responseTimeoutMs: options.responseTimeoutMs,
    });

    xhr.addEventListener("load", () => {
      const status = xhr.status;
      if (status >= 200 && status < 300) {
        finish(() => resolve({ status, responseText: xhr.responseText }));
        return;
      }
      fail(
        kindForStatus(status),
        status,
        xhr.responseText || `Upload failed (${status})`,
      );
    });
    xhr.addEventListener("error", () =>
      fail("network", 0, "Upload did not reach the server"),
    );
    xhr.addEventListener("abort", () =>
      stalled
        ? fail("stalled", 0, "Upload stalled")
        : fail("cancelled", 0, "Upload cancelled"),
    );
    // Some engines fire `timeout` instead of `abort` if a timeout is ever set.
    xhr.addEventListener("timeout", () => fail("stalled", 0, "Upload stalled"));
    signal?.addEventListener("abort", onSignalAbort);

    try {
      xhr.send(body);
    } catch {
      fail("network", 0, "Upload could not start");
    }
  });
}

/**
 * Refuse a file the server's limit already rules out — before a byte goes up.
 *
 * `confirmOversize` is the decision, not a comparison against a snapshot: a
 * stale cached limit may permit, but only a fresh read may refuse. An unknown
 * limit refuses nothing (the server still decides).
 */
export async function preflightUpload(
  file: { name?: string; size?: number },
  options: { request: UploadLimitRequest; apiBase?: string },
): Promise<UploadLimit | null> {
  const { limit, oversize } = await confirmOversize([file], {
    request: options.request,
    apiBase: options.apiBase,
    limit: null,
  });
  if (oversize.length > 0) {
    throw new UploadRequestError("File is over the upload limit", 0, {
      kind: "too-large",
      fileName: file?.name ?? "",
      fileBytes: file?.size,
      oversize: oversize[0],
    });
  }
  return limit;
}

/**
 * For a failure the upload gate could have produced (403, 413, network),
 * re-read the limit and, if it explains the failure, record why on the error.
 *
 * Fresh, never cached: the case to explain is a balance that dropped a rung
 * since the page loaded, where the cached ceiling says the file should fit.
 * Compared against `requestBytes` when known, because nginx compares the
 * whole multipart body, not the file. Anything else returns immediately —
 * a 500 has nothing to do with the quota and must not wait on a read.
 */
export async function explainUploadRejection(
  error: unknown,
  options: { request: UploadLimitRequest; apiBase?: string },
): Promise<unknown> {
  if (!(error instanceof UploadRequestError)) return error;
  if (error.oversize || !isUploadRejection(error)) return error;
  const fresh = await refreshUploadLimit(options);
  error.oversize = checkUploadSize(
    { name: error.fileName, size: error.fileBytes },
    fresh,
    error.requestBytes,
  );
  return error;
}

/**
 * One sentence a creator can act on: which file, how big, what happened, and
 * what to do. Every branch names the file and its size — "Failed to upload
 * image." about one of three files, with no size, is how a 33 MB video got
 * retried 24 times.
 */
export function uploadErrorMessage(
  error: unknown,
  t: TranslationFunction,
  locale = "en",
  fallbackFileName = "",
): string {
  if (!(error instanceof UploadRequestError)) {
    return t(
      "upload.failedUnknown",
      "{filename} could not be uploaded. Please try again.",
      { filename: fallbackFileName || t("upload.thisFile", "This file") },
    );
  }

  const filename =
    error.fileName || fallbackFileName || t("upload.thisFile", "This file");
  const size = formatByteLimit(error.fileBytes, locale);

  if (error.oversize) {
    const limit = formatByteLimit(error.oversize.maxBytes, locale);
    if (isEnvelopeOverage(error.oversize)) {
      return t(
        "media.fileAtLimit",
        "{filename} is {size} and your limit is {limit} — the upload carries a little more than the file itself, so this one still does not fit. Try a slightly smaller file.",
        { filename, size, limit },
      );
    }
    const reason = t(
      "media.fileTooLarge",
      "{filename} is {size} — your upload limit is {limit}.",
      { filename, size, limit },
    );
    const tier = error.oversize.nextTier;
    if (!tier) return reason;
    return `${reason} ${t(
      "media.uploadLimitUpgrade",
      "Hold {tuzis} 2Z and you can upload files up to {limit}.",
      {
        tuzis: tier.min_tuzis.toLocaleString(locale),
        limit: formatByteLimit(tier.max_bytes, locale),
      },
    )}`;
  }

  switch (error.kind) {
    case "stalled":
      return t(
        "upload.stalled",
        "{filename} ({size}) stopped uploading — nothing was sent for a while. Check your connection and try again.",
        { filename, size },
      );
    case "network":
      return t(
        "upload.network",
        "{filename} ({size}) did not reach the server. Check your connection and try again.",
        { filename, size },
      );
    case "refused":
      return error.status === 413
        ? t(
            "upload.tooLargeForServer",
            "{filename} ({size}) is larger than the server accepts. Try a smaller file.",
            { filename, size },
          )
        : t(
            "upload.refused",
            "{filename} ({size}) was refused. You may have been signed out — reload the page, sign in and try again.",
            { filename, size },
          );
    case "busy":
      return t(
        "upload.busy",
        "{filename} ({size}) was not uploaded — the server is busy with other uploads right now. Try again in a few seconds.",
        { filename, size },
      );
    case "cancelled":
      return t("upload.cancelled", "{filename} ({size}) was not uploaded.", {
        filename,
        size,
      });
    case "too-large":
    case "http":
    default:
      return t(
        "upload.failedStatus",
        "{filename} ({size}) failed to upload (error {status}). Please try again.",
        { filename, size, status: error.status },
      );
  }
}
