import { parse } from "parse5";
import sharp from "sharp";

export const IMAGE_BYTE_LIMIT = 600_000;
/** @type {Record<string, string>} */
const IMAGE_MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** @param {import("parse5").DefaultTreeAdapterMap["childNode"]} node
 * @returns {node is import("parse5").DefaultTreeAdapterMap["element"]} */
const isElement = (node) => "tagName" in node;

/** Parse the response head, never script strings, body markup or hydrated DOM.
 * @param {string} html */
export function inspectSocialHead(html) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes
    .filter(isElement)
    .find((node) => node.tagName === "html");
  const head = root?.childNodes
    .filter(isElement)
    .find((node) => node.tagName === "head");
  const tags = new Map();
  let canonical;
  const errors = [];
  for (const node of head?.childNodes.filter(isElement) || []) {
    const attrs = Object.fromEntries(
      (node.attrs || []).map(({ name, value }) => [name, value]),
    );
    if (node.tagName === "link" && attrs.rel === "canonical") {
      if (canonical !== undefined) errors.push("duplicate canonical link");
      canonical = attrs.href;
    }
    if (node.tagName !== "meta") continue;
    const key = attrs.property || attrs.name;
    if (!key?.startsWith("og:") && !key?.startsWith("twitter:")) continue;
    if (tags.has(key)) errors.push(`duplicate ${key}`);
    tags.set(key, attrs.content || "");
    if (key.startsWith("twitter:") && attrs.name !== key)
      errors.push(`${key} must use name`);
    if (key.startsWith("og:") && attrs.property !== key)
      errors.push(`${key} must use property`);
    if (
      Buffer.byteLength(
        html.slice(0, node.sourceCodeLocation?.startOffset || 0),
      ) >= 300_000
    ) {
      errors.push(`${key} appears after the first 300KB`);
    }
  }
  for (const key of [
    "og:title",
    "og:description",
    "og:type",
    "og:url",
    "og:image",
    "og:image:alt",
    "twitter:card",
    "twitter:title",
    "twitter:description",
    "twitter:image",
    "twitter:image:alt",
  ]) {
    if (!tags.get(key)?.trim()) errors.push(`missing ${key}`);
  }
  for (const [name, value] of [
    ["canonical", canonical],
    ["og:url", tags.get("og:url")],
    ["og:image", tags.get("og:image")],
    ["twitter:image", tags.get("twitter:image")],
  ]) {
    try {
      if (new URL(value).protocol !== "https:") throw new Error();
    } catch {
      errors.push(`${name} must be an absolute HTTPS URL`);
    }
  }
  if (tags.get("og:url") !== canonical)
    errors.push("canonical and og:url differ");
  if (tags.get("og:image") !== tags.get("twitter:image"))
    errors.push("OG and Twitter image URLs differ");
  if (
    tags.has("og:image:secure_url") &&
    tags.get("og:image:secure_url") !== tags.get("og:image")
  )
    errors.push("og:image:secure_url differs from og:image");
  if (!["summary", "summary_large_image"].includes(tags.get("twitter:card")))
    errors.push("unsupported twitter:card");
  return {
    errors,
    tags: Object.fromEntries(tags),
    canonical,
    imageUrl: tags.get("og:image"),
  };
}

/** @param {Uint8Array} bytes
 * @param {string | null} contentType
 * @param {Record<string, string>} [tags] */
export async function inspectSocialImage(bytes, contentType, tags = {}) {
  const errors = [];
  const warnings = [];
  if (bytes.byteLength >= IMAGE_BYTE_LIMIT)
    errors.push(
      "image must be under 600KB for the shared compatibility target",
    );
  let info;
  try {
    const image = sharp(bytes, { limitInputPixels: 25_000_000, pages: 1 });
    info = await image.metadata();
    if (!IMAGE_MIME[info.format])
      errors.push(`unsupported social image format: ${info.format}`);
    // Metadata alone accepts truncated/corrupt pixel data.
    await image.stats();
  } catch {
    errors.push("image pixels cannot be decoded");
  }
  if (info) {
    if (info.width < 1200 || info.height < 627)
      warnings.push("LinkedIn sharing-module minimum is 1200×627");
    if (info.width < 900)
      warnings.push("Apple Messages recommends an image at least 900px wide");
    const mime = IMAGE_MIME[info.format];
    if (contentType?.split(";")[0]?.trim().toLowerCase() !== mime)
      errors.push("HTTP image Content-Type does not match decoded format");
    if (tags["og:image:type"] && tags["og:image:type"] !== mime)
      errors.push("og:image:type does not match decoded format");
    for (const dimension of /** @type {const} */ (["width", "height"])) {
      const declared = tags[`og:image:${dimension}`];
      if (declared !== undefined && Number(declared) !== info[dimension])
        errors.push(`og:image:${dimension} does not match decoded image`);
    }
    if (info.width < 300 || info.width / info.height > 4)
      errors.push(
        "image does not meet the 300px width / 4:1 maximum aspect target",
      );
  }
  return {
    errors,
    warnings,
    format: info?.format,
    width: info?.width,
    height: info?.height,
    bytes: bytes.byteLength,
  };
}

/** @param {Response} response @param {number} limit */
async function readCapped(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response has no body");
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error(`response exceeds ${limit} bytes`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/** Opt-in network probe; injected fetch keeps CI fixture tests offline.
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, userAgent?: string, assetOrigin?: string, assetSourceOrigin?: string, allowedImageOrigins?: string[]}} [options] */
export async function checkSocialPreview(
  url,
  {
    fetchImpl = fetch,
    userAgent = "Twitterbot/1.0",
    assetOrigin,
    assetSourceOrigin = "https://free2z.cash",
    allowedImageOrigins = [],
  } = {},
) {
  const pageOrigin = new URL(url).origin;
  const sourceOrigin = new URL(assetSourceOrigin).origin;
  if (new URL(assetSourceOrigin).protocol !== "https:")
    throw new Error("asset source origin must use HTTPS");
  if (assetOrigin && new URL(assetOrigin).protocol !== "https:")
    throw new Error("asset origin must use HTTPS");
  /** @param {string} target @param {number} limit @param {Set<string>} origins */
  const get = async (target, limit, origins) => {
    // The origin permits a 30s cold render. Include transfer margin, and share
    // one resource deadline across redirects rather than renewing every hop.
    // Node 24 operator/CI probe; this module never runs in a browser.
    // eslint-disable-next-line free2z-runtime/compatibility-floor
    const signal = AbortSignal.timeout(35_000);
    for (let hop = 0; hop <= 3; hop++) {
      const address = new URL(target);
      if (
        address.protocol !== "https:" ||
        address.username ||
        address.password ||
        !origins.has(address.origin)
      )
        throw new Error("URL origin is not allowed");
      const response = await fetchImpl(target, {
        redirect: "manual",
        headers: { "user-agent": userAgent },
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("redirect has no Location");
        target = new URL(location, target).href;
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}: ${target}`);
      }
      return { response, bytes: await readCapped(response, limit) };
    }
    throw new Error("too many redirects");
  };
  const page = await get(url, 2_000_000, new Set([pageOrigin]));
  if (!page.response.headers.get("content-type")?.includes("text/html"))
    throw new Error("page response is not HTML");
  const head = inspectSocialHead(page.bytes.toString("utf8"));
  if (page.bytes.byteLength > 1_000_000)
    head.errors.push("page HTML exceeds the 1MB Messages target");
  if (head.errors.length || !head.canonical) return { url, ...head };
  let imageUrl = head.imageUrl;
  // Stage emits production canonical URLs. An explicit operator override
  // checks the deployed stage renderer. Asset ownership uses configured origins,
  // never an article's creator-supplied external canonical.
  if (
    assetOrigin &&
    [sourceOrigin, pageOrigin].includes(new URL(imageUrl).origin)
  ) {
    const image = new URL(imageUrl);
    imageUrl = new URL(image.pathname + image.search, assetOrigin).href;
  }
  const image = await get(
    imageUrl,
    5_000_000,
    new Set([
      pageOrigin,
      sourceOrigin,
      ...(assetOrigin ? [new URL(assetOrigin).origin] : []),
      ...allowedImageOrigins,
    ]),
  );
  const result = await inspectSocialImage(
    image.bytes,
    image.response.headers.get("content-type"),
    head.tags,
  );
  return {
    url,
    ...head,
    image: { url: imageUrl, ...result },
    errors: [...head.errors, ...result.errors],
    warnings: result.warnings,
  };
}
