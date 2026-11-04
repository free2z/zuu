// Shared client-side helpers for the bounded public live discovery response.

export const LIVE_DISCOVERY_LIMIT = 12;

/**
 * Discovery is a changing live snapshot, never a cacheable homepage asset.
 * Keep the anonymous credential policy beside the cache policy so callers
 * cannot accidentally recreate a stale or personalized live rail.
 *
 * @param {string} baseURL
 * @returns {{baseURL: string, credentials: "omit", cache: "no-store"}}
 */
export function createLiveDiscoveryOptions(baseURL) {
  return { baseURL, credentials: "omit", cache: "no-store" };
}

/**
 * Convert discovery rows into the subset of the live-status contract that
 * discovery can honestly provide. It deliberately has no participant count:
 * the public list does not query the provider for viewers.
 *
 * @param {any[]} streams
 * @returns {{is_live: true, streams: any[]}}
 */
export function liveStatusFromStreams(streams) {
  return {
    is_live: true,
    streams: streams.map((stream) => ({
      type: stream.meeting_type,
      ...(stream.price_per_minute == null
        ? {}
        : { price_per_minute: Number(stream.price_per_minute) }),
    })),
  };
}

/**
 * Resolve the status a creator card may safely use from the shared snapshot.
 * `undefined` means discovery is unavailable or incomplete for this creator,
 * so LiveIndicator must keep its own live-status polling enabled. `null` is a
 * known offline result; an array is the complete public stream list.
 *
 * @param {{results: any[], selected_creators: string[], complete: boolean} | undefined} liveNow
 * @param {Map<string, any[]> | undefined} liveCreatorsByUsername
 * @param {string} username
 * @returns {any[] | null | undefined}
 */
export function liveStreamsForCreator(
  liveNow,
  liveCreatorsByUsername,
  username,
) {
  if (liveNow === undefined) return undefined;
  const streams = liveCreatorsByUsername?.get(username);
  if (streams?.length) return streams;
  if (liveNow.complete || liveNow.selected_creators.includes(username)) {
    return null;
  }
  return undefined;
}

/**
 * @param {unknown} response
 * @returns {{results: any[], selected_creators: string[], complete: boolean} | undefined}
 */
export function resolveLiveDiscovery(response) {
  const objectResponse =
    /** @type {{results?: unknown; selected_creators?: unknown; complete?: unknown}} */ (
      response
    );
  const rows = Array.isArray(response)
    ? response
    : response &&
        typeof response === "object" &&
        Array.isArray(objectResponse.results)
      ? objectResponse.results
      : undefined;
  if (!rows) return undefined;

  const rowUsernames = [
    ...new Set(
      rows
        .map((row) => row?.username)
        .filter((username) => typeof username === "string"),
    ),
  ];
  if (Array.isArray(response)) {
    return {
      results: rows,
      selected_creators: rowUsernames,
      complete: rowUsernames.length < LIVE_DISCOVERY_LIMIT,
    };
  }

  const selectedCreators = Array.isArray(objectResponse.selected_creators)
    ? objectResponse.selected_creators.filter(
        (username) => typeof username === "string",
      )
    : rowUsernames;
  return {
    results: rows,
    selected_creators: selectedCreators,
    complete:
      typeof objectResponse.complete === "boolean"
        ? objectResponse.complete
        : selectedCreators.length < LIVE_DISCOVERY_LIMIT,
  };
}
