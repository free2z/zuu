/**
 * Every in-app destination this surface can reach must be a route this surface
 * actually mounts.
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
import { safeLoginDestination } from "./auth/login-destination";

const productionSources = import.meta.glob(
  ["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx"],
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

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
 *   `href="/x"`                               — plain anchors
 *   `navigate("/x")`                          — imperative
 *   `to: "/x"`                                — the NAVIGATION table
 *   `currentPath: "/x"`                       — what the backend returns to
 * Relative targets resolve against a mounted route by definition, and absolute
 * `https://` hrefs are external content, so only `/`-prefixed values are taken.
 */
const ROUTER_TARGET =
  /(?:\b(?:to|href)\s*=|\bnavigate\(\s*|\b(?:to|currentPath)\s*:\s*)\{?\s*["'`](\/[^"'`\s]*)["'`]/g;

/** Top-level segments ZUULI owns and this surface deliberately does not. */
const ZUULI_ONLY_SEGMENTS = ["wallet", "messages", "kyc", "profile", "about"];
const ZUULI_ONLY_PATH = new RegExp(
  `["'\`](/(?:${ZUULI_ONLY_SEGMENTS.join("|")})(?:/[^"'\`\\s]*)?)["'\`]`,
  "g",
);

const entries = Object.entries(productionSources).map(
  ([file, source]) => [file, stripComments(source)] as const,
);

const routerTargets = entries.flatMap(([file, source]) =>
  [...source.matchAll(ROUTER_TARGET)].map((m) => ({ file, path: m[1] })),
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
      expect.arrayContaining(["/articles", "/search", "/live", "/ai", "/fund"]),
    );
  });

  it("only sends the router to routes this surface mounts", () => {
    const unmounted = routerTargets.filter(({ path }) => !isMountedRoute(path));
    expect(
      unmounted.map(({ file, path }) => `${file}: ${path}`),
      "these render NotFound on this surface; ZUULI's route table is not this one",
    ).toEqual([]);
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
