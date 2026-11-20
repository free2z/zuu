/**
 * Every in-app destination this surface can reach must be a route this surface
 * actually mounts. Native anchors may also reach configured, existing HTML
 * build entries through full-document navigation.
 *
 * This exists because the content extraction is a *copy* out of ZUULI, and
 * ZUULI's route table is not this one. The first version of this guard caught
 * three `<Link to="/wallet/fund">` buttons carried over with Live and AI. It
 * also missed three more of the same bug, which is why it now has teeth:
 *
 *   * `safeLoginDestination` **returned** `/wallet/fund`, `/wallet/fund/activity`
 *     and `/wallet/fund/send` as sanctioned post-sign-in landings, feeding them
 *     straight to `navigate()`. A bare allowlist, matched by no `to=`.
 *   * `buyCheckout` sent `currentPath: "/wallet/fund"`, which is what the
 *     backend builds the Stripe return URL from — a paying customer returned
 *     to NotFound.
 *   * an object-literal `{ to: "/wallet/fund" }` in the `NAVIGATION` table has
 *     no `=`, so the whole sidebar was unscanned.
 *
 * Nothing else catches these. Typecheck cannot — `to` is a string, and
 * `LoginDestination` was a union of whatever it claimed. The unit suites never
 * render those branches. `tests/surface-separation.pw.ts` asserting that an
 * unmounted wallet path renders NotFound is the *correct* behaviour and stayed
 * green throughout.
 *
 * Sources arrive through `import.meta.glob(..., "?raw")` rather than `node:fs`
 * for the reason `i18n/source-policy.test.ts` gives: `project-boundary.mjs`
 * builds every source file of this project through a real production Rollup
 * graph, where a Node built-in would resolve to `__vite-browser-external`.
 */
import { describe, expect, it } from "vitest";
import { APP_ROUTES } from "./routes";
import { htmlBuildInputs } from "../../html-build-inputs";
import { safeLoginDestination } from "./auth/login-destination";

const productionSources = import.meta.glob(
  ["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx"],
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

// This set comes from real files, not a filename allowlist. A separate Node
// contract loads Vite's actual config in both modes and verifies that it uses
// these inputs, including the default-off evaluation exclusion.
const htmlSources = import.meta.glob("../../*.html", {
  eager: true, import: "default", query: "?raw",
}) as Record<string, string>;
const htmlFiles = new Set(Object.keys(htmlSources).map((file) => file.slice("../../".length)));
const configuredDocuments = new Set(Object.values(htmlBuildInputs(true)));

/**
 * Comments describe routes that deliberately are not ours — `routes.ts` names
 * ZUULI's `/wallet`, `/messages` and `/kyc` precisely to say this app does not
 * own them, and `lib/bridge/creator-tip.ts` documents the wallet's
 * `/wallet/send/creator-tip` because the intent bridge targets another app
 * (#905). Only executable text is scanned.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turn a React Router path pattern into a matcher. `:param` accepts one
 * segment; a trailing `/*` accepts the base path itself and anything below it;
 * everything else is exact — which is the part first-segment membership got
 * wrong, since `/fund` is mounted with no children and `/fund/activity` is
 * therefore not a route.
 */
function routeMatcher(route: string): RegExp {
  if (route === "/") return /^\/$/;
  const splat = route.endsWith("/*");
  const base = splat ? route.slice(0, -2) : route;
  const source = base
    .split("/")
    .map((segment) =>
      segment.startsWith(":") ? "[^/]+" : escapeRegExp(segment),
    )
    .join("/");
  return new RegExp(`^${source}${splat ? "(?:/[^?#]*)?" : ""}$`);
}

const MATCHERS = Object.values(APP_ROUTES).map(routeMatcher);

/** Does a concrete in-app path resolve to something `App` mounts? */
function isMountedRoute(path: string): boolean {
  const pathname = path.split(/[?#]/u)[0];
  return MATCHERS.some((matcher) => matcher.test(pathname));
}

/**
 * The ways a string reaches the router:
 *   `to="/x"`, `to={"/x"}`, `` to={`/x`} ``   — Link, NavLink, Navigate
 *   `href="/x"`                               — anchors (document or SPA)
 *   `navigate("/x")`                          — imperative
 *   `to: "/x"`                                — the NAVIGATION table
 *   `currentPath: "/x"`                       — what the backend returns to
 * Relative targets resolve against a mounted route by definition, and absolute
 * `https://` hrefs are external content, so only `/`-prefixed values are taken.
 */
const ROUTER_TARGET =
  /(?:\b(?:to|href)\s*=|\bnavigate\(\s*|\b(?:to|currentPath)\s*:\s*)\{?\s*["'`](\/[^"'`\s]*)["'`]/g;

/**
 * Top-level segments ZUULI owns and this surface deliberately does not.
 *
 * `kyc` and `profile` left this list when they were ported: both are mounted
 * here now, so a link to either is an in-app destination and is checked by
 * `isMountedRoute` like every other. They are still listed in
 * `APP_ROUTES`-shaped form there rather than trusted implicitly.
 */
const ZUULI_ONLY_SEGMENTS = ["wallet", "messages", "about"];
const ZUULI_ONLY_PATH = new RegExp(
  `["'\`](/(?:${ZUULI_ONLY_SEGMENTS.join("|")})(?:/[^"'\`\\s]*)?)["'\`]`,
  "g",
);

const entries = Object.entries(productionSources).map(
  ([file, source]) => [file, stripComments(source)] as const,
);

function destinations(source: string) {
  return [...stripComments(source).matchAll(ROUTER_TARGET)].map((match) => ({
    path: match[1],
    // Only native <a href> leaves the SPA. A Link/to or navigate() targeting
    // the same HTML filename is still a router mistake and must fail.
    documentNavigation: /^href\s*=/.test(match[0]) &&
      /<a\b[^>]*$/.test(stripComments(source).slice(0, match.index)),
  }));
}

function isReachableDestination(
  target: ReturnType<typeof destinations>[number],
  inputs = configuredDocuments,
  files = htmlFiles,
): boolean {
  if (isMountedRoute(target.path)) return true;
  if (!target.documentNavigation) return false;
  const file = target.path.split(/[?#]/u)[0].slice(1);
  return file.endsWith(".html") && inputs.has(file) && files.has(file);
}

const routerTargets = entries.flatMap(([file, source]) =>
  destinations(source).map((target) => ({ file, ...target })),
);

describe("in-app link destinations", () => {
  it("finds router targets to check", () => {
    // A coverage anchor: if the pattern ever stops matching, every assertion
    // below would pass vacuously forever (#553).
    expect(routerTargets.length).toBeGreaterThan(8);
  });

  it("scans the navigation table, which uses an object-literal `to:`", () => {
    // The sidebar is the highest-traffic set of destinations in the app and
    // carries no `to=` anywhere, so name it explicitly rather than trusting the
    // glob to have covered it.
    const scanned = routerTargets.filter(({ file }) =>
      file.endsWith("components/layout/navigation.ts"),
    );
    expect(scanned.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "/articles",
        "/search",
        "/live",
        "/ai",
        "/fund",
        "/profile",
        "/kyc",
      ]),
    );
  });

  it("scans the account menu, whose destinations are `navigate(...)` calls", () => {
    // TopBar is the only path to `/profile` and `/kyc` on a phone: the mobile
    // tab bar carries five items and neither of these is one. Its items are
    // imperative `navigate()` calls with no `to=`, so name the file the same
    // way the navigation table is named above rather than trusting the glob.
    const scanned = routerTargets.filter(({ file }) =>
      file.endsWith("components/layout/TopBar.tsx"),
    );
    expect(scanned.map(({ path }) => path)).toEqual(
      expect.arrayContaining(["/fund", "/profile", "/kyc"]),
    );
  });

  it("only uses mounted SPA routes or native links to configured HTML entries", () => {
    const unmounted = routerTargets.filter((target) => !isReachableDestination(target));
    expect(
      unmounted.map(({ file, path }) => `${file}: ${path}`),
      "destinations must be mounted SPA routes or native links to existing configured HTML inputs",
    ).toEqual([]);
  });

  it("accepts a native document link only when its actual HTML input and file exist", () => {
    const [target] = destinations('<a href="/local-draft.html">Evaluate</a>');
    expect(isMountedRoute(target.path)).toBe(false);
    expect(isReachableDestination(target)).toBe(true);
    expect(isReachableDestination(target, new Set(["index.html"]))).toBe(false);
    expect(isReachableDestination(target, configuredDocuments, new Set(["index.html"]))).toBe(false);
  });

  it.each([
    '<a href="/missing.html">Missing</a>',
    '<a href="/wrong/local-draft.html">Wrong path</a>',
    '<Link to="/local-draft.html">SPA misuse</Link>',
    'navigate("/local-draft.html")',
    '{ to: "/local-draft.html" }',
    '{ currentPath: "/local-draft.html" }',
    '<Link href="/local-draft.html">Non-native href</Link>',
  ])("rejects missing/wrong document entries and SPA misuse: %s", (source) => {
    const targets = destinations(source);
    expect(targets).toHaveLength(1);
    expect(isReachableDestination(targets[0])).toBe(false);
  });

  it("never lands a completed sign-in outside the router", () => {
    // Behavioural rather than textual: whatever `safeLoginDestination` returns
    // goes straight to `navigate()`, so every reachable output must be mounted.
    // The corpus is its own accepted inputs plus the legacy aliases and a few
    // hostile shapes, so a widened allowlist is covered without editing this.
    const corpus = [
      "/",
      "/ai",
      "/fund",
      "/buy",
      "/buy/send",
      "/wallet/fund",
      "/wallet/fund/activity",
      "/wallet/fund/send",
      "/articles/post-1",
      "/creator/alice",
      "/live/alice",
      "/fund/activity",
      "/nope",
      "",
      undefined,
      null,
      { pathname: "/fund" },
    ];
    const escaped = corpus
      .map((value) => ({ value, landing: safeLoginDestination(value) }))
      .filter(({ landing }) => !isMountedRoute(landing));
    expect(
      escaped.map(({ value, landing }) => `${JSON.stringify(value)} -> ${landing}`),
      "safeLoginDestination must only ever return a mounted route",
    ).toEqual([]);
  });

  it("keeps ZUULI-only route segments out of executable source", () => {
    // The broad net for the bug class: a path literal anywhere in production
    // code whose first segment belongs to an app this one is being split away
    // from. Comments are stripped above, so the places that name those routes
    // to disclaim them are not flagged.
    const leaked = entries.flatMap(([file, source]) =>
      [...source.matchAll(ZUULI_ONLY_PATH)].map((m) => `${file}: ${m[1]}`),
    );
    expect(
      leaked,
      "these belong to ZUULI; this surface mounts none of them",
    ).toEqual([]);
  });
});
