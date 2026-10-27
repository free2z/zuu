/**
 * Opt the Svelte UI into collision-safe content links from Django.
 *
 * The backend deliberately defaults to classic's historic URL shape because
 * a React bundle can remain loaded while Django rolls. Keep this explicit at
 * new-UI reads until classic retirement removes the mixed-client window.
 */
export const CANONICAL_CONTENT_URL_HEADERS = {
  "X-Free2Z-Canonical-Content-URL": "1",
} as const;
