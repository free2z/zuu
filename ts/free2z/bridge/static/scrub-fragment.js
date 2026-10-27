/*
 * Generic free2z.com/bridge/<app>/... fallback pages.
 *
 * A bridge link can carry a response payload in its fragment
 * (CALLER-AUTHENTICATION.md §4.1 in free2z/zuu). This page never reads it.
 * The one thing it does is drop the fragment (and any query) from the address
 * bar and the current history entry, so the payload is not left behind to be
 * copied, shared or screenshotted. Nothing is sent anywhere, and the page works
 * the same without this script.
 *
 * k8s/free2z/bridge-pages/test/bridge-pages.test.mjs runs this exact file.
 */
(function () {
  "use strict";

  function scrub(loc, hist) {
    if (!loc || !hist || typeof hist.replaceState !== "function") {
      return false;
    }
    if (!loc.hash && !loc.search) {
      return false;
    }
    try {
      hist.replaceState(null, "", loc.pathname);
      return true;
    } catch (_error) {
      return false;
    }
  }

  if (typeof module === "object" && module && module.exports) {
    module.exports = { scrub: scrub };
    return;
  }

  scrub(window.location, window.history);
})();
