import * as env from "$app/env/public";
import { error } from "@sveltejs/kit";
import { CANONICAL_ORIGIN, DEFAULT_SOCIAL_IMAGE } from "$lib/seo";
import {
  isSupportedPublicImageVersion,
  publicImageSource,
} from "$lib/public-social-image";
import { fetchImageBytes, PUBLIC_IMAGE_BUDGET } from "$lib/server/og-image";
import {
  acquireOgRenderSlot,
  GateSaturationError,
} from "$lib/server/og-render-gate";
import { normalizePublicImage } from "$lib/server/og-public-image";
import { encodeSocialPng } from "$lib/server/og-output";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, fetch, setHeaders }) => {
  function refuse(status: 400 | 503, message: string): never {
    setHeaders({ "cache-control": "no-store" });
    throw error(status, { message, code: status });
  }
  const sources = url.searchParams.getAll("source");
  const versions = url.searchParams.getAll("renderer");
  if (
    sources.length !== 1 ||
    versions.length !== 1 ||
    !isSupportedPublicImageVersion(versions[0]) ||
    [...url.searchParams.keys()].some(
      (key) => key !== "source" && key !== "renderer",
    )
  ) {
    refuse(400, "Invalid public image request");
  }
  // Never derive the fetch origin from request Host or forwarded headers.
  const canonicalOrigin = env.PUBLIC_CANONICAL_BASE_URL || CANONICAL_ORIGIN;
  const target = publicImageSource(sources[0], canonicalOrigin);
  if (!target) refuse(400, "Invalid public image source");

  let release: () => void;
  try {
    release = await acquireOgRenderSlot();
  } catch (cause) {
    if (cause instanceof GateSaturationError)
      refuse(503, "Image renderer busy");
    throw cause;
  }
  try {
    const image = await fetchImageBytes(
      fetch,
      target.href,
      new URL(canonicalOrigin),
      {
        budget: PUBLIC_IMAGE_BUDGET,
        redirect: "manual",
        credentials: "omit",
      },
    );
    // An unrecognizable header can be a cleanly terminated partial transfer.
    // Keep that uncertainty retryable instead of caching a replacement image.
    if (image.outcome !== "ok" && image.reason === "undecodable_header") {
      refuse(503, "Public image temporarily unavailable");
    }
    if (image.outcome === "permanent") {
      // A trusted relative asset path keeps stage on stage without consulting
      // Host. No second fetch/decode is needed for a conclusively unusable file.
      return new Response(null, {
        status: 302,
        headers: {
          location: DEFAULT_SOCIAL_IMAGE,
          "cache-control": "public, max-age=60, s-maxage=300",
          "x-free2z-og-outcome": "permanent",
        },
      });
    }
    if (image.outcome !== "ok")
      refuse(503, "Public image temporarily unavailable");
    let png: Uint8Array;
    try {
      png = await encodeSocialPng(await normalizePublicImage(image.bytes));
    } catch {
      // Corruption and native resource pressure can look identical. Never
      // cache a house card as successful artwork under that uncertainty.
      refuse(503, "Public image temporarily unavailable");
    }
    return new Response(new Uint8Array(png), {
      headers: {
        "content-type": "image/png",
        "content-length": String(png.byteLength),
        // Re-check the existing upload authorization/cache boundary on every
        // fetch. A derivative cache would outlive source revocation and would
        // not be cleared by the established /uploadz/* takedown invalidation.
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-free2z-og-outcome": "ok",
      },
    });
  } finally {
    release();
  }
};
