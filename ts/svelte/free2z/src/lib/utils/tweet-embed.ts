const TWEET_ID_PATH = /\/status\/(\d{1,20})(?:\/|$)/;

/**
 * Build X's self-contained tweet iframe URL from a validated tweet link.
 *
 * The iframe keeps X's rendering code on X's origin, so the parent page does
 * not need to allow `platform.twitter.com` in `script-src`.
 */
export function getTweetEmbedUrl(
  originalUrl: string,
  theme: "dark" | "light" = "light",
): string | null {
  try {
    const url = new URL(originalUrl);
    const hostname = url.hostname.toLowerCase();
    const isTwitterHost =
      hostname === "twitter.com" ||
      hostname.endsWith(".twitter.com") ||
      hostname === "x.com" ||
      hostname.endsWith(".x.com");

    if (!isTwitterHost) return null;

    const tweetId = TWEET_ID_PATH.exec(url.pathname)?.[1];
    if (!tweetId) return null;
    const darkTheme = theme === "dark" ? "&theme=dark" : "";
    return `https://platform.twitter.com/embed/Tweet.html?id=${tweetId}&dnt=true${darkTheme}`;
  } catch {
    return null;
  }
}
