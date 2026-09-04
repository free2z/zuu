/**
 * Every in-app destination this surface links to must be a route this surface
 * actually mounts.
 *
 * This exists because the content extraction is a *copy* out of ZUULI, and
 * ZUULI's route table is not this one. Porting Live and AI (#904) carried over
 * three `<Link to="/wallet/fund">` buttons — ZUULI's 2Z top-up path. free2z
 * mounts `/fund` and deliberately mounts nothing under `/wallet` at all, so all
 * three rendered a NotFound instead of a top-up screen: a dead end at exactly
 * the moment a viewer is told they need more 2Zs to keep watching.
 *
 * Nothing caught it. Typecheck cannot — `to` is a string. The unit suites
 * cannot — they never render those branches. `surface-separation.pw.ts` asserts
 * an unmounted wallet path renders NotFound, which is the *correct* behaviour
 * and stayed green while the links were broken. So the invariant is asserted
 * here, against the real source tree, and it will catch the next feature copied
 * across the same boundary.
 *
 * Sources arrive through `import.meta.glob(..., "?raw")` rather than `node:fs`
 * for the reason `i18n/source-policy.test.ts` gives: `project-boundary.mjs`
 * builds every source file of this project through a real production Rollup
 * graph, where a Node built-in would resolve to `__vite-browser-external`.
 */
import { describe, expect, it } from "vitest";
import { APP_ROUTE_SEGMENTS } from "./routes";

const productionSources = import.meta.glob(
  ["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx"],
  { eager: true, import: "default", query: "?raw" },
) as Record<string, string>;

/**
 * `to="/x"`, `to={"/x"}`, `` to={`/x/${id}`} ``, and the `navigate("/x")` /
 * `navigate(`/x`)` forms. Only absolute in-app paths are of interest: a
 * relative `to="edit"` resolves against a route that is mounted by definition,
 * and an `https://` href is external content, not a route.
 */
const ROUTE_LITERAL = /(?:\bto=|\bnavigate\(\s*)\{?\s*["'`](\/[^"'`\s]*)["'`]/g;

/** The first path segment, which is what `APP_ROUTE_SEGMENTS` is keyed on. */
function firstSegment(path: string): string {
  return path.split(/[?#]/u)[0].split("/")[1] ?? "";
}

const references = Object.entries(productionSources).flatMap(
  ([file, source]) =>
    [...source.matchAll(ROUTE_LITERAL)].map((match) => ({
      file,
      path: match[1],
    })),
);

describe("in-app link destinations", () => {
  it("finds absolute route references to check", () => {
    // A coverage anchor: if the pattern ever stops matching, this test would
    // pass vacuously forever. Live/AI/Search alone contribute several.
    expect(references.length).toBeGreaterThan(5);
  });

  it("only links to route segments this surface mounts", () => {
    const unmounted = references.filter(
      ({ path }) => !APP_ROUTE_SEGMENTS.has(firstSegment(path)),
    );
    expect(
      unmounted.map(({ file, path }) => `${file}: ${path}`),
      "these paths render NotFound on this surface; ZUULI's route table is not this one",
    ).toEqual([]);
  });
});
