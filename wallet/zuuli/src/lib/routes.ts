/**
 * Top-level paths mounted by App. Keep route ownership here so consumers that
 * classify links cannot drift from the router's actual path prefixes.
 *
 * `home` represents App's index route; the remaining values are passed
 * directly to React Router.
 */
export const APP_ROUTES = {
  home: "/",
  login: "/login",
  search: "/search/*",
  creator: "/creator/:username/*",
  profile: "/profile",
  kyc: "/kyc/*",
  wallet: "/wallet/*",
  ai: "/ai/*",
  messages: "/messages/*",
  live: "/live/*",
  articles: "/articles/*",
  buy: "/buy/*",
} as const;

/** First path segments that belong to ZUULI rather than free2z content. */
export const APP_ROUTE_SEGMENTS = new Set(
  Object.values(APP_ROUTES).map((route) => route.split("/")[1] ?? ""),
);
