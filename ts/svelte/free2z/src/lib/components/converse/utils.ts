import type { ConversePostData } from "./types";

const PLACEHOLDER_HEADLINES = new Set(["n/a", "re"]);
const sourceTitleRequests = new Map<string, Promise<string | null>>();

export function getVisibleHeadline(post: ConversePostData): string {
  const headline = post.headline?.trim() || "";
  return PLACEHOLDER_HEADLINES.has(headline.toLowerCase()) ? "" : headline;
}

export function getSourceUrl(post: ConversePostData): string | null {
  if (!post.content_url) return null;
  const normalized = post.content_url.replace(
    /^\/([^/?#]+)\/zpage\/([^/?#]+)(?=\/?(?:[?#]|$))/,
    "/$1/$2",
  );
  return `${normalized.replace(/#.*$/, "")}#comment-${post.uuid}`;
}

export function getSourceIdentifier(post: ConversePostData): string | null {
  if (!post.content_url) return null;

  try {
    const pathname = new URL(post.content_url, "https://free2z.local").pathname;
    const segments = pathname.split("/").filter(Boolean);
    const zpageIndex = segments.indexOf("zpage");
    const identifier = zpageIndex >= 0 ? segments[zpageIndex + 1] : null;
    return identifier ? decodeURIComponent(identifier) : null;
  } catch {
    return null;
  }
}

export function resolveSourceTitle(
  identifier: string,
  apiBase: string,
): Promise<string | null> {
  const key = `${apiBase}:${identifier}`;
  const cached = sourceTitleRequests.get(key);
  if (cached) return cached;

  const request = fetch(
    `${apiBase}/api/zpage/${encodeURIComponent(identifier)}/`,
  )
    .then(async (response) => {
      if (!response.ok) return null;
      const zpage: { title?: string } = await response.json();
      return zpage.title?.trim() || null;
    })
    .catch(() => null);

  sourceTitleRequests.set(key, request);
  return request;
}

export function getAvatarUrl(
  post: ConversePostData,
  apiBase: string,
): string | undefined {
  const avatar =
    post.author.avatar_image?.thumbnail || post.author.avatar_image?.url;
  if (!avatar) return undefined;
  if (avatar.startsWith("http")) return avatar;
  return `${apiBase}${avatar.startsWith("/") ? "" : "/"}${avatar}`;
}

export function formatPostDate(value: string, locale: string): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleDateString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

export function formatRelativePostDate(value: string, locale: string): string {
  if (!value) return "";
  try {
    const date = new Date(value);
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (Math.abs(minutes) < 1) return "just now";

    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    if (Math.abs(minutes) < 60) return formatter.format(-minutes, "minute");

    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return formatter.format(-hours, "hour");

    const days = Math.round(hours / 24);
    if (Math.abs(days) < 7) return formatter.format(-days, "day");
    return formatPostDate(value, locale);
  } catch {
    return formatPostDate(value, locale);
  }
}
