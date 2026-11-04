export type MentionContext = {
  start: number;
  query: string;
};

export const MENTION_QUERY_MAX_LENGTH = 30;
export const MENTION_PREVIEW_MAX_CHARS = 20_000;

const USERNAME_PATTERN = `[\\w.@+-]{1,150}`;
const PUBLISH_MENTION_RE = new RegExp(
  `(?<![\\w@\\\\])@(?<handle>${USERNAME_PATTERN})(?![\\w.@+-])`,
  "gu",
);
const AUTOCOMPLETE_MENTION_RE = new RegExp(
  `\\[@(?<handle>${USERNAME_PATTERN})\\]\\((?<url>[^\\s)]+)\\)`,
  "gu",
);
const MARKDOWN_LINK_RE = /\[[^\]]*\]\([^)]*\)/gsu;
const REFERENCE_LINK_RE = /\[[^\]]*\]\[[^\]]*\]/gsu;
const LINK_DEFINITION_RE = /^ {0,3}\[[^\]]+\]:[^\n]*(?:\n|$)/gmu;
const HTML_CODE_RE = /<(?:pre|code)\b[^>]*>.*?<\/(?:pre|code)>/gsu;
const HTML_BLOCKQUOTE_RE = /<blockquote\b[^>]*>.*?<\/blockquote>/gisu;
const AUTOLINK_RE = /<[^>\n]+>/gu;
const RAW_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<]+/giu;

function blank(match: string): string {
  return [...match].map((char) => (char === "\n" ? "\n" : " ")).join("");
}

function visibleMentionText(content: string): string {
  return content
    .slice(0, MENTION_PREVIEW_MAX_CHARS)
    .replace(/^ {0,3}>[^\n]*(?:\n|$)/gmu, blank)
    .replace(
      /^ {0,3}(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}(?:`{3,}|~{3,})[ \t]*$|$)/gmu,
      blank,
    )
    .replace(HTML_BLOCKQUOTE_RE, blank)
    .replace(HTML_CODE_RE, blank)
    .replace(/^ {4,}[^\n]*(?:\n|$)/gmu, blank)
    .replace(/`+[^`\n]*`+/gu, blank)
    .replace(REFERENCE_LINK_RE, blank)
    .replace(LINK_DEFINITION_RE, blank);
}

function isAutocompleteLink(url: string, handle: string): boolean {
  if (!url.startsWith("/") || url.startsWith("//") || /[?#]/u.test(url)) {
    return false;
  }
  return (
    url.replace(/\/+$/u, "").toLocaleLowerCase() ===
    `/${handle}`.toLocaleLowerCase()
  );
}

/** A conservative preview count; publication still resolves everything server-side. */
export function countMentionCandidates(content: string): number {
  const visible = visibleMentionText(content);
  const candidates: Array<{ position: number; handle: string }> = [];
  for (const match of visible.matchAll(AUTOCOMPLETE_MENTION_RE)) {
    const { handle, url } = match.groups ?? {};
    if (handle && url && isAutocompleteLink(url, handle)) {
      candidates.push({ position: match.index ?? 0, handle });
    }
  }
  const withoutLinks = visible
    .replace(MARKDOWN_LINK_RE, blank)
    .replace(AUTOLINK_RE, blank)
    .replace(RAW_URL_RE, blank);
  for (const match of withoutLinks.matchAll(PUBLISH_MENTION_RE)) {
    const handle = match.groups?.handle;
    if (handle) candidates.push({ position: match.index ?? 0, handle });
  }

  const seen = new Set<string>();
  for (const { handle } of candidates.sort((a, b) => a.position - b.position)) {
    seen.add(handle.toLocaleLowerCase());
  }
  return seen.size;
}

export function getMentionContext(
  content: string,
  cursorPosition: number,
): MentionContext | null {
  const lineStart = content.lastIndexOf("\n", cursorPosition - 1) + 1;
  const line = content.slice(lineStart, cursorPosition);
  const atIndex = line.lastIndexOf("@");

  if (atIndex === -1) {
    return null;
  }

  if (atIndex > 0 && !/\s/.test(line[atIndex - 1])) {
    return null;
  }

  const query = line.slice(atIndex + 1);

  if (query.length > MENTION_QUERY_MAX_LENGTH || !/^[\w.+-]*$/.test(query)) {
    return null;
  }

  return { start: lineStart + atIndex, query };
}
