import * as publicEnv from "$app/env/public";
import { CANONICAL_ORIGIN } from "$lib/seo";
import {
  badRequestResponse,
  renderUrlset,
  STATIC_SITEMAP_ENTRIES,
  unavailableResponse,
  xmlResponse,
} from "$lib/server/sitemap";
import type { RequestHandler } from "./$types";

const canonicalOrigin =
  publicEnv.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, "") || CANONICAL_ORIGIN;

export const GET: RequestHandler = async ({ url }) => {
  if (url.search) return badRequestResponse();

  try {
    return xmlResponse(renderUrlset(STATIC_SITEMAP_ENTRIES, canonicalOrigin));
  } catch (cause) {
    console.error("Unable to build the static sitemap child.", cause);
    return unavailableResponse();
  }
};
