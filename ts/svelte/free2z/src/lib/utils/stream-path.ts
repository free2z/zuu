import type { StreamType } from "$lib/stores/liveStreamStore";

/**
 * Return the canonical viewer URL for a stream.
 *
 * Public streams use the shareable `/{username}/{type}` form. Private streams
 * are still represented by their secret route, so keep the existing live
 * fallback for the defensive case where one is supplied by an API response.
 */
export function streamWatchPath(username: string, type: StreamType): string {
  const encodedUsername = encodeURIComponent(username);

  if (type === "private") {
    return `/live/${encodedUsername}?type=private`;
  }

  return `/${encodedUsername}/${encodeURIComponent(type)}`;
}
