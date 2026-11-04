import sharp from "sharp";

// OG rendering already has a two-request admission gate. Do not retain decoded
// covers or start a libvips thread pool per image in the memory-limited SSR pod.
sharp.cache(false);
sharp.concurrency(1);

export type OgImageVariant = {
  width?: number;
  url?: string;
};

export type OgFeaturedImage = {
  url?: string;
  thumbnail?: string;
  variants?: readonly OgImageVariant[] | null;
};

export type ImageDimensions = {
  width: number;
  height: number;
};

export const OG_COVER_WIDTH = 690;
// Keep the existing transfer/data-URI ceiling separate from the decoded
// raster ceiling below: a highly compressed original can be small on the wire
// and still be unsafe for Resvg to decode.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// A 2048 x 2048 RGBA raster is about 16 MiB before decoder overhead. This
// matches the upload pipeline's longest-edge cap while keeping Resvg's input
// bounded even when a legacy row has no generated ladder derivative.
export const MAX_IMAGE_DIMENSION = 2048;
// A 2M-pixel ceiling admits the largest possible 800px ladder rung from the
// editor's 2048px longest-edge cap, while refusing a compressed 2048x2048
// original when the ladder has not been built.
export const MAX_IMAGE_PIXELS = 2_000_000;

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function matchesAscii(bytes: Uint8Array, offset: number, value: string) {
  return [...value].every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0),
  );
}

function dimensions(width: number, height: number): ImageDimensions | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height))
    return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 33) return null;
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  if (bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13) {
    return null;
  }
  if (!matchesAscii(bytes, 12, "IHDR")) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dimensions(view.getUint32(16), view.getUint32(20));
}

function isJpegSofMarker(marker: number) {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;

    const marker = bytes[offset++];
    if (marker === 0x00) return null;
    if (
      marker === 0x01 ||
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      if (marker === 0xd9) return null;
      continue;
    }
    if (marker === 0xda || offset + 2 > bytes.length) return null;

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (isJpegSofMarker(marker)) {
      if (segmentLength < 7) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return dimensions(width, height);
    }
    offset += segmentLength;
  }
  return null;
}

function readUint16Le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24Le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32Le(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length < 20 ||
    !matchesAscii(bytes, 0, "RIFF") ||
    !matchesAscii(bytes, 8, "WEBP")
  ) {
    return null;
  }
  const riffEnd = readUint32Le(bytes, 4) + 8;
  if (riffEnd > bytes.length || riffEnd < 20) return null;

  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const chunkSize = readUint32Le(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > riffEnd) return null;

    if (matchesAscii(bytes, offset, "VP8X")) {
      if (chunkSize < 10) return null;
      return dimensions(
        readUint24Le(bytes, dataStart + 4) + 1,
        readUint24Le(bytes, dataStart + 7) + 1,
      );
    }
    if (matchesAscii(bytes, offset, "VP8 ")) {
      if (
        chunkSize < 10 ||
        bytes[dataStart + 3] !== 0x9d ||
        bytes[dataStart + 4] !== 0x01 ||
        bytes[dataStart + 5] !== 0x2a
      ) {
        return null;
      }
      return dimensions(
        readUint16Le(bytes, dataStart + 6) & 0x3fff,
        readUint16Le(bytes, dataStart + 8) & 0x3fff,
      );
    }
    if (matchesAscii(bytes, offset, "VP8L")) {
      if (chunkSize < 5 || bytes[dataStart] !== 0x2f) return null;
      const width =
        1 + bytes[dataStart + 1] + ((bytes[dataStart + 2] & 0x3f) << 8);
      const height =
        1 +
        ((bytes[dataStart + 2] >> 6) & 0x03) +
        (bytes[dataStart + 3] << 2) +
        ((bytes[dataStart + 4] & 0x0f) << 10);
      return dimensions(width, height);
    }

    offset = dataEnd + (chunkSize % 2);
  }
  return null;
}

export function readImageDimensions(
  bytes: Uint8Array,
  type: string,
): ImageDimensions | null {
  switch (type.toLowerCase()) {
    case "image/jpeg":
      return readJpegDimensions(bytes);
    case "image/png":
      return readPngDimensions(bytes);
    case "image/webp":
      return readWebpDimensions(bytes);
    default:
      return null;
  }
}

export type ImageBudget = { maxDimension: number; maxPixels: number };
const ARTICLE_IMAGE_BUDGET = {
  maxDimension: MAX_IMAGE_DIMENSION,
  maxPixels: MAX_IMAGE_PIXELS,
};
// Only the public-image normalizer uses this larger decode budget.
export const PUBLIC_IMAGE_BUDGET: Readonly<ImageBudget> = {
  maxDimension: 4096,
  maxPixels: 2048 * 2048,
};

export function isWithinImageBudget(
  value: ImageDimensions | null,
  budget: ImageBudget = ARTICLE_IMAGE_BUDGET,
) {
  return Boolean(
    value &&
    value.width <= budget.maxDimension &&
    value.height <= budget.maxDimension &&
    value.width * value.height <= budget.maxPixels,
  );
}

export function selectCoverSource(image?: OgFeaturedImage | null) {
  const variants = (Array.isArray(image?.variants) ? image.variants : [])
    .filter(
      (variant): variant is { width: number; url: string } =>
        Number.isSafeInteger(variant?.width) &&
        variant.width > 0 &&
        typeof variant.url === "string" &&
        Boolean(variant.url.trim()),
    )
    .sort((left, right) => left.width - right.width);
  const rung =
    variants.find((variant) => variant.width >= OG_COVER_WIDTH) ||
    variants.at(-1);
  return rung?.url || image?.thumbnail || image?.url;
}

/**
 * Why the cover fetch reports an outcome instead of `string | null`.
 *
 * `/og/zpage` gives successful cards a 60-second shared TTL and keeps transient
 * fallbacks/errors `no-store`. This outcome selects whether a rendered
 * card can use that success TTL, and also drives diagnostics and `x-og-cover`.
 * A transient coverless fallback is a 200 for this request; the next origin
 * request attempts the source again under its upload-cache and authorization
 * rules.
 *
 * The distinction the caller needs is not "cover or no cover", it is *why*
 * there is no cover:
 *
 *   ok         a usable data URI.
 *   absent     the page genuinely has no featured image. Not a failure; the
 *              coverless card is correct for this response and gets the short
 *              success TTL. "Genuinely"
 *              is load-bearing and is NOT established here: this function only
 *              sees that it was handed no source URL. Whether the payload that
 *              source came from was a zPage at all is the caller's question,
 *              and `recognizeArticle` in routes/og/zpage/[id].png/+server.ts
 *              answers it before this outcome is accepted.
 *   permanent  the object will not become usable by being asked again — it
 *              404s, is not an image type we render, or exceeds the decode
 *              budget. The correct coverless card gets the short success TTL.
 *   transient  the request failed in a way that a retry can fix — connection
 *              error, timeout, 5xx from storage. The coverless card is a
 *              stopgap and the next origin request tries the source again.
 *
 * When the evidence is ambiguous we choose `transient`: the response stays
 * no-store, the next cache miss retries the source, and the log/header do not
 * claim that a temporary failure is settled.
 *
 * The 60-second shared TTL collapses repeat unfurls between origin renders.
 * Cache misses still add CPU and storage reads. The nginx
 * `limit_req_zone og_rasterizer` policy  is per-client and per nginx
 * replica, so it is not a global rate bound.
 *
 * Origin work is now bounded in `$lib/server/og-render-gate`:
 * article lookups have a two-request burst, then refill at one request/second
 * per process, with two in flight and no rate queue; rasterizer cooldown is
 * charged from measured process CPU after work completes, so slow rendering
 * cannot consume its own budget. Both reject retryably with no-store 503s.
 * `acquireOgRenderSlot` separately caps concurrent materialized work at 2
 * with a wait queue of 8, protecting peak memory, which was OOMing the pod
 *. No circuit breaker sits in front of the
 * cover fetch, deliberately: a per-process breaker keyed on recent transient
 * failures would suppress covers for HEALTHY pages sharing the process the
 * moment one heavily-crawled page's cover started 5xx-ing, which widens a
 * partial failure into a general one — the exact mistake this whole outcome
 * taxonomy exists to avoid.
 */
export type CoverOutcome = "ok" | "absent" | "permanent" | "transient";

export type CoverResult = {
  dataUri: string | null;
  outcome: CoverOutcome;
  /** Short, non-user-controlled tag for logs. Never a URL. */
  reason?: string;
  /** Upstream HTTP status, when there was one. */
  status?: number;
};

/**
 * A 5xx from object storage is the canonical retryable failure, and so are the
 * two 4xx codes that explicitly mean "later". Everything else in the 4xx range
 * describes the object, not the moment.
 *
 * 401 and 403 are the deliberate exceptions. Covers are public objects read
 * through our own gcsproxy sidecar, so "you may not have this" is not a fact
 * about the cover — it is a fact about OUR credentials, i.e. a Workload
 * Identity or bucket-IAM incident. Treating it as permanent would misstate a
 * credential outage as a settled source failure. Marking it transient keeps
 * this fallback no-store so the next origin request retries.
 */
export function classifyResponseStatus(
  status: number,
): "permanent" | "transient" {
  if (
    status >= 500 ||
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 425 ||
    status === 429
  ) {
    return "transient";
  }
  return "permanent";
}

type ImageFetchFailure = Omit<CoverResult, "outcome" | "dataUri"> & {
  outcome: "absent" | "permanent" | "transient";
  dataUri: null;
};
export type ImageBytesResult =
  ImageFetchFailure | { outcome: "ok"; bytes: Uint8Array; type: string };

const absent = (reason: string): ImageFetchFailure => ({
  dataUri: null,
  outcome: "absent",
  reason,
});

const failed = (
  outcome: "permanent" | "transient",
  reason: string,
  status?: number,
): ImageFetchFailure => ({ dataUri: null, outcome, reason, status });

/**
 * A stalled media read must not outlive the request that is waiting for it.
 *
 * nginx abandons `/og/zpage/*.png` after `proxy_read_timeout 30s`
 * (k8s/free2z/nginx.conf), and the burst allowance upstream is 10. An
 * `await fetch()` with no deadline does not notice any of that: during a
 * storage stall it stays pending, holding its buffers and a socket on a 512Mi
 * pod, long after the client that asked for the card has gone. Enough of those
 * and the pod OOMs — the failure this whole module is trying to avoid, arrived
 * at from the other direction. Eight seconds leaves room for the article fetch
 * and the rasterize inside the edge's 30s, and a hit against a warm bucket is
 * two orders of magnitude below it.
 *
 * `AbortSignal.timeout` is Node-only ground: this file is server-side and
 * `src/lib/server/**` is exempt from the browser-baseline lint rules for
 * exactly that reason (eslint.config.js). Client code must keep using
 * `createAbortSignalWithTimeout`.
 */
export const COVER_FETCH_TIMEOUT_MS = 8_000;

function readUint32Be(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/**
 * Does the payload contain a complete image, not just a plausible header?
 *
 * This exists because Resvg does NOT throw on a broken embedded raster — it
 * drops the `<image>` and renders everything else, producing a card that is
 * byte-identical to the coverless one. Verified against the pinned
 * @resvg/resvg-js 2.6.2: a PNG truncated after IHDR renders "successfully".
 * So without this check a truncated download is reported `ok` and logged as
 * nothing — precisely the bug  is about, reached by a path the `catch`
 * around `render()` can never see. Only a complete source may receive the
 * successful-card cache policy, and the outcome/log must describe whether it
 * actually worked.
 *
 * The question is *structural*, and it is asked of the two formats whose
 * containers can answer it. PNG walks the chunk chain to IEND and requires a
 * non-empty IDAT on the way. WebP walks the RIFF chunks and requires an actual
 * encoded-image chunk. Neither "terminates correctly" nor "declares plausible
 * dimensions" implies "contains pixels", and Resvg reports neither difference.
 *
 * JPEG is the acknowledged residual: a scan-back for the EOI marker would risk
 * discarding a perfectly good cover over trailing bytes, so truncated JPEGs are
 * caught by the content-length comparison in `fetchCoverImage` instead — which
 * is every response that declares a length, i.e. every ordinary GCS read.
 *
 * What this deliberately does NOT do is decode. A payload carrying a
 * structurally present but internally garbage IDAT / VP8 chunk still reports
 * `ok` here, and Resvg will still drop it silently. Proving otherwise means
 * inflating the pixel data in the same 512Mi process this module exists to keep
 * bounded, so that residual is accepted: it is caught, if at all, by the
 * `catch` around `render()`.
 */

/**
 * The RIFF chunk types that actually carry encoded pixels. `VP8 ` (note the
 * trailing space) is lossy, `VP8L` lossless, and `ANMF` an animation frame —
 * an animated WebP holds its VP8/VP8L payloads *inside* ANMF rather than at
 * the top level, so an ANMF is as much image data as the other two.
 *
 * Everything else at the top level is metadata: `VP8X` only declares the
 * canvas size and feature flags, `ALPH` is an alpha plane that must be paired
 * with a VP8, and `ICCP`/`EXIF`/`XMP ` are ancillary. That matters because
 * `readWebpDimensions` reads its answer straight out of `VP8X` — so a 30-byte
 * RIFF+VP8X payload parses cleanly, reports 800x630, passes the pixel budget,
 * and contains no image whatsoever. Cover variants are generated as WebP, so
 * this is the dominant production format, not an edge case.
 */
const WEBP_IMAGE_CHUNKS = ["VP8 ", "VP8L", "ANMF"];

function hasWebpImageData(bytes: Uint8Array) {
  if (
    bytes.length < 12 ||
    !matchesAscii(bytes, 0, "RIFF") ||
    !matchesAscii(bytes, 8, "WEBP")
  ) {
    return false;
  }
  const riffEnd = readUint32Le(bytes, 4) + 8;
  // A RIFF that claims more than arrived is a cut-off transfer, which
  // `declaresMoreBytesThanReceived` classifies; either way it is not complete.
  if (riffEnd > bytes.length || riffEnd < 12) return false;

  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const chunkSize = readUint32Le(bytes, offset + 4);
    const dataEnd = offset + 8 + chunkSize;
    if (dataEnd > riffEnd) return false;
    if (
      chunkSize > 0 &&
      WEBP_IMAGE_CHUNKS.some((chunk) => matchesAscii(bytes, offset, chunk))
    ) {
      return true;
    }
    // RIFF pads odd-sized chunks to an even boundary.
    offset = dataEnd + (chunkSize % 2);
  }
  return false;
}

export function hasCompleteImageData(bytes: Uint8Array, type: string) {
  const normalized = type.toLowerCase();
  if (normalized === "image/webp") return hasWebpImageData(bytes);
  if (normalized !== "image/png") return true;

  let offset = 8; // past the signature; the caller already matched it
  let sawImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = readUint32Be(bytes, offset);
    // PNG chunk lengths are capped at 2^31-1 by the spec; anything larger is
    // corruption, and unsigned arithmetic would otherwise wrap the bound.
    if (length > 0x7fffffff) return false;
    // A zero-length IDAT is legal but carries nothing, and a payload whose
    // only IDATs are empty is not an image. Require at least one with bytes.
    if (length > 0 && matchesAscii(bytes, offset + 4, "IDAT")) {
      sawImageData = true;
    }
    // IEND is mandated to be zero-length. A non-zero one is not "the end of a
    // complete image", it is corruption that happens to spell IEND -- and
    // Resvg drops such a raster silently, which is the failure mode this whole
    // function exists to stop from being reported as `ok`.
    //
    // `sawImageData` is the other half of the same argument, and it is not
    // theoretical: a signature + IHDR + IEND payload is a well-formed chunk
    // chain carrying no pixels at all, and pinned Resvg 2.6.2 renders it to a
    // card byte-identical to the coverless one. Terminating correctly is not
    // the same as containing an image; the PNG spec requires at least one IDAT.
    if (matchesAscii(bytes, offset + 4, "IEND")) {
      return length === 0 && sawImageData;
    }
    offset += 12 + length;
  }
  return false;
}

/**
 * Does the payload's own container header declare more bytes than we hold?
 *
 * This is NOT the same question as `hasCompleteImageData`. That one asks
 * whether a payload we could parse ends properly; this one catches the case
 * where the payload is too short to parse AT ALL yet still says how long it
 * was supposed to be. WebP is the case that matters: `readWebpDimensions`
 * returns `null` for a RIFF whose declared size overruns the buffer, which is
 * indistinguishable at the call site from "this is not a WebP" -- so a
 * chunked, undeclared-length transfer cut off after the RIFF/VP8X header would
 * be filed as a permanent `undecodable_header`, obscuring the retryable
 * transfer failure. Cover
 * variants are generated as WebP, so that is the dominant path, not an edge.
 *
 * PNG needs nothing here: its signature and IHDR fit in 33 bytes, so a
 * truncated PNG parses and is caught by `hasCompleteImageData` instead.
 */
export function declaresMoreBytesThanReceived(bytes: Uint8Array, type: string) {
  if (type.toLowerCase() !== "image/webp") return false;
  if (
    bytes.length < 12 ||
    !matchesAscii(bytes, 0, "RIFF") ||
    !matchesAscii(bytes, 8, "WEBP")
  ) {
    // Not a RIFF container at all: nothing declared, so nothing to compare.
    return false;
  }
  return readUint32Le(bytes, 4) + 8 > bytes.length;
}

/**
 * Why the body is read incrementally instead of `await response.arrayBuffer()`.
 *
 * The old shape buffered the WHOLE body first and only then compared its size
 * against MAX_IMAGE_BYTES — so an 8 GiB object (or an endless chunked stream)
 * was already fully resident in this 512Mi SSR process by the time the check
 * ran. 's crash arithmetic counts exactly such allocations: bytes + base64
 * + SVG string per concurrent request against a ~257MB heap ceiling.
 *
 * The cap is therefore enforced DURING the read: as soon as one more chunk
 * would push the running total past `maxBytes`, that chunk is DISCARDED — it is
 * never pushed onto the accumulator — the stream is cancelled, and the
 * over-budget result returned without ever materialising the rest. Peak memory
 * for a rejected body is one chunk past the cap, not the body.
 *
 * The comparison happens BEFORE the addition (`value.byteLength >
 * maxBytes - received`, not after `received += value.byteLength`), so no chunk
 * size can overflow the running count past the cap and no offending chunk is
 * ever retained.
 *
 * The declared-length pre-check in fetchCoverImage stays: it rejects the
 * common case before a single byte moves, and it is what keeps the JPEG
 * truncation residual in `hasCompleteImageData`'s comment true — that argument
 * now leans on this function counting exactly what arrived, which it does.
 */
type CappedBody =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "over_budget" }
  | { kind: "read_failed" };

async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<CappedBody> {
  const stream = response.body;
  if (!stream) {
    // No streaming body at all (undici only omits it on 204/304/HEAD-shaped
    // responses, none of which reach here with ok:true). Hand back an empty
    // payload and let the existing checks below classify it: a declared
    // length becomes `length_mismatch`, no length fails header parsing —
    // the same answers an empty buffered body produced before.
    return { kind: "ok", bytes: new Uint8Array(0) };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Cap FIRST, against the remaining budget, before retaining anything:
      // `maxBytes - received` cannot overflow because received <= maxBytes
      // holds on every iteration (the branch below guarantees it), and a
      // chunk that would breach the budget is dropped instead of pushed.
      if (value.byteLength > maxBytes - received) {
        return { kind: "over_budget" };
      }
      chunks.push(value);
      received += value.byteLength;
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: "ok", bytes };
  } catch {
    // Mid-stream failure: connection reset, decompression error, abort. The
    // headers arrived and the body did not — the same situation the old
    // `catch` around arrayBuffer() saw.
    return { kind: "read_failed" };
  } finally {
    // Always release the socket: on over-budget we are abandoning a transfer
    // that may still be mid-flight from a server that has not noticed; on
    // success the call is a harmless no-op on a finished reader.
    try {
      await reader.cancel();
    } catch {
      // A reader that already errored or closed cannot be cancelled; the
      // underlying socket is gone either way.
    }
  }
}

export async function fetchImageBytes(
  fetch: typeof globalThis.fetch,
  source: string | undefined,
  base: URL,
  options: {
    budget?: ImageBudget;
    redirect?: RequestRedirect;
    credentials?: RequestCredentials;
  } = {},
): Promise<ImageBytesResult> {
  if (!source) return absent("no_featured_image");

  let target: URL;
  try {
    target = new URL(source, base);
  } catch {
    return failed("permanent", "unparsable_url");
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    return failed("permanent", "unsupported_protocol");
  }

  let response: Response;
  try {
    response = await fetch(target, {
      signal: AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS),
      ...(options.redirect ? { redirect: options.redirect } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
    });
  } catch {
    // DNS, TLS, connection reset, abort/timeout: nothing here says the object
    // is bad, only that this attempt did not reach it.
    return failed("transient", "fetch_failed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return failed(
      classifyResponseStatus(response.status),
      "http_error",
      response.status,
    );
  }

  const type =
    response.headers.get("content-type")?.split(";")[0]?.toLowerCase() || "";
  const declaredLengthHeader = response.headers.get("content-length");
  const declaredLength =
    declaredLengthHeader === null ? null : Number(declaredLengthHeader);
  if (!SUPPORTED_IMAGE_TYPES.has(type)) {
    await response.body?.cancel().catch(() => {});
    return failed("permanent", "unsupported_type");
  }
  if (
    declaredLength !== null &&
    (!Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > MAX_IMAGE_BYTES)
  ) {
    await response.body?.cancel().catch(() => {});
    return failed("permanent", "declared_length_rejected");
  }

  const read = await readBodyCapped(response, MAX_IMAGE_BYTES);
  if (read.kind === "over_budget") {
    return failed("permanent", "byte_budget_exceeded");
  }
  if (read.kind === "read_failed") {
    // The headers arrived and the body did not. That is a truncated transfer,
    // not a statement about the object.
    return failed("transient", "body_read_failed");
  }
  const bytes = read.bytes;
  // Short of what the origin said it would send. Undici usually raises on this
  // first (caught above), but a proxy in between can terminate cleanly and
  // leave us holding a partial object. Either way the object is fine and the
  // transfer was not, so classify it as retryable and expose that in the card
  // diagnostics; its fallback response stays no-store.
  if (declaredLength !== null && bytes.byteLength !== declaredLength) {
    return failed("transient", "length_mismatch");
  }
  const size = readImageDimensions(bytes, type);
  if (!size) {
    // Same tie-break as the IEND case below, applied one step earlier because
    // a truncated WebP fails to PARSE rather than failing to terminate. With a
    // declared length that we received in full the transfer finished and the
    // object really is junk; with no declared length a cut-off stream and a
    // corrupt object look identical, and the tie goes to retryable.
    if (declaredLength === null && declaresMoreBytesThanReceived(bytes, type)) {
      return failed("transient", "incomplete_image_data");
    }
    return failed("permanent", "undecodable_header");
  }
  // Budget before completeness, deliberately: an over-budget raster is refused
  // whether or not the transfer finished, and calling that `transient` would
  // put a decompression bomb on a 60s retry loop.
  if (!isWithinImageBudget(size, options.budget)) {
    return failed("permanent", "pixel_budget_exceeded");
  }
  if (!hasCompleteImageData(bytes, type)) {
    // Same missing IEND, two different facts. If the origin declared a length
    // and we received exactly it, the TRANSFER finished and the stored object
    // is the broken thing — permanent, and re-rendering it every minute would
    // only burn the pods  says are already OOMing. With no declared
    // length we cannot tell a corrupt object from a cut-off stream, and the
    // tie goes to retryable.
    return declaredLength !== null
      ? failed("permanent", "corrupt_image_data")
      : failed("transient", "incomplete_image_data");
  }

  return { outcome: "ok", bytes, type };
}

export async function fetchCoverImage(
  fetch: typeof globalThis.fetch,
  source: string | undefined,
  base: URL,
): Promise<CoverResult> {
  const result = await fetchImageBytes(fetch, source, base);
  if (result.outcome !== "ok") return result;
  const { bytes, type } = result;

  // Resvg accepts PNG/JPEG but silently omits WebP images. The generated
  // cover ladder is WebP, so a successful fetch alone cannot mean a visible
  // cover. Decode only after the byte, dimension and completeness guards;
  // libvips independently enforces the pixel limit and reads one frame.
  if (type === "image/webp") {
    try {
      const png = await sharp(bytes, {
        limitInputPixels: MAX_IMAGE_PIXELS,
        pages: 1,
      })
        .png()
        .toBuffer();
      return {
        dataUri: `data:image/png;base64,${png.toString("base64")}`,
        outcome: "ok",
      };
    } catch {
      // A decoder failure can also be resource pressure. Keep the existing
      // retryable fallback contract instead of pinning a coverless card.
      return failed("transient", "decode_failed");
    }
  }

  // Zero-copy on purpose: `bytes` was assembled above as a fresh Uint8Array
  // owning an exactly-sized ArrayBuffer, so Buffer.from over the BUFFER region
  // is a view. The obvious `Buffer.from(bytes)` would silently COPY the whole
  // payload — up to another 8MiB live at peak in this process  — for
  // no benefit: nothing mutates `bytes` after this line.
  return {
    dataUri: `data:${type};base64,${Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).toString("base64")}`,
    outcome: "ok",
  };
}
