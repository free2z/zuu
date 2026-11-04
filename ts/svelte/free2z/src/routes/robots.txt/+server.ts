import * as env from "$app/env/public";
import { CANONICAL_ORIGIN } from "$lib/seo";
import type { RequestHandler } from "./$types";

// NOTE: nginx shadows this route in production — k8s/free2z/nginx.conf serves
// /robots.txt as a local literal because it is the pod readinessProbe. CI
// (.github/scripts/check_nginx_confs.sh) diffs these bytes against that
// literal, so the two must be edited together.
//
// Every `Disallow` is a PREFIX match, i.e. a claim on the username namespace
//. `Disallow: /edit` blocked /editor, /edits and /editorial, all of
// which are registrable usernames — is_forbidden_username() reserves only the
// exact string `edit`. Rules meaning "this one page" are therefore written as
// the `$`-terminated form plus the `/` subtree form. `$` and `*` are
// Google/Bing extensions: a strict crawler ignores the rule and fails OPEN
// (indexes the page), which is the cheap direction to fail for a rule that
// only hides an editor UI. See the long comment in nginx.conf.
export const GET: RequestHandler = () => {
  const canonicalOrigin =
    env.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, "") || CANONICAL_ORIGIN;

  return new Response(
    `User-agent: *
Allow: /
Disallow: /api/
Disallow: /edit$
Disallow: /edit/
Disallow: /edit?
Disallow: /buy-2z$
Disallow: /buy-2z/
Disallow: /buy-2z?
Disallow: /*/dashboard/
Disallow: /*/private/
Disallow: /checkout/

Sitemap: ${canonicalOrigin}/sitemap.xml
`,
    {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    },
  );
};
