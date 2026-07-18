/**
 * Bio frontmatter parsing.
 *
 * Creator bios (`creator.description`) may begin with a small YAML-ish
 * frontmatter block that declares social links, e.g.
 *
 *   ---
 *   socials:
 *     twitter: _skyl
 *     github: someuser
 *   ---
 *
 *   ...markdown body...
 *
 * The classic React UI parsed this with remark-frontmatter + js-yaml and
 * rendered a social row (see ts/react/free2z/src/components/DisplayCreator.tsx).
 * The new UI's markdown pipeline (marked) has no frontmatter support, so the
 * block was leaking into the rendered body as literal text (issue #566).
 *
 * This module is a dependency-free, pure helper: it strips the leading
 * frontmatter block off the body and returns the recognized social links in a
 * stable order. A bio with no frontmatter is returned unchanged.
 */

/**
 * @typedef {Object} SocialLink
 * @property {string} key     Canonical platform key (twitter, github, ...).
 * @property {string} label   Human-readable platform name (X, GitHub, ...).
 * @property {string} value   Raw handle/url as written in the frontmatter.
 * @property {string} url     Resolved, safe https href.
 * @property {string} display Short text to show next to the icon.
 */

/**
 * @typedef {Object} ParsedBio
 * @property {string} body           Markdown body with frontmatter removed.
 * @property {SocialLink[]} socials  Recognized social links, ordered.
 */

/**
 * Aliases that normalize to a canonical platform key.
 * @type {Record<string, string>}
 */
const ALIASES = {
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

/** @param {string} v */
function isUrl(v) {
  return /^https?:\/\//i.test(v);
}

/** @param {string} v */
function stripHandle(v) {
  return v
    .replace(/^@/, "")
    .replace(/^https?:\/\/[^/]+\//i, "")
    .replace(/\/+$/, "");
}

/**
 * Build an https href for a plain-handle platform.
 * @param {string} v
 * @param {string} prefix
 */
function handleUrl(v, prefix) {
  return isUrl(v) ? v : prefix + stripHandle(v);
}

/** @param {string} v */
function websiteUrl(v) {
  if (isUrl(v)) return v;
  return "https://" + v.replace(/^\/+/, "");
}

/** @param {string} v */
function nostrUrl(v) {
  if (isUrl(v)) return v;
  return "https://njump.me/" + v.replace(/^nostr:/i, "").replace(/^@/, "");
}

/** @param {string} v */
function mastodonUrl(v) {
  if (isUrl(v)) return v;
  // user@instance or @user@instance -> https://instance/@user
  const m = v.match(/^@?([^@\s]+)@([^@\s/]+)$/);
  if (m) return `https://${m[2]}/@${m[1]}`;
  return "https://" + v.replace(/^@/, "");
}

/** @param {string} v */
function redditUrl(v) {
  if (isUrl(v)) return v;
  return "https://reddit.com/u/" + v.replace(/^\/?(u\/|user\/|@)/i, "");
}

/** @param {string} v */
function linkedinUrl(v) {
  if (isUrl(v)) return v;
  return "https://linkedin.com/in/" + stripHandle(v);
}

/** @param {string} v */
function youtubeUrl(v) {
  if (isUrl(v)) return v;
  const h = v.replace(/^@/, "");
  return "https://youtube.com/@" + h;
}

/** @param {string} v */
function truncateMiddle(v) {
  if (v.length <= 16) return v;
  return v.slice(0, 8) + "…" + v.slice(-6);
}

/**
 * Canonical platform config. Order here is the render order.
 * @type {Record<string, { label: string; url: (v: string) => string; display: (v: string) => string }>}
 */
const SOCIAL_CONFIG = {
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
    display: (v) =>
      truncateMiddle(v.replace(/^nostr:/i, "").replace(/^@/, "")),
  },
  website: {
    label: "Website",
    url: websiteUrl,
    display: (v) => v.replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
  },
};

const RENDER_ORDER = Object.keys(SOCIAL_CONFIG);

/** @param {string} key */
function canonicalKey(key) {
  const lower = key.toLowerCase();
  return ALIASES[lower] || lower;
}

/** @param {string} v */
function stripQuotes(v) {
  const t = v.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Split a leading frontmatter block off the raw description.
 * Supports both fenced (`---` ... `---`) and a bare leading `socials:` block.
 * @param {string} raw
 * @returns {{ frontmatter: string | null; body: string }}
 */
function splitFrontmatter(raw) {
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

/**
 * Parse an inline flow map like `{ twitter: a, github: b }`.
 * @param {string} value
 * @param {Record<string, string>} out
 */
function parseInlineMap(value, out) {
  const inner = value.replace(/^\{/, "").replace(/\}$/, "");
  for (const pair of inner.split(",")) {
    const m = pair.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (m) {
      const val = stripQuotes(m[2]);
      if (val) out[m[1].toLowerCase()] = val;
    }
  }
}

/**
 * Extract a flat `{ key: value }` map of socials from a frontmatter block.
 * @param {string} text
 * @returns {Record<string, string>}
 */
function extractSocialsMap(text) {
  const lines = text.split(/\r?\n/);
  /** @type {Record<string, string>} */
  const found = {};
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

/**
 * Turn a raw socials map into ordered, resolved SocialLink objects.
 * @param {Record<string, string>} map
 * @returns {SocialLink[]}
 */
function buildSocialLinks(map) {
  /** @type {SocialLink[]} */
  const links = [];
  const seen = new Set();

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
 *
 * @param {string | null | undefined} description
 * @returns {ParsedBio}
 */
export function parseBioFrontmatter(description) {
  const raw = typeof description === "string" ? description : "";
  if (!raw.trim()) return { body: raw, socials: [] };

  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === null) return { body: raw, socials: [] };

  const socials = buildSocialLinks(extractSocialsMap(frontmatter));
  return { body, socials };
}
