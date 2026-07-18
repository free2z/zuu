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
