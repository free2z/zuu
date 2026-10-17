/**
 * Comprehensive list of external embed domains
 * Single source of truth for the entire application
 */
export const EXTERNAL_EMBED_DOMAINS = [
  // Video platforms
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'dailymotion.com',
  'twitch.tv',
  'tiktok.com',
  'rumble.com',
  'odysee.com',
  'd.tube',
  'bitchute.com',
  'brightcove.com',
  'jwplayer.com',
  'wistia.com',
  'streamable.com',
  'kick.com',

  // International video platforms
  'bilibili.com',
  'iqiyi.com',
  'youku.com',
  'douyin.com',
  'ixigua.com',
  'nicovideo.jp',
  'fc2.com',
  'rutube.ru',
  'ok.ru',
  'vk.com',

  // Social media
  'twitter.com',
  'x.com',
  'instagram.com',
  'facebook.com',
  'fb.watch',
  'reddit.com',
  'linkedin.com',
  'snapchat.com',
  'threads.net',
  'discord.com',

  // Audio/Music platforms
  'soundcloud.com',
  'spotify.com',
  'open.spotify.com',
  'music.apple.com',
  'podcasts.apple.com',
  'apple.com',
  'bandcamp.com',
  'mixcloud.com',
  'deezer.com',
  'tidal.com',
  'iheartradio.com',

  // Podcast platforms
  'anchor.fm',
  'buzzsprout.com',
  'podbean.com',
  'simplecast.com',

  // Productivity/Collaboration
  'docs.google.com',
  'drive.google.com',
  'dropbox.com',
  'notion.site',
  'figma.com',
  'canva.com',
  'prezi.com',
  'slideshare.net',
  'scribd.com',
  'loom.com',
  'zoom.us',
  'daily.co',

  // Developer platforms
  'github.com',
  'gist.github.com',
  'codepen.io',
  'jsfiddle.net',
  'codesandbox.io',
  'replit.com',

  // Media/Images
  'giphy.com',
  'imgur.com',
  'pinterest.com',
  'coub.com',

  // Embed services
  'iframe.ly',
  'cdn.iframe.ly'
] as const;

/**
 * Free2Z's own domains, current and legacy. Pages on them are not third-party
 * content, so embedding one needs no external-content consent.
 */
export const FIRST_PARTY_DOMAINS = ['free2z.cash', 'free2z.com'] as const;

/**
 * Check if a URL points at a Free2Z page.
 *
 * Matches the parsed hostname, never the raw string, so a lookalike such as
 * `free2z.cash.example.com` or `https://free2z.cash@evil.example` is not
 * trusted. Only `https:` qualifies: over plain `http:` anyone on the network
 * path could substitute the page, and that is exactly what the consent prompt
 * exists to put in front of the reader.
 */
export function isFirstPartyUrl(url: string): boolean {
  if (!url) return false;

  try {
    const urlObj = new URL(url);
    if (urlObj.protocol !== 'https:') return false;
    const hostname = urlObj.hostname.toLowerCase();

    return FIRST_PARTY_DOMAINS.some(domain =>
      hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

/**
 * Check if a URL is from an external embed domain
 * @param url - The URL to check
 * @returns true if the URL is from an external embed domain, false otherwise
 */
export function isExternalEmbedDomain(url: string): boolean {
  if (!url) return false;

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    return EXTERNAL_EMBED_DOMAINS.some(domain =>
      hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}
