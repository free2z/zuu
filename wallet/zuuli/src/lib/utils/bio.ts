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
// This originated as a TypeScript port of the svelte web client's parser
// (`ts/svelte/free2z/src/lib/utils/bio.js`, added for issue #566). ZUULI also
// enforces its branded-host trust boundary here before returning any link to
// the renderer. It is a dependency-free, pure helper: it strips the leading
// frontmatter block off the body and returns recognized, safe social links in
// a stable order. A bio with no frontmatter is returned unchanged.

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
  /** Whether the destination is entitled to trusted platform branding. */
  trust: "branded" | "generic";
  /** Browser-canonical host, including a non-default port for generic links. */
  destinationHost: string;
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

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const ABSOLUTE_HTTPS = /^https:\/\//i;

type BrandedKey = Exclude<SocialKey, "mastodon" | "website">;

interface BrandedHostPolicy {
  canonicalHost: string;
  allowedHosts: readonly string[];
  handlePath: (handle: string) => string;
  /** Only profile namespaces whose prefix is unambiguous may be recovered
   * from an absolute stored URL. Root-path platforms accept handles only. */
  absoluteProfile: boolean;
  /** Root service routes that satisfy the platform's handle alphabet but are
   * not identities. Relevant only where handles occupy the host root. */
  reservedHandles: readonly string[];
}

/** Exact reviewed hosts. Entries such as `www` and legacy Twitter/Telegram
 * hosts are aliases, not wildcard subdomain grants. */
const BRANDED_HOSTS: Record<BrandedKey, BrandedHostPolicy> = {
  twitter: {
    canonicalHost: "x.com",
    allowedHosts: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
    handlePath: (handle) => `/${handle}`,
    absoluteProfile: false,
    reservedHandles: [
      "about",
      "account",
      "business",
      "compose",
      "download",
      "explore",
      "home",
      "i",
      "intent",
      "jobs",
      "login",
      "logout",
      "messages",
      "notifications",
      "privacy",
      "search",
      "settings",
      "share",
      "signup",
      "tos",
    ],
  },
  github: {
    canonicalHost: "github.com",
    allowedHosts: ["github.com", "www.github.com"],
    handlePath: (handle) => `/${handle}`,
    absoluteProfile: false,
    reservedHandles: [
      "about",
      "account",
      "apps",
      "collections",
      "contact",
      "enterprise",
      "events",
      "explore",
      "features",
      "issues",
      "join",
      "login",
      "logout",
      "marketplace",
      "new",
      "notifications",
      "orgs",
      "organizations",
      "pricing",
      "pulls",
      "readme",
      "redirect",
      "search",
      "security",
      "sessions",
      "settings",
      "site",
      "sponsors",
      "topics",
      "users",
    ],
  },
  instagram: {
    canonicalHost: "instagram.com",
    allowedHosts: ["instagram.com", "www.instagram.com"],
    handlePath: (handle) => `/${handle}`,
    absoluteProfile: false,
    reservedHandles: [
      "about",
      "accounts",
      "challenge",
      "developer",
      "direct",
      "emails",
      "explore",
      "legal",
      "oauth",
      "p",
      "privacy",
      "reels",
      "stories",
      "web",
    ],
  },
  youtube: {
    canonicalHost: "youtube.com",
    allowedHosts: ["youtube.com", "www.youtube.com"],
    handlePath: (handle) => `/@${handle}`,
    absoluteProfile: true,
    reservedHandles: [],
  },
  facebook: {
    canonicalHost: "facebook.com",
    allowedHosts: ["facebook.com", "www.facebook.com"],
    handlePath: (handle) => `/${handle}`,
    absoluteProfile: false,
    reservedHandles: [
      "about",
      "ads",
      "business",
      "dialog",
      "events",
      "gaming",
      "groups",
      "help",
      "l.php",
      "legal",
      "login",
      "marketplace",
      "pages",
      "policies",
      "plugins",
      "privacy",
      "profile.php",
      "reels",
      "share",
      "sharer",
      "stories",
      "watch",
    ],
  },
  linkedin: {
    canonicalHost: "linkedin.com",
    allowedHosts: ["linkedin.com", "www.linkedin.com"],
    handlePath: (handle) => `/in/${handle}`,
    absoluteProfile: true,
    reservedHandles: [],
  },
  reddit: {
    canonicalHost: "reddit.com",
    allowedHosts: ["reddit.com", "www.reddit.com", "old.reddit.com"],
    handlePath: (handle) => `/u/${handle}`,
    absoluteProfile: true,
    reservedHandles: [],
  },
  telegram: {
    canonicalHost: "t.me",
    allowedHosts: ["t.me", "telegram.me", "www.telegram.me"],
    handlePath: (handle) => `/${handle}`,
    absoluteProfile: false,
    reservedHandles: [
      "addemoji",
      "addlist",
      "addstickers",
      "auth",
      "bg",
      "confirmphone",
      "iv",
      "joinchat",
      "login",
      "proxy",
      "setlanguage",
      "share",
      "socks",
    ],
  },
  nostr: {
    canonicalHost: "njump.me",
    allowedHosts: ["njump.me", "www.njump.me"],
    handlePath: (handle) => `/${handle}`,
    absoluteProfile: false,
    reservedHandles: [
      "about",
      "docs",
      "embed",
      "faq",
      "help",
      "login",
      "privacy",
      "redirect",
      "search",
      "settings",
    ],
  },
};

function validPlatformHandle(key: BrandedKey, handle: string): boolean {
  if (BRANDED_HOSTS[key].reservedHandles.includes(handle.toLowerCase())) {
    return false;
  }
  switch (key) {
    case "twitter":
      return /^[A-Za-z0-9_]{1,15}$/.test(handle);
    case "github":
      return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(handle);
    case "instagram":
      return /^[A-Za-z0-9_](?:[A-Za-z0-9._]{0,28}[A-Za-z0-9_])?$/.test(handle);
    case "youtube":
      return /^[A-Za-z0-9_.-]{3,30}$/.test(handle);
    case "facebook":
      return /^[A-Za-z0-9.]{1,50}$/.test(handle);
    case "linkedin":
      return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(handle);
    case "reddit":
      return /^[A-Za-z0-9_-]{3,20}$/.test(handle);
    case "telegram":
      return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(handle);
    case "nostr":
      return /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(handle);
  }
}

function plainHandle(key: BrandedKey, value: string): string | null {
  let handle = value.trim();
  if (key === "nostr") handle = handle.replace(/^nostr:/i, "");
  if (key === "reddit") handle = handle.replace(/^\/?(?:u|user)\//i, "");
  if (key === "linkedin") handle = handle.replace(/^\/?in\//i, "");
  handle = handle.replace(/^@/, "");

  // Handles are path data, never another URL or a query/fragment. Keeping the
  // accepted alphabet deliberately small also prevents invisible lookalikes.
  return validPlatformHandle(key, handle) ? handle : null;
}

/** Extract only the reviewed profile shape for a branded platform. Absolute
 * input is never returned directly: the identifier is validated and rebuilt
 * through the canonical handle path below. */
function profileHandle(key: BrandedKey, url: URL): string | null {
  if (url.search || url.hash || url.pathname.includes("%")) return null;

  let match: RegExpExecArray | null;
  switch (key) {
    case "youtube":
      match = /^\/@([^/]+)\/?$/.exec(url.pathname);
      break;
    case "linkedin":
      match = /^\/in\/([^/]+)\/?$/i.exec(url.pathname);
      break;
    case "reddit":
      match = /^\/(?:u|user)\/([^/]+)\/?$/i.exec(url.pathname);
      break;
    default:
      match = /^\/([^/]+)\/?$/.exec(url.pathname);
      break;
  }
  return match ? plainHandle(key, match[1]) : null;
}

function brandedUrl(key: BrandedKey, rawValue: string): URL | null {
  const value = rawValue.trim();
  const policy = BRANDED_HOSTS[key];

  if (!ABSOLUTE_HTTPS.test(value)) {
    if (value.startsWith("//") || (URL_SCHEME.test(value) && key !== "nostr")) {
      return null;
    }
    const handle = plainHandle(key, value);
    return handle
      ? new URL(
          `https://${policy.canonicalHost}${policy.handlePath(
            encodeURIComponent(handle),
          )}`,
        )
      : null;
  }

  const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
  // URL parsers may decode percent escapes in a hostname before comparison.
  // Reject encoded, Unicode, backslash, whitespace and userinfo authorities
  // before parsing so an accepted brand host was written unambiguously.
  if (
    !authority ||
    /[%\\@]/.test(authority) ||
    [...authority].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint > 0x7e;
    })
  ) {
    return null;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !policy.allowedHosts.includes(url.hostname)
    ) {
      return null;
    }
    if (!policy.absoluteProfile) return null;
    const handle = profileHandle(key, url);
    return handle
      ? new URL(
          `https://${policy.canonicalHost}${policy.handlePath(
            encodeURIComponent(handle),
          )}`,
        )
      : null;
  } catch {
    return null;
  }
}

function genericHttpsUrl(rawValue: string): URL | null {
  const value = rawValue.trim();
  if (!value || value.startsWith("//")) return null;
  const hostWithPort = /^[A-Za-z0-9.-]+:\d+(?:[/#?]|$)/.test(value);
  if (URL_SCHEME.test(value) && !ABSOLUTE_HTTPS.test(value) && !hostWithPort) {
    return null;
  }
  const candidate = ABSOLUTE_HTTPS.test(value) ? value : `https://${value}`;

  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function mastodonUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (URL_SCHEME.test(trimmed) || trimmed.startsWith("//")) {
    return genericHttpsUrl(trimmed);
  }
  const federatedHandle = trimmed.match(/^@?([^@\s/]+)@([^@\s/]+)$/);
  if (federatedHandle) {
    return genericHttpsUrl(
      `${federatedHandle[2]}/@${encodeURIComponent(federatedHandle[1])}`,
    );
  }
  return genericHttpsUrl(trimmed.replace(/^@/, ""));
}

function truncateMiddle(v: string): string {
  if (v.length <= 16) return v;
  return v.slice(0, 8) + "…" + v.slice(-6);
}

interface SocialConfig {
  label: string;
  trust: "branded" | "generic";
  url: (v: string) => URL | null;
  display: (url: URL) => string;
}

function pathDisplay(url: URL): string {
  return url.pathname.replace(/^\/+|\/+$/g, "") || url.hostname;
}

function handleDisplay(url: URL): string {
  return "@" + pathDisplay(url).replace(/^@/, "");
}

/** Canonical platform config. Order here is the render order. */
const SOCIAL_CONFIG: Record<SocialKey, SocialConfig> = {
  twitter: {
    label: "X",
    trust: "branded",
    url: (v) => brandedUrl("twitter", v),
    display: handleDisplay,
  },
  github: {
    label: "GitHub",
    trust: "branded",
    url: (v) => brandedUrl("github", v),
    display: pathDisplay,
  },
  instagram: {
    label: "Instagram",
    trust: "branded",
    url: (v) => brandedUrl("instagram", v),
    display: handleDisplay,
  },
  youtube: {
    label: "YouTube",
    trust: "branded",
    url: (v) => brandedUrl("youtube", v),
    display: handleDisplay,
  },
  facebook: {
    label: "Facebook",
    trust: "branded",
    url: (v) => brandedUrl("facebook", v),
    display: pathDisplay,
  },
  linkedin: {
    label: "LinkedIn",
    trust: "branded",
    url: (v) => brandedUrl("linkedin", v),
    display: pathDisplay,
  },
  reddit: {
    label: "Reddit",
    trust: "branded",
    url: (v) => brandedUrl("reddit", v),
    display: pathDisplay,
  },
  telegram: {
    label: "Telegram",
    trust: "branded",
    url: (v) => brandedUrl("telegram", v),
    display: handleDisplay,
  },
  mastodon: {
    label: "Mastodon",
    trust: "generic",
    url: mastodonUrl,
    display: (url) => url.host,
  },
  nostr: {
    label: "Nostr",
    trust: "branded",
    url: (v) => brandedUrl("nostr", v),
    display: (url) => truncateMiddle(pathDisplay(url)),
  },
  website: {
    label: "Website",
    trust: "generic",
    url: genericHttpsUrl,
    display: (url) => url.host,
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
    const url = config.url(value);
    // Existing invalid branded values fail closed here: no link object means
    // the renderer has no trusted label or icon it could attach to that value.
    if (!url) continue;
    seen.add(key);
    links.push({
      key,
      label: config.label,
      value,
      url: url.href,
      display: config.display(url),
      trust: config.trust,
      destinationHost: url.host,
    });
  }

  links.sort(
    (a, b) => RENDER_ORDER.indexOf(a.key) - RENDER_ORDER.indexOf(b.key),
  );
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
