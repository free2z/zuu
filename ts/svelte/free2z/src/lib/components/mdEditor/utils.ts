import "highlight.js/styles/github-dark.css";
import { env } from "$env/dynamic/public";
import type { ZPage } from "$lib/types/zpage";
import type { HydratedEditorState } from "./types";
import { processMarkdown } from "$lib/utils/markdown";

const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";

export const UNTITLED_DRAFT_TITLE = "Untitled";

export function resolveMediaUrl(path?: string | null) {
  if (!path) {
    return "";
  }

  if (/^https?:\/\//i.test(path) || !apiBase) {
    return path;
  }

  return `${apiBase}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function renderMarkdown(content: string) {
  try {
    return processMarkdown(content);
  } catch {
    return '<p class="text-red-500">Error rendering markdown</p>';
  }
}

export function slugify(text: string) {
  if (!text) {
    return "";
  }

  let normalized = text.toLowerCase().trim();
  normalized = normalized.normalize?.("NFKD") ?? normalized;

  try {
    normalized = normalized.replace(/\p{M}/gu, "");
    normalized = normalized.replace(/[^\p{L}\p{N}\s_-]/gu, "");
  } catch {
    normalized = normalized.replace(/[\u0300-\u036f]/g, "");
    normalized = normalized.replace(/[^\w\s-]/g, "");
  }

  return normalized.replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function toDatetimeLocal(iso?: string | null) {
  if (!iso) {
    return "";
  }

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const pad = (value: number) => String(value).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function hydrateEditorState(zpage: ZPage | null): HydratedEditorState {
  const isUntitledDraftPlaceholder =
    zpage &&
    !zpage.is_published &&
    zpage.title === UNTITLED_DRAFT_TITLE &&
    !zpage.vanity;

  return {
    currentZPage: zpage,
    title: isUntitledDraftPlaceholder ? "" : (zpage?.title ?? ""),
    description: zpage?.description ?? "",
    coverImage: resolveMediaUrl(
      zpage?.featured_image?.url ?? zpage?.featured_image?.thumbnail ?? "",
    ),
    coverImageId: zpage?.featured_image?.id ?? null,
    selectedCategories: zpage?.tags ?? [],
    zcashAddress: zpage?.p2paddr ?? "",
    content: zpage?.content ?? "",
    vanity: zpage?.vanity ?? "",
    isPublished: zpage?.is_published ?? false,
    isSubscriberOnly: zpage?.is_subscriber_only ?? false,
    publishAt: toDatetimeLocal(zpage?.publish_at),
    showCover: Boolean(zpage?.featured_image?.id),
    showSubtitle: Boolean(zpage?.description),
  };
}

export function countWords(content: string) {
  const trimmed = content.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function estimateReadTime(content: string) {
  const wordCount = countWords(content);
  return wordCount > 0 ? Math.ceil(wordCount / 200) : 0;
}

type ListMatch = {
  indentation: string;
  marker: string;
};

type ListEnterResult = {
  nextValue: string;
  nextSelectionStart: number;
  nextSelectionEnd: number;
  pendingEmptyListItemLineStart: number | null;
};

export type EditorSelectionResult = {
  nextValue: string;
  nextSelectionStart: number;
  nextSelectionEnd: number;
};

type LineFormat = "quote" | "bullet" | "ordered";
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

function parseMarkdownListLine(line: string): ListMatch | null {
  const match = line.match(/^(\s*)([-+*]|\d+[.)])(?:\s+(.*))?$/);

  if (!match) {
    return null;
  }

  return {
    indentation: match[1] ?? "",
    marker: match[2] ?? "",
  };
}

function getNextListMarker(marker: string) {
  if (!/^\d+[.)]$/.test(marker)) {
    return marker;
  }

  const delimiter = marker.slice(-1);
  const currentNumber = Number.parseInt(marker.slice(0, -1), 10);

  if (Number.isNaN(currentNumber)) {
    return marker;
  }

  return `${currentNumber + 1}${delimiter}`;
}

function replaceEditorRange(
  content: string,
  selectionStart: number,
  selectionEnd: number,
  replacement: string,
  nextSelectionStart: number,
  nextSelectionEnd: number,
): EditorSelectionResult {
  return {
    nextValue:
      content.slice(0, selectionStart) +
      replacement +
      content.slice(selectionEnd),
    nextSelectionStart,
    nextSelectionEnd,
  };
}

function stripListMarker(line: string) {
  return line.replace(/^(\s*)(?:[-+*]|\d+[.)])\s+/, "$1");
}

function getLineSelectionRange(
  content: string,
  selectionStart: number,
  selectionEnd: number,
) {
  const lineStart = content.lastIndexOf("\n", selectionStart - 1) + 1;
  const selectionReference =
    selectionEnd > selectionStart ? selectionEnd - 1 : selectionEnd;
  const nextNewlineIndex = content.indexOf("\n", selectionReference);
  const lineEnd = nextNewlineIndex === -1 ? content.length : nextNewlineIndex;

  return {
    lineStart,
    lineEnd,
    selectedBlock: content.slice(lineStart, lineEnd),
  };
}

export function toggleInlineMarkdown(
  content: string,
  selectionStart: number,
  selectionEnd: number,
  marker: string,
): EditorSelectionResult {
  const selectedText = content.slice(selectionStart, selectionEnd);
  const markerLength = marker.length;

  if (selectedText.length === 0) {
    return replaceEditorRange(
      content,
      selectionStart,
      selectionEnd,
      `${marker}${marker}`,
      selectionStart + markerLength,
      selectionStart + markerLength,
    );
  }

  if (
    selectedText.startsWith(marker) &&
    selectedText.endsWith(marker) &&
    selectedText.length >= markerLength * 2
  ) {
    const unwrappedText = selectedText.slice(
      markerLength,
      selectedText.length - markerLength,
    );

    return replaceEditorRange(
      content,
      selectionStart,
      selectionEnd,
      unwrappedText,
      selectionStart,
      selectionStart + unwrappedText.length,
    );
  }

  const hasMarkersAroundSelection =
    selectionStart >= markerLength &&
    selectionEnd + markerLength <= content.length &&
    content.slice(selectionStart - markerLength, selectionStart) === marker &&
    content.slice(selectionEnd, selectionEnd + markerLength) === marker;

  if (hasMarkersAroundSelection) {
    return {
      nextValue:
        content.slice(0, selectionStart - markerLength) +
        selectedText +
        content.slice(selectionEnd + markerLength),
      nextSelectionStart: selectionStart - markerLength,
      nextSelectionEnd: selectionEnd - markerLength,
    };
  }

  return replaceEditorRange(
    content,
    selectionStart,
    selectionEnd,
    `${marker}${selectedText}${marker}`,
    selectionStart + markerLength,
    selectionEnd + markerLength,
  );
}

export function insertMarkdownLink(
  content: string,
  selectionStart: number,
  selectionEnd: number,
): EditorSelectionResult {
  const selectedText = content.slice(selectionStart, selectionEnd);
  const linkText = selectedText || "link text";
  const replacement = `[${linkText}](url)`;

  if (selectedText.length > 0) {
    const urlStart = selectionStart + linkText.length + 3;
    return replaceEditorRange(
      content,
      selectionStart,
      selectionEnd,
      replacement,
      urlStart,
      urlStart + 3,
    );
  }

  return replaceEditorRange(
    content,
    selectionStart,
    selectionEnd,
    replacement,
    selectionStart + 1,
    selectionStart + 1 + linkText.length,
  );
}

export function toggleMarkdownLineFormat(
  content: string,
  selectionStart: number,
  selectionEnd: number,
  format: LineFormat,
): EditorSelectionResult {
  const { lineStart, lineEnd, selectedBlock } = getLineSelectionRange(
    content,
    selectionStart,
    selectionEnd,
  );
  const lines = selectedBlock.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const hasSelection = selectionStart !== selectionEnd;
  let orderedLineNumber = 0;

  const allFormatted =
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every((line) => {
      if (format === "quote") {
        return /^(\s*)>\s?/.test(line);
      }

      if (format === "bullet") {
        return /^(\s*)[-+*]\s+/.test(line);
      }

      return /^(\s*)\d+[.)]\s+/.test(line);
    });

  const transformedLines = lines.map((line) => {
    if (line.trim().length === 0) {
      if (allFormatted) {
        return line;
      }

      if (!hasSelection && lines.length === 1) {
        if (format === "quote") return "> ";
        if (format === "bullet") return "- ";
        return "1. ";
      }

      return line;
    }

    if (format === "quote") {
      return allFormatted
        ? line.replace(/^(\s*)>\s?/, "$1")
        : line.replace(/^(\s*)/, "$1> ");
    }

    if (allFormatted) {
      return format === "bullet"
        ? line.replace(/^(\s*)[-+*]\s+/, "$1")
        : line.replace(/^(\s*)\d+[.)]\s+/, "$1");
    }

    const normalizedLine = stripListMarker(line);
    const indentationMatch = normalizedLine.match(/^(\s*)/);
    const indentation = indentationMatch?.[1] ?? "";
    const contentWithoutIndentation = normalizedLine.slice(indentation.length);

    if (format === "bullet") {
      return `${indentation}- ${contentWithoutIndentation}`;
    }

    orderedLineNumber += 1;
    return `${indentation}${orderedLineNumber}. ${contentWithoutIndentation}`;
  });

  const replacement = transformedLines.join("\n");

  if (!hasSelection && lines.length === 1) {
    const originalLine = lines[0] ?? "";
    const transformedLine = transformedLines[0] ?? "";
    const originalLineOffset = selectionStart - lineStart;

    if (allFormatted) {
      let removedPrefixLength = 0;

      if (format === "quote") {
        removedPrefixLength = (originalLine.match(/^(\s*)>\s?/)?.[0] ?? "")
          .length;
      } else if (format === "bullet") {
        removedPrefixLength = (originalLine.match(/^(\s*)[-+*]\s+/)?.[0] ?? "")
          .length;
      } else {
        removedPrefixLength = (
          originalLine.match(/^(\s*)\d+[.)]\s+/)?.[0] ?? ""
        ).length;
      }

      const nextOffset = Math.max(0, originalLineOffset - removedPrefixLength);
      return replaceEditorRange(
        content,
        lineStart,
        lineEnd,
        replacement,
        lineStart + nextOffset,
        lineStart + nextOffset,
      );
    }

    const preservedPrefixLength =
      originalLine.length - originalLine.trimStart().length;
    const transformedPrefixLength =
      transformedLine.length - transformedLine.trimStart().length;
    const additionalPrefixLength =
      transformedPrefixLength - preservedPrefixLength;
    const nextOffset =
      originalLine.trim().length === 0
        ? transformedLine.length
        : Math.max(
            transformedPrefixLength,
            originalLineOffset + additionalPrefixLength,
          );

    return replaceEditorRange(
      content,
      lineStart,
      lineEnd,
      replacement,
      lineStart + nextOffset,
      lineStart + nextOffset,
    );
  }

  return replaceEditorRange(
    content,
    lineStart,
    lineEnd,
    replacement,
    lineStart,
    lineStart + replacement.length,
  );
}

export function toggleMarkdownHeading(
  content: string,
  selectionStart: number,
  selectionEnd: number,
  level: HeadingLevel,
): EditorSelectionResult {
  const { lineStart, lineEnd, selectedBlock } = getLineSelectionRange(
    content,
    selectionStart,
    selectionEnd,
  );
  const lines = selectedBlock.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const hasSelection = selectionStart !== selectionEnd;
  const headingPrefix = `${"#".repeat(level)} `;

  const allFormatted =
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every((line) => /^(\s*)#{1,6}\s+/.test(line)) &&
    nonEmptyLines.every((line) =>
      new RegExp(`^(\\s*)#{${level}}\\s+`).test(line),
    );

  const transformedLines = lines.map((line) => {
    if (line.trim().length === 0) {
      if (allFormatted) {
        return line;
      }

      if (!hasSelection && lines.length === 1) {
        return headingPrefix;
      }

      return line;
    }

    if (allFormatted) {
      return line.replace(/^(\s*)#{1,6}\s+/, "$1");
    }

    const normalizedLine = line.replace(/^(\s*)#{1,6}\s+/, "$1");
    const indentationMatch = normalizedLine.match(/^(\s*)/);
    const indentation = indentationMatch?.[1] ?? "";
    const contentWithoutIndentation = normalizedLine.slice(indentation.length);

    return `${indentation}${headingPrefix}${contentWithoutIndentation}`;
  });

  const replacement = transformedLines.join("\n");

  if (!hasSelection && lines.length === 1) {
    const originalLine = lines[0] ?? "";
    const transformedLine = transformedLines[0] ?? "";
    const originalLineOffset = selectionStart - lineStart;
    const originalPrefixLength = (
      originalLine.match(/^(\s*)#{1,6}\s+/)?.[0] ?? ""
    ).length;
    const transformedPrefixLength = (
      transformedLine.match(/^(\s*)#{1,6}\s+/)?.[0] ?? ""
    ).length;

    if (allFormatted) {
      const nextOffset = Math.max(0, originalLineOffset - originalPrefixLength);
      return replaceEditorRange(
        content,
        lineStart,
        lineEnd,
        replacement,
        lineStart + nextOffset,
        lineStart + nextOffset,
      );
    }

    const nextOffset =
      originalLine.trim().length === 0
        ? transformedLine.length
        : Math.max(
            transformedPrefixLength,
            originalLineOffset +
              (transformedPrefixLength - originalPrefixLength),
          );

    return replaceEditorRange(
      content,
      lineStart,
      lineEnd,
      replacement,
      lineStart + nextOffset,
      lineStart + nextOffset,
    );
  }

  return replaceEditorRange(
    content,
    lineStart,
    lineEnd,
    replacement,
    lineStart,
    lineStart + replacement.length,
  );
}

export function handleMarkdownListEnter(
  content: string,
  selectionStart: number,
  selectionEnd: number,
  exitOnEmptyListItem = true,
): ListEnterResult | null {
  if (selectionStart !== selectionEnd) {
    return null;
  }

  const lineStart = content.lastIndexOf("\n", selectionStart - 1) + 1;
  const nextNewlineIndex = content.indexOf("\n", selectionStart);
  const lineEnd = nextNewlineIndex === -1 ? content.length : nextNewlineIndex;
  const currentLine = content.slice(lineStart, lineEnd);
  const listMatch = parseMarkdownListLine(currentLine);

  if (!listMatch) {
    return null;
  }

  const cursorOffsetInLine = selectionStart - lineStart;
  const rawListPrefix = `${listMatch.indentation}${listMatch.marker}`;
  const listPrefix = currentLine.startsWith(`${rawListPrefix} `)
    ? `${rawListPrefix} `
    : rawListPrefix;

  if (
    !currentLine.startsWith(listPrefix) ||
    cursorOffsetInLine < rawListPrefix.length
  ) {
    return null;
  }

  const contentStart = Math.min(listPrefix.length, currentLine.length);
  const lineContent = currentLine.slice(contentStart);
  const contentBeforeCursor = currentLine.slice(
    contentStart,
    cursorOffsetInLine,
  );
  const contentAfterCursor = currentLine.slice(cursorOffsetInLine);
  const isEmptyListItem =
    lineContent.trim().length === 0 &&
    contentBeforeCursor.trim().length === 0 &&
    contentAfterCursor.trim().length === 0;

  if (isEmptyListItem && exitOnEmptyListItem) {
    if (lineStart === 0 && lineEnd === content.length) {
      return {
        nextValue: "",
        nextSelectionStart: 0,
        nextSelectionEnd: 0,
        pendingEmptyListItemLineStart: null,
      };
    }

    if (lineStart === 0 && nextNewlineIndex !== -1) {
      return {
        nextValue: content.slice(lineEnd + 1),
        nextSelectionStart: 0,
        nextSelectionEnd: 0,
        pendingEmptyListItemLineStart: null,
      };
    }

    return {
      nextValue: content.slice(0, lineStart) + content.slice(lineEnd),
      nextSelectionStart: lineStart,
      nextSelectionEnd: lineStart,
      pendingEmptyListItemLineStart: null,
    };
  }

  const nextListPrefix = `\n${listMatch.indentation}${getNextListMarker(listMatch.marker)} `;
  const nextValue =
    content.slice(0, selectionStart) +
    nextListPrefix +
    content.slice(selectionEnd);
  const nextSelectionStart = selectionStart + nextListPrefix.length;
  const pendingEmptyListItemLineStart =
    nextSelectionStart - nextListPrefix.length + 1;

  return {
    nextValue,
    nextSelectionStart,
    nextSelectionEnd: nextSelectionStart,
    pendingEmptyListItemLineStart,
  };
}

let uploadTokenSequence = 0;

export function createUploadToken() {
  uploadTokenSequence += 1;
  return `upload-${Date.now().toString(36)}-${uploadTokenSequence}`;
}

export function buildUploadPlaceholder(token: string, label: string) {
  return `![${label}](${token})`;
}

export function findUploadPlaceholder(content: string, token: string) {
  // Match any alt text so the placeholder survives the user editing it; the
  // token charset is [a-z0-9-], so no regex escaping is needed.
  const match = content.match(new RegExp(`!\\[[^\\]\\n]*\\]\\(${token}\\)`));

  if (match?.index === undefined) {
    return null;
  }

  return { start: match.index, end: match.index + match[0].length };
}

export function buildImageMarkdown(fileName: string, url: string) {
  const alt =
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[[\]()\n]/g, " ")
      .trim() || "image";

  return `![${alt}](${url})`;
}

export function stripUploadPlaceholders(content: string) {
  return content.replace(/!\[[^\]\n]*\]\(upload-[a-z0-9-]+\)/g, "");
}

export function getDropTextOffset(
  textarea: HTMLTextAreaElement,
  event: DragEvent,
): number {
  // Firefox reports a character offset inside the textarea itself; Chromium
  // and WebKit cannot see into a <textarea>, so fall back to the caret.
  const caretPositionFromPoint = (
    document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
    }
  ).caretPositionFromPoint;
  const position = caretPositionFromPoint?.call(
    document,
    event.clientX,
    event.clientY,
  );

  if (position && position.offsetNode === textarea) {
    return position.offset;
  }

  return textarea.selectionStart ?? textarea.value.length;
}

export function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number,
) {
  const div = document.createElement("div");
  const style = getComputedStyle(textarea);
  const rect = textarea.getBoundingClientRect();
  const safePosition = Math.max(0, Math.min(position, textarea.value.length));
  const fontSize = Number.parseFloat(style.fontSize);
  const measuredLineHeight = Number.parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(measuredLineHeight)
    ? measuredLineHeight
    : Number.isFinite(fontSize)
      ? fontSize * 1.2
      : 16;

  const properties = [
    "direction",
    "box-sizing",
    "width",
    "height",
    "overflow-x",
    "overflow-y",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "border-top-style",
    "border-right-style",
    "border-bottom-style",
    "border-left-style",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "font-style",
    "font-variant",
    "font-weight",
    "font-stretch",
    "font-size",
    "font-size-adjust",
    "line-height",
    "font-family",
    "text-align",
    "text-transform",
    "text-indent",
    "text-decoration",
    "letter-spacing",
    "word-spacing",
    "tab-size",
    "-moz-tab-size",
    "overflow-wrap",
    "word-break",
  ] as const;

  properties.forEach((property) => {
    div.style.setProperty(property, style.getPropertyValue(property));
  });

  div.style.position = "absolute";
  div.style.top = "0";
  div.style.left = "0";
  div.style.display = "block";
  div.style.margin = "0";
  div.style.pointerEvents = "none";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.overflowWrap = "break-word";
  div.style.wordWrap = "break-word";

  div.textContent = textarea.value.substring(0, safePosition);

  const span = document.createElement("span");
  span.textContent = textarea.value.substring(safePosition) || ".";
  div.appendChild(span);

  document.body.appendChild(div);

  const top = rect.top + span.offsetTop - textarea.scrollTop;
  const coordinates = {
    top,
    bottom: top + lineHeight,
    left: rect.left + span.offsetLeft - textarea.scrollLeft,
    lineHeight,
  };

  document.body.removeChild(div);

  return coordinates;
}
