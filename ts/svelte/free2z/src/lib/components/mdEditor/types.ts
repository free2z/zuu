import type { ZPage } from "$lib/types/zpage";

export type EditorMode = "write" | "preview" | "split";

/**
 * Per-field save errors, keyed by the API's field name.
 *
 * The listed keys are the ones a component renders next to an input. The index
 * signature is deliberate: the editor no longer enumerates which rejected
 * fields it is willing to *carry*, so a field with no inline slot still
 * arrives here and still reaches the creator through the save notice, instead
 * of being dropped into a generic "Failed to save article".
 */
export interface EditorValidationErrors {
  title?: string;
  vanity?: string;
  description?: string;
  canonical_url?: string;
  publish_at?: string;
  [field: string]: string | undefined;
}

export interface EditorCurrentUser {
  id?: number;
  username: string;
  p2paddr?: string | null;
}

export interface HydratedEditorState {
  currentZPage: ZPage | null;
  title: string;
  description: string;
  canonicalUrl: string;
  coverImage: string;
  coverImageId: number | null;
  tags: string[];
  zcashAddress: string;
  content: string;
  vanity: string;
  isPublished: boolean;
  isSubscriberOnly: boolean;
  publishAt: string;
  showCover: boolean;
  showSubtitle: boolean;
}
