/**
 * Top-level paths mounted by App. Keep route ownership here so consumers that
 * classify links cannot drift from the router's actual path prefixes.
 *
 * `home` represents App's index route (which forwards to Articles); the
 * remaining values are passed directly to React Router.
 *
 * ZUULI's copy of this list also owns `/wallet`, `/messages`, `/kyc` and the
 * rest. This surface owns only what it mounts, so a link to a ZUULI-only path
 * is correctly classified as external content rather than as an in-app route.
 *
 * `/search`, `/ai` and `/live` are the three surfaces #912 deferred. They are
 * content routes in the same sense as `/articles`: none of them reads a
 * spending key, and none of them needs a privileged command to render.
 */
export const APP_ROUTES = {
  home: "/",
  login: "/login",
  articles: "/articles/*",
  search: "/search/*",
  ai: "/ai/*",
  live: "/live/*",
  creator: "/creator/:username/*",
  fund: "/fund",
} as const;

/** First path segments that belong to this app rather than free2z content. */
export const APP_ROUTE_SEGMENTS = new Set(
  Object.values(APP_ROUTES).map((route) => route.split("/")[1] ?? ""),
);
