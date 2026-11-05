/** Session-only recovery. Identity is taken from a hydrated response, never a live URL. */
export type ConflictDraft = {
  title: string;
  content: string;
  description: string;
  canonicalUrl: string;
  coverImage: string;
  coverImageId: number | null;
  tags: string[];
  zcashAddress: string;
  vanity: string;
  isPublished: boolean;
  isSubscriberOnly: boolean;
  publishAt: string;
  showCover: boolean;
  showSubtitle: boolean;
};
export function conflictDraftKey(
  actor: number,
  article: string,
  language: string,
) {
  return `editor-conflict:v1:${JSON.stringify([actor, article, language])}`;
}
export function readConflictDraft(key: string): ConflictDraft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "null");
    if (
      !value ||
      ![
        "title",
        "content",
        "description",
        "canonicalUrl",
        "coverImage",
        "zcashAddress",
        "vanity",
        "publishAt",
      ].every((k) => typeof value[k] === "string") ||
      !["isPublished", "isSubscriberOnly", "showCover", "showSubtitle"].every(
        (k) => typeof value[k] === "boolean",
      ) ||
      !Array.isArray(value.tags) ||
      !value.tags.every((v: unknown) => typeof v === "string") ||
      !(value.coverImageId === null || Number.isSafeInteger(value.coverImageId))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function storeConflictDraft(key: string, draft: ConflictDraft): boolean {
  try {
    const bytes = JSON.stringify(draft);
    sessionStorage.setItem(key, bytes);
    return sessionStorage.getItem(key) === bytes;
  } catch {
    return false;
  }
}
export function clearConflictDraft(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Never sacrifice in-memory edits. */
  }
}
