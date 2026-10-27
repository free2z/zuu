/**
 * The inline image upload pipeline, shared by every markdown textarea that
 * takes a pasted, dropped or picked image: the zPage body
 * (`EditorContentField`) and the Converse composer.
 *
 * The flow, for one batch of files:
 *
 *   1. a placeholder `![Uploading image…](upload-…)` goes into the document
 *      synchronously, at the offset the files were aimed at;
 *   2. ONE authoritative limit read gates the whole batch;
 *   3. each file is uploaded (PUBLIC — see `uploadPublicFile`) and its
 *      placeholder is swapped for the real image markdown, found again by
 *      TOKEN because the user may have typed around it meanwhile;
 *   4. a failure removes the placeholder and explains itself.
 *
 * Every runtime dependency is injected, the same shape as `uploadLimit.ts`:
 * this module has no SvelteKit imports, so `tests/inline-uploads.test.mjs` can
 * drive the whole pipeline in node against stubs. The TYPE imports below are
 * erased by type stripping.
 *
 * `inFlight` is the set of upload TOKENS whose request has not settled. A host
 * that publishes its document the moment the user asks (Converse) must refuse
 * while the document still references one of them — a placeholder token is
 * not an image, and posting one publishes a dead link — and must strip any
 * reference to a token it issued that has since settled (a placeholder the
 * user mangled mid-upload can no longer be replaced). Text that merely LOOKS
 * like a placeholder, with no upload of ours behind it, is the user's.
 */
import type { TranslationFunction } from "$lib/i18n";
import type {
  OversizeUpload,
  UploadLimit,
  UploadLimitRequest,
} from "../media/uploadLimit";

// ---------------------------------------------------------------------------
// Placeholder tokens
// ---------------------------------------------------------------------------

let uploadTokenSequence = 0;

export function createUploadToken() {
  uploadTokenSequence += 1;
  return `upload-${Date.now().toString(36)}-${uploadTokenSequence}`;
}

export function buildUploadPlaceholder(token: string, label: string) {
  return `![${label}](${token})`;
}

/**
 * Alt text inside a placeholder: anything on one line WITHOUT a bracket.
 *
 * Excluding `[` as well as `]` is what keeps a match from starting at an
 * earlier, unrelated `[` in the writer's own text and running forward into
 * the placeholder — `I like [brackets [Uploading image…](upload-…)` used to
 * lose "[brackets " along with the placeholder (review round 2).
 */
const ALT_TEXT = "[^\\[\\]\\n]*";

export function findUploadPlaceholder(content: string, token: string) {
  // Match any alt text so the placeholder survives the user editing it; the
  // token charset is [a-z0-9-], so no regex escaping is needed. Case-blind:
  // a writer who uppercases the token has not cancelled the upload.
  const match = content.match(
    new RegExp(`!\\[${ALT_TEXT}\\]\\(${token}\\)`, "i"),
  );

  if (match?.index === undefined) {
    return null;
  }

  return { start: match.index, end: match.index + match[0].length };
}

export function buildImageMarkdown(
  fileName: string,
  url: string,
  t: TranslationFunction,
) {
  const alt =
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[[\]()\n]/g, " ")
      .trim() || t("editor.imageName", "Image");

  return `![${alt}](${url})`;
}

/** Video uses the renderer's existing native-media directive. */
export function buildVideoMarkdown(url: string) {
  return `\n\n::embed[${url.replace(/[\[\]\r\n]/g, encodeURIComponent)}]\n\n`;
}

const UPLOAD_PLACEHOLDER_PATTERN = new RegExp(
  `!\\[${ALT_TEXT}\\]\\(upload-[a-z0-9-]+\\)`,
  "gi",
);

export function stripUploadPlaceholders(content: string) {
  return content.replace(UPLOAD_PLACEHOLDER_PATTERN, "");
}

/** Does this markdown still carry an unresolved upload placeholder? */
export function hasUploadPlaceholder(content: string) {
  return new RegExp(UPLOAD_PLACEHOLDER_PATTERN.source, "i").test(content);
}

/**
 * A WHOLE token, never a prefix of a longer one: `upload-x-1` must not match
 * inside `upload-x-10`, which the same batch issues within the same
 * millisecond (raised by the codex review). Case-blind, so `UPLOAD-…` still
 * counts (review round 2). Tokens are `[a-z0-9-]`, so a
 * neighbour from that class means "part of a longer token", and no regex
 * escaping is needed. A capture group rather than a lookbehind keeps
 * `eslint-plugin-compat` out of it (see `restrictedMediaPaths`).
 */
function wholeToken(token: string) {
  return new RegExp(`(^|[^a-z0-9-])${token}(?![a-z0-9-])`, "i");
}

/** Does `content` still mention any of `tokens`, in any form? */
export function referencesUploadToken(
  content: string,
  tokens: Iterable<string>,
) {
  for (const token of tokens) {
    if (wholeToken(token).test(content)) return true;
  }
  return false;
}

/**
 * Remove the placeholders of `tokens` from `content`, in the shapes a writer
 * can plausibly leave them: `![alt](token)` or `[alt](token)`, any case,
 * padding inside the parentheses. Nothing else is touched.
 *
 * Deliberately NOT "and then delete any bare token": a token left behind in
 * some other shape means the placeholder was edited into something this
 * cannot take apart cleanly, and deleting only the token posts the rest of
 * the syntax (`[Uploading image…]( x)`). The caller checks
 * `referencesUploadToken` on the result and refuses instead.
 */
export function stripUploadTokens(content: string, tokens: Iterable<string>) {
  let next = content;
  for (const token of tokens) {
    next = next.replace(
      new RegExp(`!?\\[${ALT_TEXT}\\]\\(\\s*${token}\\s*\\)`, "gi"),
      "",
    );
  }
  return next;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** Where the placeholders live. Implemented by the host component. */
export interface InlineUploadDocument {
  /** Insert `text` at `offset` in the live document. */
  insertAt(offset: number, text: string): void;
  /** The current text — the live textarea's when mounted, else the model. */
  read(): string;
  /** Replace `[start, end)` with `text` in the live document. */
  replace(start: number, end: number, text: string): void;
}

export interface InlineUploadDeps {
  t: () => TranslationFunction;
  locale: () => string;
  /**
   * "The page this upload belongs to is gone." Read LIVE, after every await.
   * See `EditorContentField`'s `isAbandoned` for why that is the PAGE's
   * signal on `/edit` and not the component's own lifecycle.
   */
  editorAbandoned: () => boolean;
  toast: { error: (message: string) => unknown };
  request: UploadLimitRequest;
  uploadPublicFile: (
    file: File,
    title: string,
  ) => Promise<{ url: string; mime_type?: string }>;
  isUploadRejection: (error: unknown) => boolean;
  confirmOversize: (
    files: File[],
    options: { request: UploadLimitRequest; limit: UploadLimit | null },
  ) => Promise<{ limit: UploadLimit | null }>;
  checkUploadSize: (
    file: File,
    limit: UploadLimit | null | undefined,
    comparedBytes?: number,
  ) => OversizeUpload | null;
  refreshUploadLimit: (options: {
    request: UploadLimitRequest;
  }) => Promise<UploadLimit | null>;
  formatByteLimit: (bytes: number, locale?: string) => string;
  /**
   * The shared "which file, how big, what happened" sentence for a failed
   * upload (`uploadErrorMessage` in `media/uploadRequest.ts`), or null when
   * the error is not one it understands. Injected rather than imported so
   * this module stays loadable in node.
   */
  describeUploadError?: (file: File, error: unknown) => string | null;
  /** Called whenever the set of in-flight upload tokens changes. */
  onPendingChange?: (inFlight: readonly string[]) => void;
}

export interface InlineUploader {
  startInlineUploads(
    files: File[],
    offset: number,
    mediaKind?: "video",
  ): Promise<void>;
  /** Files whose upload has not settled yet. */
  readonly pending: number;
  /** Tokens of those files. */
  readonly inFlight: readonly string[];
  /** Every token this uploader ever issued, settled or not. */
  readonly issued: readonly string[];
}

export function createInlineUploader(
  doc: InlineUploadDocument,
  deps: InlineUploadDeps,
): InlineUploader {
  const {
    editorAbandoned,
    toast,
    request,
    uploadPublicFile,
    isUploadRejection,
    confirmOversize,
    checkUploadSize,
    refreshUploadLimit,
    formatByteLimit,
  } = deps;
  const tr: TranslationFunction = (key, fallback, params) =>
    deps.t()(key, fallback, params);

  /**
   * At most this many requests on the wire at once, across every batch.
   *
   * Each upload's stall watch starts when its request is created. A
   * drop of many large images fired them all at once, and over HTTP/1.1 the
   * browser queues past six per origin — so a healthy request could spend
   * its whole bound waiting for a connection and be reported as failed.
   * Holding the job HERE, before a request exists, means queue time is never
   * counted against a transport timeout, and leaves connections free for the
   * rest of the page. (Raised by the codex review of.)
   */
  const MAX_CONCURRENT_UPLOADS = 3;
  let activeUploads = 0;
  const waitingForSlot: Array<() => void> = [];

  function acquireUploadSlot(): Promise<void> {
    if (activeUploads < MAX_CONCURRENT_UPLOADS) {
      activeUploads += 1;
      return Promise.resolve();
    }
    // The slot is HANDED OVER by `releaseUploadSlot`, never re-counted, so a
    // caller arriving between a release and the wake cannot oversubscribe.
    return new Promise((resolve) => waitingForSlot.push(resolve));
  }

  function releaseUploadSlot() {
    const next = waitingForSlot.shift();
    if (next) next();
    else activeUploads -= 1;
  }

  const inFlight = new Set<string>();
  const issued = new Set<string>();

  function track(tokens: string[]) {
    for (const token of tokens) {
      inFlight.add(token);
      issued.add(token);
    }
    deps.onPendingChange?.([...inFlight]);
  }

  function settle(tokens: string[]) {
    for (const token of tokens) inFlight.delete(token);
    deps.onPendingChange?.([...inFlight]);
  }

  /**
   * Is this upload's placeholder still in the document?
   *
   * The same question `resolveUploadToken` asks, but asked BEFORE the bytes
   * go up rather than after. Deleting the placeholder is how a creator
   * cancels an inline upload, and since the send waits on a limit read
   * there is a real window in which to do it — during which the answer costs
   * nothing and skipping the upload saves a stored, public, orphaned file.
   */
  function uploadTokenIsLive(token: string) {
    return Boolean(findUploadPlaceholder(doc.read(), token));
  }

  function resolveUploadToken(token: string, replacement: string) {
    // Search the live text by token, never stored offsets — the user may
    // have typed or deleted around the placeholder while uploading. `read()`
    // falls back to the bound model when the textarea is unmounted
    // (preview-only mode), so an upload survives a Preview switch.
    const found = findUploadPlaceholder(doc.read(), token);

    // The user deleted the placeholder — treat it as a cancel.
    if (!found) {
      return;
    }

    doc.replace(found.start, found.end, replacement);
  }

  /**
   * ONE authoritative read for a whole drop, and the limit to gate it on.
   *
   * `confirmOversize`, not a bare check against the cached value: a balance
   * that goes UP raises the real ceiling, and a refusal decided from the stale
   * snapshot never sends the request that would discover it.
   *
   * Called once per BATCH rather than once per file. The jobs below run
   * through `Promise.all`, so a per-file call would fire one re-read per
   * oversized file — a drop of two hundred photos becomes two hundred
   * simultaneous reads against the same rate limit the uploads need, and the
   * ones that come back 429 read as "limit unknown" and go up anyway.
   */
  async function confirmUploadLimit(files: File[]) {
    // `limit: null`, not a `loadUploadLimit()` of our own: `confirmOversize`
    // does that read itself when the snapshot is missing. Doing it here too
    // made a blackholed endpoint cost TWO serial 8-second timeouts.
    const { limit } = await confirmOversize(files, {
      request,
      limit: null,
    });
    return limit;
  }

  /**
   * Why an upload the server refused was refused.
   *
   * The pre-flight can only ever be as good as the snapshot it ran against, and
   * the snapshot can be stale HIGH as well as low: a balance that drops a rung
   * in another tab leaves the editor believing in the old, larger ceiling, so
   * the file goes out and comes back refused. Re-read the limit and, if it
   * explains the failure, say so with the same words the media uploader uses.
   */
  async function uploadFailureMessage(
    file: File,
    error: unknown,
    /**
     * A limit re-read AFTER the rejection, as a THUNK — the caller shares one
     * promise across the batch, and this only calls it on the branch that
     * needs it.
     */
    freshLimit: () => Promise<UploadLimit | null>,
  ) {
    // The STATUS decides first, and it decides without any network at all.
    // nginx refuses an oversize body with a bodiless 403 or a 413, and either
    // can arrive as a transport error — those are the only failures a limit
    // could possibly explain. A 400 or a 500 is not one of them, and awaiting
    // the limits endpoint before saying so made every unrelated failure wait
    // out an unrelated request.
    if (!isUploadRejection(error)) {
      // A stall, a 500, a 400: say which file, how big, and what happened
      //  "Image upload failed." about one of several images in a
      // drop was all a creator ever got.
      return (
        deps.describeUploadError?.(file, error) ??
        tr("editor.imageUploadFailed", "Image upload failed.")
      );
    }

    // Against the REQUEST size when the transport measured it: nginx compares
    // the whole multipart body, so a file of exactly the limit is refused on
    // its envelope, and "you may have been signed out" is then the wrong
    // story. (Raised by the codex review of.)
    const requestBytes = (error as { requestBytes?: number } | null)
      ?.requestBytes;
    const oversize = checkUploadSize(file, await freshLimit(), requestBytes);
    if (oversize) {
      return oversizeMessage(file, oversize);
    }

    // The limit does not explain it: the file's own 403/413/network story.
    const described = deps.describeUploadError?.(file, error);
    if (described) return described;

    // A rejection the limit does not account for: the file fits, but the
    // request that wraps it carries a few hundred bytes more.
    return tr(
      "editor.imageUploadRejected",
      "Upload failed. The file may exceed your upload limit.",
    );
  }

  /** The refusal, named, with what would raise the ceiling. */
  function oversizeMessage(file: File, oversize: OversizeUpload) {
    const locale = deps.locale();

    // The file fits and only the multipart ENVELOPE does not (a 403 compared
    // on `requestBytes`). "Hold more 2Z" is the wrong advice there: a slightly
    // smaller file is the fix. Same sentence as the media uploader.
    if (oversize.fileBytes <= oversize.maxBytes) {
      return tr(
        "media.fileAtLimit",
        "{filename} is {size} and your limit is {limit} — the upload carries a little more than the file itself, so this one still does not fit. Try a slightly smaller file.",
        {
          filename: file.name || tr("editor.imageName", "Image"),
          size: formatByteLimit(oversize.fileBytes, locale),
          limit: formatByteLimit(oversize.maxBytes, locale),
        },
      );
    }
    const message = tr(
      "editor.imageTooLarge",
      "{filename} exceeds your upload limit of {limit}.",
      {
        filename: file.name || tr("editor.imageName", "Image"),
        limit: formatByteLimit(oversize.maxBytes, locale),
      },
    );

    //...and what raises it, when there is a rung above this one. Named from
    // the ladder the server sent, never from a threshold of our own — and with
    // `min_tuzis` said literally, because the server truncates the balance.
    const tier = oversize.nextTier;
    if (!tier) {
      return message;
    }

    return `${message} ${tr(
      "media.uploadLimitUpgrade",
      "Hold {tuzis} 2Z to raise the upload request cap to {limit}.",
      {
        tuzis: tier.min_tuzis.toLocaleString(locale),
        limit: formatByteLimit(tier.max_bytes, locale),
      },
    )}`;
  }

  async function startInlineUploads(
    files: File[],
    offset: number,
    mediaKind?: "video",
  ) {
    if (!files.length) {
      return;
    }

    const jobs = files.map((file) => ({ file, token: createUploadToken() }));
    const label = tr("editor.uploadingImage", "Uploading image…");
    const placeholderBlock = jobs
      .map((job) =>
        buildUploadPlaceholder(
          job.token,
          mediaKind === "video" || job.file.type.startsWith("video/")
            ? tr("editor.uploadingVideo", "Uploading video…")
            : label,
        ),
      )
      .join("\n");

    // Counted BEFORE the placeholder lands, so there is no instant at which a
    // placeholder exists and a host believes nothing is in flight.
    track(jobs.map((job) => job.token));
    doc.insertAt(offset, placeholderBlock);

    let limit: UploadLimit | null;
    try {
      limit = await confirmUploadLimit(files);
    } catch {
      // `confirmOversize` answers null rather than throwing; this is only a
      // backstop so a surprise can never strand the placeholders (and the
      // pending count that blocks a Converse post) forever.
      for (const { token } of jobs) resolveUploadToken(token, "");
      settle(jobs.map((job) => job.token));
      return;
    }

    /**
     * One genuinely fresh read for the whole batch's failure path, created
     * lazily by whichever job fails first and awaited by the rest.
     *
     * The pre-flight limit above cannot explain a rejection: a balance that
     * drops a rung mid-batch is exactly the case where the cached value says
     * the file should have fit. But a per-file refresh would fan out one
     * request per failure across `Promise.all`, which is the thing the
     * batching above exists to prevent. Fresh AND once.
     */
    let freshLimit: Promise<UploadLimit | null> | null = null;
    const limitAfterFailure = () =>
      (freshLimit ??= refreshUploadLimit({ request }));

    await Promise.all(
      jobs.map(async ({ file, token }) => {
        try {
          const oversize = checkUploadSize(file, limit);

          if (oversize) {
            // The placeholder always goes, even if the page is gone: it lives
            // in the bound content, and anything left there is stranded in
            // local state for good. The toast is what needs the guard.
            resolveUploadToken(token, "");
            if (!editorAbandoned())
              toast.error(oversizeMessage(file, oversize));
            return;
          }

          await acquireUploadSlot();
          try {
            // The limit read (and the slot) are awaited, and the creator can
            // leave or delete the placeholder meanwhile. Uploading anyway
            // publishes a file for a page nobody is on. Checked here rather than
            // only in the resolve step, which runs after the bytes are stored.
            if (editorAbandoned() || !uploadTokenIsLive(token)) {
              return;
            }

            try {
              const uploaded = await uploadPublicFile(
                file,
                file.name || tr("editor.imageName", "Image"),
              );
              // Keep the URL relative — the markdown renderer prefixes /uploadz/
              // paths with the API base in both preview and published pages.
              resolveUploadToken(
                token,
                (
                  uploaded.mime_type
                    ? !uploaded.mime_type.startsWith("image/")
                    : mediaKind === "video" || file.type.startsWith("video/")
                )
                  ? buildVideoMarkdown(uploaded.url)
                  : buildImageMarkdown(file.name, uploaded.url, tr),
              );
            } catch (error: any) {
              resolveUploadToken(token, "");
              const message = await uploadFailureMessage(
                file,
                error,
                limitAfterFailure,
              );
              // That message may have waited on a limit read, and the creator
              // can leave in the meantime. A toast is global: without this, a
              // dead editor pops an error onto whatever page they went to.
              if (!editorAbandoned()) toast.error(message);
            }
          } finally {
            releaseUploadSlot();
          }
        } finally {
          settle([token]);
        }
      }),
    );
  }

  return {
    startInlineUploads,
    get pending() {
      return inFlight.size;
    },
    get inFlight() {
      return [...inFlight];
    },
    get issued() {
      return [...issued];
    },
  };
}
