import DOMPurify from "isomorphic-dompurify";

export const markdownSanitizeOptions = {
  ADD_TAGS: ["audio", "video", "source"],
  ADD_ATTR: [
    "aria-describedby",
    "aria-hidden",
    "aria-label",
    "class",
    "controls",
    "data-audio-url",
    "data-embed-url",
    "data-footnote-backref",
    "data-footnote-ref",
    "data-footnotes",
    "data-qr-value",
    "href",
    "id",
    "loading",
    "src",
    "title",
    "alt",
  ],
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|mailto|tel):|\/(?!\/)|#|[^:/?#]*(?:[/?#]|$))/i,
};

/**
 * Markdown is sanitized at the utility boundary so every consumer is safe,
 * including any future consumer that does not use MarkdownContent.
 */
export function sanitizeMarkdownHtml(content: string) {
  return DOMPurify.sanitize(content, markdownSanitizeOptions);
}
