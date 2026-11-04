/**
 * Is this `::embed[…]` OUR OWN content, and if so, what is it?
 *
 * A same-origin embed must not go through the third-party path: the reader is
 * not warned about the site they are already on, and the URL is never shipped
 * to Iframely (a third party would otherwise learn what our readers view, and
 * our sanitizer would be processing HTML *they* returned for content *we*
 * host). This module is the one place that decides "first party", so the
 * decision has to be exact — anything it gets wrong in the permissive
 * direction skips a consent gate.
 *
 * THE RULES, and why each one exists:
 *
 *  1. Parse-based, never prefix-based. `https://free2z.cash.evil.com`,
 *     `https://evil.com/?u=free2z.cash` and `https://evil.com/free2z.cash/x`
 *     all START with or CONTAIN our host; only the parsed hostname answers.
 *     The value is run through `getSafeHttpUrl` first (the  invariant).
 *
 *  2. `http:`/`https:` only, the default port only, no userinfo.
 *     `https://evil.com@free2z.cash` parses to OUR hostname with a username;
 *     it is refused rather than reasoned about. `http:` is accepted because
 *     nothing is ever fetched from the URL as written (rule 6): an
 *     `http://free2z.cash/uploadz/x.mp4` embed renders the root-relative
 *     path over the page's own https origin, exactly as it did before.
 *
 *  3. Canonical spelling only. The WHATWG parser is forgiving on purpose: it
 *     turns `https:\\free2z.cash\uploadz\…`, `HTTPS://FREE2Z.CASH/…`,
 *     `https://free2z%2Ecash/…`, a tab inside the scheme and a `:443` all
 *     into our clean origin. None of those is how anyone writes a link to
 *     their own upload, and every one of them is how someone writes a URL
 *     designed to be read differently by two parsers. So the RAW string must
 *     carry no whitespace (bar an interior plain space), control character
 *     or backslash anywhere, and must begin with exactly `<scheme>://<host>`
 *     followed by `/`, `?`, `#` or the end. Refusing is always safe: a refused value simply takes the existing
 *     third-party path, consent gate and all.
 *
 *  4. The host set is EXACT hostnames (`FIRST_PARTY_HOSTS` plus the configured
 *     canonical and API hosts) — no trailing-dot `free2z.cash.`, no IDN
 *     lookalike (the parser punycodes those, and `xn--…` is not in the set).
 *     One bounded exception: a subdomain of a first-party apex
 *     (`www.free2z.cash`) may name an UPLOAD, never a route, because an
 *     upload is only ever fetched by its path from our own origin — the
 *     legacy rewrite the renderer always applied, kept so old articles keep
 *     playing.
 *
 *  5. Classification is by an ALLOW-LIST of route shapes: upload media under
 *     `/uploadz/`, a zPage (`/<username>/<identifier>`, `/article/<id>`) and
 *     a converse thread (`/converse/<uuid>`). Uploads render natively;
 *     zPage/converse render as a content card built from our own API with
 *     the READER's credentials (`first-party-embed-cards.ts`,  part 2)
 *     or, when that card is unavailable, as a plain link to the classified
 *     path.
 *     "Anything on our host" is not safe to render natively, because our host has redirect routes (logout
 *     destinations, `?next=`) and any of them is an escape hatch off-site.
 *     A first-party URL of any other shape becomes a plain link — never an
 *     iframe, never Iframely. The shape check runs on EVERY decoded segment,
 *     because nginx decodes `%2F` and resolves `..` before it matches a
 *     location: `/uploadz/a%2F..%2F..%2Flogout` is `/logout` to nginx.
 *     `/uploadz/private/…` (KYC) and `/uploadz/public/hls/…` (VOD outputs)
 *     are not article media and are excluded.
 *
 *  6. What is rendered is always the ROOT-RELATIVE upload path (prefixed with
 *     `PUBLIC_API_BASE_URL`, empty in production), never the host the author
 *     wrote. So even a classification mistake here cannot make the reader
 *     fetch from a foreign host; it can only make them fetch our own upload,
 *     with their own session, exactly as a `/uploadz/…` embed always has.
 *     That is also why access levels are honoured for free: members/private
 *     bytes are gated by nginx `auth_request` against the reader's cookies,
 *     and there is no server-side fetch that could elevate privilege.
 *
 * Content type is NOT trusted from the extension where it would matter: no
 * first-party embed is ever framed. The extension only picks between `<img>`,
 * `<video>`, `<audio>` and a link, and none of those executes markup whatever
 * the bytes turn out to be (an HTML file named `.pdf` — the  shape — is a
 * link that downloads, because nginx serves every non-media upload as
 * `Content-Disposition: attachment`).
 *
 * Runs identically during SSR and in the browser: it reads nothing but its
 * input and the public env, so server and client make the same decision and
 * there is no hydration flash of a consent card (or the reverse).
 */
import * as env from "$app/env/public";
import { getSafeHttpUrl } from "./safe-url";
import { zpagePrettyPathCollides } from "$lib/zpage-path";

/**
 * Every hostname this deployment serves uploads from, exactly.
 *
 * Mirrors the free2z.cash / free2z.com / free2give.xyz origins in
 * `PRIVATE_BACKEND_TRUSTED_ORIGINS` (k8s/new-ui/deployment.yaml) — prod plus
 * the `stage.`, `test.` and `new.` environments, which the ingress serves as
 * `%{PREFIX}<apex>`. That variable is server-only and this decision must be
 * made identically in the browser, so the list is repeated here and
 * `tests/first-party-embed.test.mjs` fails if the two drift. `free2z.net` is
 * the one addition: it is not a deployed origin, but the renderer has always
 * treated `free2z.net/uploadz/…` as ours and old articles still say so.
 *
 * Listing a host here is low-stakes by construction (rule 6 above): only the
 * PATH of a matching URL is ever used.
 */
export const FIRST_PARTY_HOSTS: readonly string[] = Object.freeze([
  "free2z.cash",
  "stage.free2z.cash",
  "test.free2z.cash",
  "new.free2z.cash",
  "free2z.com",
  "stage.free2z.com",
  "test.free2z.com",
  "new.free2z.com",
  "free2give.xyz",
  "stage.free2give.xyz",
  "test.free2give.xyz",
  "new.free2give.xyz",
  "free2z.net",
]);

export type FirstPartyMediaKind = "video" | "audio" | "image" | "pdf" | "file";

export type FirstPartyEmbed =
  | {
      kind: FirstPartyMediaKind;
      /**
       * Canonical, parser-serialized, root-relative `/uploadz/…` path. For
       * video/audio only, a validated Media Fragments time range (`#t=10`,
       * `#t=120,150`) is kept: it never reaches the server and it is what
       * makes an excerpt embed play the excerpt.
       */
      path: string;
      /** Decoded final path segment, for display. Text, never markup. */
      name: string;
    }
  | {
      /**
       * A zPage: the pretty `/<username>/<identifier>` shape, or the
       * `/article/<free2zaddr>` fallback (`username` null).
       */
      kind: "zpage";
      href: string;
      username: string | null;
      identifier: string;
    }
  | {
      /** A converse comment / thread: `/converse/<uuid>`. */
      kind: "converse";
      href: string;
      uuid: string;
    }
  | {
      /** Any other first-party URL: only ever a plain internal link. */
      kind: "page";
      /** Parsed absolute `http(s)://<first-party host>/…` href. */
      href: string;
    };

const UPLOAD_PREFIX = "/uploadz/";

// A username or zPage identifier segment, AFTER one decode: no leading dot, no
// separators, no percent — so an encoded `/`, `\` or `..` cannot survive.
const ROUTE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,149}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * First path segments that are never a username: every static top-level
 * route in `src/routes` (pinned by a test that reads that directory) and the
 * backend-owned prefixes nginx routes elsewhere. `zpagePrettyPathCollides`
 * adds the product's own collision rules on top.
 */
const NON_USERNAME_ROOTS = new Set([
  // src/routes (static top-level segments, route groups flattened)
  "account",
  "ai",
  "article",
  "begin",
  "buy-2z",
  "checkout",
  "converse",
  "creators",
  "csp-report",
  "developers",
  "edit",
  "events",
  "find",
  "healthz",
  "live",
  "login",
  "oauth",
  "og",
  "profile",
  "projects",
  "reset-password",
  "robots.txt",
  "search",
  "sitemap",
  "sitemap-v2.xml",
  "sitemap.xml",
  "storytime",
  "tag",
  "tools",
  "trending",
  // backend / nginx-owned (k8s/free2z/nginx.conf `location` prefixes)
  "_app",
  "_internal_exports",
  "adminzzz",
  "api",
  "brand",
  "bridge",
  "classic-ui",
  "djstatic",
  "docs",
  "feeds",
  "gcsproxy",
  "static",
  "try-new-ui",
  "uploads",
  "uploadz",
  "ws",
]);

/**
 * The allow-listed CONTENT route shapes ( scope amendment): a zPage or
 * a converse thread. Exact segment counts — `/<user>/<vanity>/edit`,
 * `/<user>/zpage/<slug>` (a redirect), `/<user>/private/<secret>` and every
 * other shape fall through to a plain link. One trailing slash is tolerated;
 * every segment is checked AFTER a decode, so `%2F`/`%2e%2e` cannot pass.
 */
function contentFromPath(
  pathname: string,
  href: string,
): FirstPartyEmbed | null {
  const trimmed =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  const raw = trimmed.slice(1).split("/");
  if (raw.length !== 2) return null;
  let first: string;
  let second: string;
  try {
    first = decodeURIComponent(raw[0]);
    second = decodeURIComponent(raw[1]);
  } catch {
    return null;
  }

  if (first === "converse") {
    return UUID.test(second)
      ? { kind: "converse", href, uuid: second.toLowerCase() }
      : null;
  }
  if (first === "article") {
    return ROUTE_SEGMENT.test(second)
      ? { kind: "zpage", href, username: null, identifier: second }
      : null;
  }
  if (
    !ROUTE_SEGMENT.test(first) ||
    !ROUTE_SEGMENT.test(second) ||
    NON_USERNAME_ROOTS.has(first.toLowerCase()) ||
    zpagePrettyPathCollides(first, second)
  ) {
    return null;
  }
  return { kind: "zpage", href, username: first, identifier: second };
}

// Every extension the upload allowlist accepts (py/dj/apps/uploads/
// validation.py ALLOWED_TYPE_EXTENSIONS) is classified by its MIME family;
// `tests/first-party-embed.test.mjs` reads that file and fails on drift.
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "mov", "qt"]);
const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "ogg",
  "oga",
  "wav",
  "m4a",
  "m4b",
  "aac",
  "flac",
  "opus",
]);
// An `<img>` never executes what it loads, so this list is about what renders,
// not about safety. Matches the image half of nginx's inline-disposition map.
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "jpe",
  "jfif",
  "gif",
  "webp",
  "avif",
  "avifs",
  "heic",
  "heif",
  "heics",
  "heifs",
  "bmp",
  "ico",
  "tif",
  "tiff",
  "svg",
]);

// Whitespace other than a plain space (tabs, newlines, Unicode spaces), C0
// controls, DEL and backslash. The URL parser strips or rewrites every one of
// these, which is exactly why a value carrying one is not in canonical form.
// A plain interior space is the exception (codex review): legacy articles
// write `/uploadz/public/u/My Video.mp4`, the parser only percent-encodes it,
// and a space cannot reach the authority without failing the exact
// `https://<host>` prefix check below. Leading/trailing space is refused.
// eslint-disable-next-line no-control-regex
const NON_CANONICAL_CHARACTER = /[^\S ]|[\\\u0000-\u001f\u007f]/;
// LRM/RLM, ALM, the embeddings/overrides and the isolates.
const BIDI_CONTROLS = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g;
// eslint-disable-next-line no-control-regex
const UNSAFE_DECODED_SEGMENT = /[/\\\u0000-\u001f\u007f]/;

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.port) return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * `FIRST_PARTY_HOSTS` plus the configured canonical and API hosts, when those
 * are `https:` on the default port. Computed per call: `$env/dynamic/public`
 * is runtime configuration, not a build constant.
 */
export function firstPartyHosts(): ReadonlySet<string> {
  const hosts = new Set(FIRST_PARTY_HOSTS);
  for (const configured of [
    env.PUBLIC_CANONICAL_BASE_URL,
    env.PUBLIC_API_BASE_URL,
  ]) {
    const host = hostOf(configured);
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * The URL a first-party upload is actually fetched from: the root-relative
 * path under `PUBLIC_API_BASE_URL` (empty in production, so `/uploadz/…` on the
 * page's own origin, with the reader's own session).
 */
export function firstPartyUploadSrc(path: string): string {
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";
  return `${apiBase}${path}`;
}

/**
 * The short type label on a document/file card: the upper-cased extension, or
 * `FILE`. Language-neutral on purpose — the markdown renderer has no locale.
 */
export function firstPartyFileBadge(name: string): string {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1];
  return extension ? extension.toUpperCase() : "FILE";
}

/**
 * The rewrite predicate for markdown IMAGES (`![](…)`), which is a
 * normalization, not a trust decision: a matching absolute upload URL is
 * rewritten to the root-relative path on our own origin, and nothing is ever
 * fetched from the host as written. It therefore keeps the breadth the old
 * `(^|\.)free2z\.(cash|com|net)$` rewrite had — exact first-party hosts plus
 * any subdomain of a first-party apex — so an image that worked through that
 * rewrite (e.g. a `www.free2z.cash` URL, which has no DNS) keeps working. The
 * EMBED classifier stays exact: there the host decides whether a consent gate
 * is skipped, and a wrong "yes" is not self-correcting the way a rewrite is.
 */
export function isFirstPartyUploadDomain(
  hostname: string,
  hosts: ReadonlySet<string> = firstPartyHosts(),
): boolean {
  if (hosts.has(hostname)) return true;
  for (const host of hosts) {
    if (host.split(".").length === 2 && hostname.endsWith(`.${host}`)) {
      return true;
    }
  }
  return false;
}

/** Exact hostname membership. The caller passes a PARSED hostname. */
export function isFirstPartyHost(
  hostname: string,
  hosts: ReadonlySet<string> = firstPartyHosts(),
): boolean {
  return hosts.has(hostname);
}

function mediaKind(name: string): FirstPartyMediaKind {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === "pdf") return "pdf";
  return "file";
}

/**
 * The upload this parsed URL addresses, or `null` when its path is not an
 * allow-listed upload media shape. The query is dropped: nothing the upload
 * routes serve depends on it, and a rendered URL should carry nothing the
 * author can use to steer a different route. The fragment is dropped too,
 * except a media time range on video/audio (client-side only, never sent).
 */
// Media Fragments temporal dimension, NPT seconds only: `#t=10`, `#t=,20`,
// `#t=10.5,20`. Anything else in the fragment is dropped.
const MEDIA_TIME_FRAGMENT =
  /^#t=(?:\d{1,7}(?:\.\d{1,3})?)?(?:,\d{1,7}(?:\.\d{1,3})?)?$/;

function decodeLeniently(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // `100%.mp4`: a lone `%` is not an escape, so there is nothing to decode.
    return value;
  }
}

function uploadFromPath(
  pathname: string,
  hash = "",
): Extract<FirstPartyEmbed, { path: string }> | null {
  if (!pathname.startsWith(UPLOAD_PREFIX)) return null;

  const segments = pathname.slice(UPLOAD_PREFIX.length).split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "")) {
    return null;
  }

  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }
    // `.`/`..` cannot survive the parser as literal segments, but `%2e%2e`
    // can survive as part of a longer one, and nginx decodes before it
    // normalizes. A decoded `/` or `\` is refused for the same reason. A
    // literal `%` is legal in a legacy filename (`100%25.mp4` is `100%.mp4`,
    // which the backend still serves), so instead of refusing it the segment
    // is decoded a SECOND time and must be just as clean: `%252f` / `%252e%252e`
    // (double encoding aimed at a second decoder) is refused.
    const twice = decodeLeniently(value);
    if (
      [value, twice].some(
        (candidate) =>
          candidate === "." ||
          candidate === ".." ||
          candidate === "" ||
          UNSAFE_DECODED_SEGMENT.test(candidate),
      )
    ) {
      return null;
    }
    decoded.push(value);
  }

  if (decoded[0] === "private") return null;
  if (decoded[0] === "public" && decoded[1] === "hls") return null;
  // A bare `/uploadz/public/<x>` with nothing under the tier is not an upload.
  if (decoded[0] === "public" && decoded.length < 2) return null;

  // Bidi controls are stripped from the DISPLAY name (and the kind is taken
  // from what is displayed): `%E2%80%AEgnp.exe` would otherwise render as
  // `exe.png` beside an EXE badge. The path itself is left as the file's
  // real name — it is a URL, never shown.
  const name = decoded[decoded.length - 1].replace(BIDI_CONTROLS, "");
  const kind = mediaKind(name);
  const keepFragment =
    (kind === "video" || kind === "audio") &&
    hash !== "#t=" &&
    hash !== "#t=," &&
    MEDIA_TIME_FRAGMENT.test(hash);
  return { kind, path: keepFragment ? `${pathname}${hash}` : pathname, name };
}

/**
 * Classify an `::embed[…]` value as first-party content, or return `null` to
 * leave it on the existing third-party path.
 *
 * Accepts the two spellings authors (and the editor) write for their own
 * content: a root-relative `/uploadz/…` path, and an absolute
 * `http(s)://<first-party host>/…` URL. A root-relative value is only ever an
 * upload — anything else root-relative returns `null`, exactly as it was never
 * embeddable before.
 */
export function classifyFirstPartyEmbed(
  value: unknown,
  hosts: ReadonlySet<string> = firstPartyHosts(),
): FirstPartyEmbed | null {
  if (typeof value !== "string" || value === "") return null;
  if (NON_CANONICAL_CHARACTER.test(value) || value.trim() !== value) {
    return null;
  }

  if (value.startsWith("/")) {
    // `//host/…` is protocol-relative: another origin, not a path.
    if (value.startsWith("//")) return null;
    let parsed: URL;
    try {
      // The base is a placeholder; only the resolved path is used, so no
      // host can leak from here into the result.
      parsed = new URL(value, "https://first-party.invalid");
    } catch {
      return null;
    }
    if (parsed.host !== "first-party.invalid") return null;
    return uploadFromPath(parsed.pathname, parsed.hash);
  }

  const href = getSafeHttpUrl(value);
  if (!href) return null;

  const parsed = new URL(href);
  // DEFENCE IN DEPTH: with rule 3 below intact these two lines can never
  // fire on their own — a raw value that begins with exactly
  // `<scheme>://<host>` and then `/`, `?`, `#` or the end cannot carry a
  // username, password or port, and `getSafeHttpUrl` already limited the
  // scheme. They become load-bearing only if rule 3 is ever loosened, which
  // is exactly when they are wanted; the unit tests cannot tell them apart
  // from rule 3 and do not pretend to.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  // Rule 4. Exact hosts may name any allow-listed shape. A legacy alias
  // (a subdomain of a first-party apex, e.g. `www.free2z.cash`, which the
  // pre- renderer rewrote) may name an UPLOAD only: the upload is then
  // served from our own origin by path, so the alias host is never contacted
  // the same normalization markdown images get (`isFirstPartyUploadDomain`).
  const exactHost = hosts.has(parsed.hostname);
  if (!exactHost && !isFirstPartyUploadDomain(parsed.hostname, hosts)) {
    return null;
  }

  // Rule 3: the raw spelling must already be the canonical authority.
  const authority = `${parsed.protocol}//${parsed.hostname}`;
  if (!value.startsWith(authority)) return null;
  const after = value.charAt(authority.length);
  if (after !== "" && after !== "/" && after !== "?" && after !== "#") {
    return null;
  }

  const upload = uploadFromPath(parsed.pathname, parsed.hash);
  if (upload) return upload;
  if (!exactHost) return null;
  return contentFromPath(parsed.pathname, href) ?? { kind: "page", href };
}
