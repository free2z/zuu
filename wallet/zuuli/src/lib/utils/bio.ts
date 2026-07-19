// Bio frontmatter parsing.
//
// Creator bios (`CreatorDetail.bio` / `AuthUser.bio`, backed by the server's
// `description` field) may begin with a small YAML-ish frontmatter block that
// declares social links, e.g.
//
//   ---
//   socials:
//     twitter: _skyl
//     github: someuser
//   ---
//
//   ...markdown body...
//
// This is a straight TypeScript port of the svelte web client's parser
// (`ts/svelte/free2z/src/lib/utils/bio.js`, added for issue #566) so both
// clients render the same social row from the same bio text. It is a
// dependency-free, pure helper: it strips the leading frontmatter block off
// the body and returns the recognized social links in a stable order. A bio
// with no frontmatter is returned unchanged.

/** Canonical platform key (twitter, github, ...). */
export type SocialKey =
  | "twitter"
  | "github"
  | "instagram"
  | "youtube"
  | "facebook"
  | "linkedin"
  | "reddit"
  | "telegram"
  | "mastodon"
  | "nostr"
  | "website";

export interface SocialLink {
  /** Canonical platform key (twitter, github, ...). */
  key: SocialKey;
  /** Human-readable platform name (X, GitHub, ...). */
  label: string;
  /** Raw handle/url as written in the frontmatter. */
  value: string;
  /** Resolved, safe https href. */
  url: string;
  /** Short text to show next to the icon. */
  display: string;
}

export interface ParsedBio {
  /** Markdown body with frontmatter removed. */
  body: string;
  /** Recognized social links, ordered. */
  socials: SocialLink[];
}

/** Aliases that normalize to a canonical platform key. */
const ALIASES: Record<string, SocialKey> = {
  x: "twitter",
  url: "website",
  web: "website",
  site: "website",
  homepage: "website",
  gh: "github",
  ig: "instagram",
  yt: "youtube",
  fb: "facebook",
  tg: "telegram",
  telegramme: "telegram",
};

function isUrl(v: string): boolean {
  return /^https?:\/\//i.test(v);
}

function stripHandle(v: string): string {
  return v
    .replace(/^@/, "")
    .replace(/^https?:\/\/[^/]+\//i, "")
    .replace(/\/+$/, "");
}

/** Build an https href for a plain-handle platform. */
function handleUrl(v: string, prefix: string): string {
  return isUrl(v) ? v : prefix + stripHandle(v);
}

function websiteUrl(v: string): string {
  if (isUrl(v)) return v;
  return "https://" + v.replace(/^\/+/, "");
}

function nostrUrl(v: string): string {
  if (isUrl(v)) return v;
  return "https://njump.me/" + v.replace(/^nostr:/i, "").replace(/^@/, "");
}

function mastodonUrl(v: string): string {
  if (isUrl(v)) return v;
  // user@instance or @user@instance -> https://instance/@user
  const m = v.match(/^@?([^@\s]+)@([^@\s/]+)$/);
  if (m) return `https://${m[2]}/@${m[1]}`;
  return "https://" + v.replace(/^@/, "");
}

function redditUrl(v: string): string {
  if (isUrl(v)) return v;
  return "https://reddit.com/u/" + v.replace(/^\/?(u\/|user\/|@)/i, "");
}

function linkedinUrl(v: string): string {
  if (isUrl(v)) return v;
  return "https://linkedin.com/in/" + stripHandle(v);
}

function youtubeUrl(v: string): string {
  if (isUrl(v)) return v;
  const h = v.replace(/^@/, "");
  return "https://youtube.com/@" + h;
}

function truncateMiddle(v: string): string {
  if (v.length <= 16) return v;
  return v.slice(0, 8) + "…" + v.slice(-6);
}

interface SocialConfig {
  label: string;
  url: (v: string) => string;
  display: (v: string) => string;
}

/** Canonical platform config. Order here is the render order. */
const SOCIAL_CONFIG: Record<SocialKey, SocialConfig> = {
  twitter: {
    label: "X",
    url: (v) => handleUrl(v, "https://x.com/"),
    display: (v) => (isUrl(v) ? stripHandle(v) : "@" + stripHandle(v)),
  },
  github: {
    label: "GitHub",
    url: (v) => handleUrl(v, "https://github.com/"),
    display: (v) => stripHandle(v),
  },
  instagram: {
    label: "Instagram",
    url: (v) => handleUrl(v, "https://instagram.com/"),
    display: (v) => (isUrl(v) ? stripHandle(v) : "@" + stripHandle(v)),
  },
  youtube: {
    label: "YouTube",
    url: youtubeUrl,
    display: (v) => (isUrl(v) ? stripHandle(v) : "@" + v.replace(/^@/, "")),
  },
  facebook: {
    label: "Facebook",
    url: (v) => handleUrl(v, "https://facebook.com/"),
    display: (v) => stripHandle(v),
  },
  linkedin: {
    label: "LinkedIn",
    url: linkedinUrl,
    display: (v) => stripHandle(v),
  },
  reddit: {
    label: "Reddit",
    url: redditUrl,
    display: (v) => "u/" + v.replace(/^\/?(u\/|user\/|@)/i, ""),
  },
  telegram: {
    label: "Telegram",
    url: (v) => handleUrl(v, "https://t.me/"),
    display: (v) => (isUrl(v) ? stripHandle(v) : "@" + stripHandle(v)),
  },
  mastodon: {
    label: "Mastodon",
    url: mastodonUrl,
    display: (v) => (isUrl(v) ? v.replace(/^https?:\/\//i, "") : v),
  },
  nostr: {
    label: "Nostr",
    url: nostrUrl,
    display: (v) => truncateMiddle(v.replace(/^nostr:/i, "").replace(/^@/, "")),
  },
  website: {
    label: "Website",
    url: websiteUrl,
    display: (v) => v.replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
  },
};

const RENDER_ORDER = Object.keys(SOCIAL_CONFIG) as SocialKey[];

function canonicalKey(key: string): SocialKey {
  const lower = key.toLowerCase();
  return ALIASES[lower] ?? (lower as SocialKey);
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** Split a leading frontmatter block off the raw description. Supports both
 * fenced (`---` ... `---`) and a bare leading `socials:` block. */
function splitFrontmatter(raw: string): {
  frontmatter: string | null;
  body: string;
} {
  const text = raw.replace(/^\uFEFF/, "");

  // Fenced frontmatter must be the very first thing in the string.
  const fence = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (fence) {
    return {
      frontmatter: fence[1],
      body: text.slice(fence[0].length).replace(/^\s*\r?\n/, ""),
    };
  }

  // Bare leading `socials:` block: the `socials:` line plus the indented
  // lines beneath it, terminated by a blank line or a dedented line.
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && /^socials\s*:/i.test(lines[i])) {
    const start = i;
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") break;
      if (/^\s+\S/.test(line)) {
        i++;
        continue;
      }
      break;
    }
    const frontmatter = lines.slice(start, i).join("\n");
    // drop a single trailing blank separator line
    if (i < lines.length && lines[i].trim() === "") i++;
    return { frontmatter, body: lines.slice(i).join("\n") };
  }

  return { frontmatter: null, body: raw };
}

/** Parse an inline flow map like `{ twitter: a, github: b }`. */
function parseInlineMap(value: string, out: Record<string, string>): void {
  const inner = value.replace(/^\{/, "").replace(/\}$/, "");
  for (const pair of inner.split(",")) {
    const m = pair.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (m) {
      const val = stripQuotes(m[2]);
      if (val) out[m[1].toLowerCase()] = val;
    }
  }
}

/** Extract a flat `{ key: value }` map of socials from a frontmatter block. */
function extractSocialsMap(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  const found: Record<string, string> = {};
  let inSocials = false;
  let socialsIndent = -1;

  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = (line.match(/^(\s*)/)?.[1] ?? "").length;
    const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!kv) continue;

    const key = kv[1].toLowerCase();
    const value = stripQuotes(kv[2]);

    if (inSocials) {
      if (indent > socialsIndent) {
        if (value) found[key] = value;
        continue;
      }
      inSocials = false; // dedented: reconsider this line at top level
    }

    if (key === "socials") {
      if (value) {
        parseInlineMap(value, found);
      } else {
        inSocials = true;
        socialsIndent = indent;
      }
      continue;
    }

    // Also accept top-level social keys written without nesting.
    if (value && SOCIAL_CONFIG[canonicalKey(key)]) {
      found[key] = value;
    }
  }

  return found;
}

/** Turn a raw socials map into ordered, resolved SocialLink objects. */
function buildSocialLinks(map: Record<string, string>): SocialLink[] {
  const links: SocialLink[] = [];
  const seen = new Set<SocialKey>();

  for (const rawKey of Object.keys(map)) {
    const key = canonicalKey(rawKey);
    const config = SOCIAL_CONFIG[key];
    const value = (map[rawKey] || "").trim();
    if (!config || !value || seen.has(key)) continue;
    seen.add(key);
    links.push({
      key,
      label: config.label,
      value,
      url: config.url(value),
      display: config.display(value),
    });
  }

  links.sort((a, b) => RENDER_ORDER.indexOf(a.key) - RENDER_ORDER.indexOf(b.key));
  return links;
}

/**
 * Parse a creator bio: strip any leading frontmatter block from the body and
 * return the recognized social links. Defensive: input without frontmatter is
 * returned unchanged with an empty socials list.
 */
export function parseBioFrontmatter(
  description: string | null | undefined,
): ParsedBio {
  const raw = typeof description === "string" ? description : "";
  if (!raw.trim()) return { body: raw, socials: [] };

  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === null) return { body: raw, socials: [] };

  const socials = buildSocialLinks(extractSocialsMap(frontmatter));
  return { body, socials };
}
