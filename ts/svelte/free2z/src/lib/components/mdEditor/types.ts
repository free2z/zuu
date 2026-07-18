import type { ZPage } from "$lib/types/zpage";

export type EditorMode = "write" | "preview" | "split";

export interface EditorValidationErrors {
  title?: string;
  vanity?: string;
  description?: string;
}

export interface EditorCurrentUser {
  username: string;
  p2paddr?: string | null;
}

export interface HydratedEditorState {
  currentZPage: ZPage | null;
  title: string;
  description: string;
  coverImage: string;
  coverImageId: number | null;
  selectedCategories: string[];
  zcashAddress: string;
  content: string;
  vanity: string;
  isPublished: boolean;
  isSubscriberOnly: boolean;
  publishAt: string;
  showCover: boolean;
  showSubtitle: boolean;
}
