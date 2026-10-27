import {
  PUBLIC_STREAM_TYPES,
  STREAM_TYPES,
  isPublicStreamType,
  requiresAuthenticatedViewer,
} from "$lib/streamTypes.js";

export {
  PUBLIC_STREAM_TYPES,
  STREAM_TYPES,
  isPublicStreamType,
  requiresAuthenticatedViewer,
};

export type StreamType = (typeof STREAM_TYPES)[number];

export type PublicStreamType = (typeof PUBLIC_STREAM_TYPES)[number];

export type LivePageData = {
  creator: any;
  type: PublicStreamType;
  username: string;
  /**
   *an anonymous social unfurler on a protected stream. The page
   * renders the creator's public card and a log-in prompt, and never mounts
   * the viewer (so never asks the API for a meeting or a token).
   */
  gatedPreview: boolean;
  /** Original authenticated viewer for PPV admission and automatic retries. */
  viewerActorId?: number;
};

export function isStreamType(value: string): value is StreamType {
  return (STREAM_TYPES as readonly string[]).includes(value);
}
