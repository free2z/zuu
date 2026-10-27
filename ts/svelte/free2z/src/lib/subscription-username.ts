// The username a billing action puts into `/api/tuzis/subscribe/{username}`.
//
// It must accept every username Django can store, or a subscriber to that
// creator cannot Unsubscribe — the one control that stops recurring charges
//. `Creator.username` is AbstractUser's field: max_length=150 and
// `UnicodeUsernameValidator`, i.e. `^[\w.@+-]+\Z` with Python's Unicode-aware
// `\w` (letters, numbers, underscore). The route is `subscribe/<str:username>`,
// which takes any character but `/`. The old client rule,
// `^[a-zA-Z0-9_]{1,64}$`, refused `-`, `.`, `@`, `+` and anything over 64.
//
// `\p{L}\p{N}_` is the JavaScript spelling of Python's Unicode `\w`. The `u`
// flag makes `{1,150}` count code points, which is how Django counts length.
//
// It stays a guard, not a pass-through: the value is a path segment. `.` and
// `..` are the two names the validator allows that a URL parser would resolve
// as dot-segments (`/api/tuzis/subscribe/..` is `/api/tuzis/`), so they are
// refused here even though Django could in principle hold them. Callers must
// still `encodeURIComponent` it.
export const SUBSCRIPTION_USERNAME_MAX_LENGTH = 150;

const SUBSCRIPTION_USERNAME_PATTERN = /^[\p{L}\p{N}_.@+-]{1,150}$/u;

export function isSubscriptionUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "." &&
    value !== ".." &&
    SUBSCRIPTION_USERNAME_PATTERN.test(value)
  );
}
