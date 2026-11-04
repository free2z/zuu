/*
 * https://free2z.com/bridge/e2e2z/chat/#peer=<handle>  (free2z/zuu#1022, Contract B)
 *
 * This page is what a verified App Link falls through to when e2e2z is not
 * installed. The only thing this script does is read the handle from the
 * FRAGMENT and show "@handle wants to chat".
 *
 * Privacy rules this file keeps (CALLER-AUTHENTICATION.md §4.1 in free2z/zuu):
 *   - the fragment is read here and nowhere else, and never sent anywhere:
 *     no fetch, XHR, beacon, socket, image, storage, cookie or analytics;
 *   - the handle is written with textContent, never as HTML;
 *   - anything but exactly `#peer=<handle>` with handle in ^[a-z0-9_]{1,30}$
 *     is refused and nothing from it is shown. There is no percent-decoding:
 *     a valid handle never needs it, so an encoded one is refused.
 *
 * k8s/free2z/bridge-pages/test/bridge-pages.test.mjs runs this exact file.
 */
(function () {
  "use strict";

  var HANDLE = /^[a-z0-9_]{1,30}$/;
  var CHAT_PATH = "/bridge/e2e2z/chat/";

  function peerFromFragment(hash) {
    if (typeof hash !== "string" || hash === "" || hash === "#") {
      return { state: "none" };
    }
    if (hash.charAt(0) !== "#") {
      return { state: "invalid" };
    }
    var body = hash.slice(1);
    if (body.slice(0, 5) !== "peer=") {
      return { state: "invalid" };
    }
    var handle = body.slice(5);
    if (!HANDLE.test(handle)) {
      return { state: "invalid" };
    }
    return { state: "valid", handle: handle };
  }

  function render(doc, result) {
    var generic = doc.getElementById("peer-generic");
    var line = doc.getElementById("peer-line");
    var name = doc.getElementById("peer-name");
    var invalid = doc.getElementById("peer-invalid");
    var openApp = doc.getElementById("open-app");
    if (!generic || !line || !name || !invalid || !openApp) {
      return;
    }
    if (result.state === "valid") {
      name.textContent = "@" + result.handle;
      line.hidden = false;
      generic.hidden = true;
      invalid.hidden = true;
      // The handle already matched ^[a-z0-9_]{1,30}$, so it needs no encoding.
      openApp.setAttribute("href", CHAT_PATH + "#peer=" + result.handle);
    } else {
      name.textContent = "";
      line.hidden = true;
      generic.hidden = false;
      invalid.hidden = result.state !== "invalid";
      openApp.setAttribute("href", CHAT_PATH);
    }
  }

  var api = { peerFromFragment: peerFromFragment, render: render };

  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
    return;
  }

  function update() {
    render(document, peerFromFragment(window.location.hash));
  }

  update();
  window.addEventListener("hashchange", update);
})();
