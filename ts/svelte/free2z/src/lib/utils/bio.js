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
 *...markdown body...
 *
 * The classic React UI parsed this with remark-frontmatter + js-yaml and
 * rendered a social row (see ts/react/free2z/src/components/DisplayCreator.tsx).
 * The new UI's markdown pipeline (marked) has no frontmatter support, so the
 * block was leaking into the rendered body as literal text (issue ).
 *
 * This module is a dependency-free, pure helper: it strips the leading
 * frontmatter block off the body and returns the recognized social links in a
 * stable order. A bio with no frontmatter is returned unchanged.
 */

/**
 * @typedef {Object} SocialLink
 * @property {string} key     Canonical platform key (twitter, github,...).
 * @property {string} label   Human-readable platform name (X, GitHub,...).
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
    display: (v) => truncateMiddle(v.replace(/^nostr:/i, "").replace(/^@/, "")),
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
 * Supports both fenced (`---`... `---`) and a bare leading `socials:` block.
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

  links.sort(
    (a, b) => RENDER_ORDER.indexOf(a.key) - RENDER_ORDER.indexOf(b.key),
  );
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

/**
 * Per-platform hosts a resolved social URL must land on to count as identity
 * evidence. `sameAs` (issue ) is a machine-readable claim that the
 * subject of the page **is** the thing the link points to — not a link list —
 * so a link only qualifies when it demonstrably points at the platform it
 * claims to be on.
 *
 * The handle-shaped frontmatter path (`twitter: alice`) always resolves onto
 * one of these hosts, because `handleUrl()` built the URL from the platform's
 * own canonical prefix. The raw-URL path (`twitter: https://unrelated.example/
 * famous-person`) is passed through `isUrl()` verbatim and only lands here by
 * coincidence — which is exactly the case this filters out (codex review on
 * ).
 *
 * `mastodon` (federated: any instance is a legitimate host), `nostr` (no
 * https domain to check), and `website` (a personal site is not itself an
 * identity claim) are deliberately excluded — none of them have a single
 * canonical domain to allowlist against.
 * @type {Record<string, Set<string>>}
 */
const SAME_AS_HOSTS = {
  twitter: new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]),
  github: new Set(["github.com", "www.github.com"]),
  instagram: new Set(["instagram.com", "www.instagram.com"]),
  youtube: new Set(["youtube.com", "www.youtube.com"]),
  facebook: new Set(["facebook.com", "www.facebook.com"]),
  linkedin: new Set(["linkedin.com", "www.linkedin.com"]),
  reddit: new Set(["reddit.com", "www.reddit.com"]),
  telegram: new Set(["t.me"]),
};

/**
 * Non-profile top-level paths that share a host with real profiles, so the
 * host check alone would wave them through: `x.com/home`, `x.com/search`,
 * `instagram.com/explore`, etc. Keyed the same as `SAME_AS_HOSTS`.
 *
 * A deny-list is wrong by omission the first time a platform adds a route, so
 * it is deliberately NOT the only defence: every entry here is an extra
 * refusal layered on top of a strict per-platform *shape* allowlist, and the
 * shapes that admit a `.`-bearing segment (facebook) get a categorical rule
 * (`*.php` is never a profile) rather than one more name in the list. A codex
 * round found `x.com/login`, `x.com/signup`, `instagram.com/about`,
 * `facebook.com/profile.php` and `t.me/share` all passing as "profiles"
 *; telegram had no entry at all, and its case never consulted one.
 * @type {Record<string, Set<string>>}
 */
const RESERVED_PATH_SEGMENTS = {
  twitter: new Set([
    "home",
    "search",
    "i",
    "intent",
    "hashtag",
    "share",
    "explore",
    "messages",
    "notifications",
    "settings",
    "compose",
    "login",
    "logout",
    "signup",
    "signin",
    "sign_up",
    "sign_in",
    "account",
    "session",
    "sessions",
    "oauth",
    "flow",
    "welcome",
    "about",
    "tos",
    "privacy",
    "rules",
    "help",
    "download",
    "jobs",
    "careers",
    "status",
    "following",
    "followers",
    "lists",
    "topics",
    "bookmarks",
    "connect",
    "widgets",
  ]),
  instagram: new Set([
    "p",
    "reel",
    "reels",
    "explore",
    "stories",
    "tv",
    "accounts",
    "about",
    "developer",
    "developers",
    "legal",
    "privacy",
    "terms",
    "directory",
    "challenge",
    "session",
    "sessions",
    "oauth",
    "emails",
    "api",
    "graphql",
    "direct",
    "create",
    "your_activity",
    "press",
    "blog",
    "help",
    "ads",
    "business",
    "download",
    "web",
  ]),
  github: new Set([
    "login",
    "logout",
    "join",
    "signup",
    "sign_up",
    "signin",
    "sign_in",
    "session",
    "sessions",
    "settings",
    "notifications",
    "marketplace",
    "sponsors",
    "about",
    "pricing",
    "features",
    "explore",
    "topics",
    "collections",
    "trending",
    "orgs",
    "organizations",
    "users",
    "new",
    "support",
    "security",
    "apps",
    "account",
    "search",
    "stars",
    "watching",
    "dashboard",
    "issues",
    "pulls",
    "discussions",
    "codespaces",
    "enterprise",
    "team",
    "teams",
    "contact",
    "site",
    "blog",
    "readme",
    "home",
    "mobile",
    "education",
    "nonprofit",
    "customer-stories",
    "open-source",
    "git-lfs",
  ]),
  facebook: new Set([
    "share.php",
    "sharer.php",
    "sharer",
    "login.php",
    "login",
    "logout",
    "signup",
    "help",
    "policies",
    "policy",
    "privacy",
    "terms",
    "settings",
    "groups",
    "pages",
    "people",
    "directory",
    "public",
    "marketplace",
    "events",
    "watch",
    "reel",
    "reels",
    "stories",
    "gaming",
    "friends",
    "messages",
    "notifications",
    "search",
    "business",
    "ads",
    "legal",
    "media",
    "hashtag",
    "bookmarks",
    "dialog",
    "plugins",
    "campaign",
    "recover",
    "checkpoint",
    "profile",
    "photo.php",
    "photo",
  ]),
  // Telegram had no entry here at all AND its case below never consulted one,
  // so every t.me utility route (`t.me/share`, `t.me/joinchat/...`) that fit
  // the username shape passed as a profile (codex review, ).
  telegram: new Set([
    "share",
    "joinchat",
    "addstickers",
    "addtheme",
    "addemoji",
    "addlist",
    "setlanguage",
    "confirmphone",
    "giftcode",
    "invoice",
    "socks",
    "proxy",
    "login",
    "contact",
    "premium",
  ]),
};

/** Shared empty set for platforms with no reserved-name list. */
const NO_RESERVED_SEGMENTS = new Set();

/**
 * Does `pathname` look like this platform's *profile* URL shape, as opposed
 * to a post, a video, a repository, or the bare host? A host match alone is
 * not enough: `https://github.com/alice/project` and
 * `https://youtube.com/watch?v=…` both pass `SAME_AS_HOSTS` but are not
 * identity claims about a person (codex review, ). Every shape here is
 * exactly what this module's own `url` builders above produce, so a
 * frontmatter-handle social always qualifies; only the raw-URL passthrough
 * path can fail it.
 * @param {string} key
 * @param {string} pathname
 * @returns {boolean}
 */
function isProfilePath(key, pathname) {
  // Split off exactly ONE leading empty segment (the `/` every special-scheme
  // pathname starts with) and at most one trailing empty (a trailing slash),
  // then REFUSE any remaining empty segment rather than collapsing it. The
  // previous `filter(Boolean)` made `https://github.com//alice` validate as
  // the single segment `alice` while the published URL kept the double slash
  // -- a URL that is not that profile (codex review, ). Same shape let
  // `facebook: //evil.example` become `https://facebook.com///evil.example`.
  const parts = pathname.split("/");
  if (parts[0] === "") parts.shift();
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.some((segment) => segment === "")) return false;
  const rawSegments = parts;
  // `URL` percent-encodes any non-ASCII pathname, so a legitimate
  // international handle -- YouTube officially supports them -- arrives here
  // as `%E5%B1%B1%E7%94%B0%E5%A4%AA%E9%83%8E` and every allowlist below
  // rejects it (codex review, ). Compare against the DECODED segment.
  // Safe because each pattern below is a strict allowlist that admits no
  // path, query or fragment delimiter, so decoding cannot smuggle one back
  // in. A malformed escape (`%E0%A4%A`) makes `decodeURIComponent` throw and
  // is not a profile URL either way.
  let segments;
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    return false;
  }
  const reserved = RESERVED_PATH_SEGMENTS[key] || NO_RESERVED_SEGMENTS;
  const first = segments[0]?.toLowerCase();

  switch (key) {
    case "twitter":
      return (
        segments.length === 1 &&
        /^[A-Za-z0-9_]{1,15}$/.test(segments[0]) &&
        !reserved.has(first)
      );
    case "github":
      // GitHub username rules: alphanumeric or single hyphens, 1-39 chars.
      return (
        segments.length === 1 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(segments[0]) &&
        !reserved.has(first)
      );
    case "instagram":
      return (
        segments.length === 1 &&
        /^[A-Za-z0-9_.]{1,30}$/.test(segments[0]) &&
        !reserved.has(first)
      );
    case "facebook":
      // Upper bound 50 (Facebook's own documented username maximum). The
      // class was `{5,}` -- unbounded -- so an arbitrarily long
      // creator-controlled string went straight into public SSR HTML as an
      // identity claim. `.php` is categorical: no Facebook *profile* vanity
      // name ends in `.php`, but the class admits `.`, so every utility
      // endpoint (`profile.php`, `story.php`, one added next year) matched
      // the profile shape and only a name-by-name deny-list stood in the way
      // (codex review, ).
      return (
        segments.length === 1 &&
        /^[A-Za-z0-9.]{5,50}$/.test(segments[0]) &&
        !/\.php$/i.test(first) &&
        !reserved.has(first)
      );
    case "linkedin":
      return (
        segments.length === 2 &&
        first === "in" &&
        /^[A-Za-z0-9-]{3,100}$/.test(segments[1])
      );
    case "reddit":
      return (
        segments.length === 2 &&
        (first === "u" || first === "user") &&
        /^[A-Za-z0-9_-]{3,20}$/.test(segments[1])
      );
    case "telegram":
      return (
        segments.length === 1 &&
        /^[A-Za-z0-9_]{5,32}$/.test(segments[0]) &&
        !reserved.has(first)
      );
    case "youtube":
      if (segments.length === 1 && segments[0].startsWith("@")) {
        // YouTube handles are the one shape here whose real character set
        // we cannot usefully enumerate: they accept non-Latin scripts, the
        // per-script minimum length is shorter than the Latin 3, and
        // separators like the middle dot are allowed. Two successive codex
        // rounds each named a different VALID handle that a tighter class
        // silently dropped, and a false negative here costs a real
        // creator their `sameAs` with no error anywhere.
        //
        // So this stops enumerating what a handle MAY contain and pins only
        // what makes the URL safe to publish as an identity claim: a single
        // path segment on youtube.com carrying no delimiter, whitespace or
        // control character that could make it address something other than
        // a handle. Length is capped at YouTube's documented 30.
        return /^@[^\s/?#\\@\u0000-\u001F\u007F]{1,30}$/u.test(segments[0]);
      }
      if (segments.length === 2 && first === "channel") {
        return /^UC[A-Za-z0-9_-]{22}$/.test(segments[1]);
      }
      if (segments.length === 2 && (first === "c" || first === "user")) {
        return /^[A-Za-z0-9_-]{1,30}$/.test(segments[1]);
      }
      return false;
    default:
      return false;
  }
}

/**
 * Characters the WHATWG URL parser does not preserve. Tab, LF and CR are
 * DELETED from anywhere in the input; a backslash is REWRITTEN to `/` under a
 * special scheme; leading/trailing C0 and space are stripped. So
 * `https://github.com/al<TAB>ice` parses to the pathname `/alice` -- it
 * validates as the handle `alice` while the profile page renders the link
 * text the creator actually typed. Rather than pick one of those two strings
 * to publish, refuse the input: no real profile URL contains an ASCII
 * control, a space or a backslash, and a `sameAs` that disagrees with the
 * visible link is the false positive this filter exists to prevent (codex
 * review, ).
 */
// eslint-disable-next-line no-control-regex
const URL_MANGLED_CHARS = /[\u0000-\u0020\u007F\\]/;

/**
 * Filter parsed social links down to the URLs safe to publish as schema.org
 * `sameAs` on the creator's `Person` node. A link qualifies only when its
 * resolved URL lands on the platform's own domain (`SAME_AS_HOSTS`), has the
 * path shape of a profile rather than some other resource on that domain
 * (`isProfilePath`), AND carries no query string or fragment -- none of this
 * module's own `url` builders ever produce one, so a real profile link never
 * needs one either, while a share/utility endpoint (`share.php?u=...`,
 * `watch?v=...`) usually does (codex review, ).
 *
 * The URL it returns is `parsed.href`, not the raw frontmatter string. Every
 * gate here interrogates the WHATWG-parsed URL, so publishing the raw string
 * validates one thing and ships another -- the exact shape this module exists
 * to prevent, in the false-positive direction (an identity claim about
 * someone else). Inputs whose parse is not faithful (control characters, a
 * backslash, userinfo, a port, a non-https scheme, an empty path segment) are
 * refused outright rather than quietly repaired.
 * @param {SocialLink[]} socials
 * @returns {string[]}
 */
export function sameAsUrls(socials) {
  const urls = [];
  for (const link of socials) {
    const hosts = SAME_AS_HOSTS[link.key];
    if (!hosts) continue;
    // Refuse BEFORE parsing anything the WHATWG parser would silently
    // rewrite, so the string that was validated and the string that gets
    // published cannot describe different handles. See the doc comment.
    if (URL_MANGLED_CHARS.test(link.url)) continue;
    let parsed;
    try {
      parsed = new URL(link.url);
    } catch {
      continue;
    }
    // Every allowlisted host is HTTPS-only, and none of this module's own
    // `url` builders emit anything but https. `twitter: http://x.com/alice`
    // could only come from the raw-URL passthrough, and an identity claim
    // asserted over a scheme the platform does not serve is not one worth
    // publishing (codex review, ).
    if (parsed.protocol !== "https:") continue;
    // `https://alice:hunter2@github.com/alice` parses with hostname
    // `github.com` and pathname `/alice` -- it passes every gate below while
    // carrying credentials that `href` faithfully republishes, and the
    // userinfo is the part a reader's eye reads as the host. No profile URL
    // has userinfo or a non-default port.
    if (parsed.username || parsed.password || parsed.port) continue;
    if (!hosts.has(parsed.hostname.toLowerCase())) continue;
    if (parsed.search || parsed.hash) continue;
    if (!isProfilePath(link.key, parsed.pathname)) continue;
    // Publish the PARSED url, never `link.url`. Every gate above interrogates
    // `parsed`; pushing the raw string would publish something the checks
    // never saw. `href` is the serialization of exactly the components that
    // were validated (percent-encoded, which is the canonical wire form of an
    // international handle -- an equivalent URL, not a different one).
    urls.push(parsed.href);
  }
  return urls;
}
