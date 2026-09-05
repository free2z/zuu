/**
 * Top-level paths mounted by App. Keep route ownership here so consumers that
 * classify links cannot drift from the router's actual path prefixes.
 *
 * `home` represents App's index route; the remaining values are passed
 * directly to React Router.
 *
 * ZUULI is the wallet authority (#904). The content surfaces — articles,
 * creator, live, AI, search, profile and KYC — moved to `wallet/free2z`, and
 * the routes that mounted them are deleted rather than redirected: a route
 * that still exists is a route a confused frame can navigate the seed-holding
 * WebView to (#367).
 */
export const APP_ROUTES = {
  home: "/",
  login: "/login",
  about: "/about",
  wallet: "/wallet/*",
  buy: "/buy/*",
} as const;

/** First path segments that belong to ZUULI rather than free2z content. */
export const APP_ROUTE_SEGMENTS = new Set(
  Object.values(APP_ROUTES).map((route) => route.split("/")[1] ?? ""),
);
