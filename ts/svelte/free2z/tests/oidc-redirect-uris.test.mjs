// Redirect URI feedback in the developer console (; spec §3,
// RFC 8252 §7). The client mirrors `dj.apps.oidc.redirects.classify` so a
// developer sees what is wrong before submitting; the server stays the
// authority and its own refusals are shown too. These cases are the same
// shapes py/free2z/dj/apps/oidc/tests/test_developer_console.py refuses.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyRedirectUri,
  redirectUriLines,
  validateRedirectUris,
} from "../src/lib/oidc/redirect-uris.ts";

test("the three accepted shapes", () => {
  assert.deepEqual(
    classifyRedirectUri("https://app.example.com/oauth/callback"),
    {
      ok: true,
      kind: "https",
    },
  );
  assert.deepEqual(classifyRedirectUri("http://127.0.0.1:0/callback"), {
    ok: true,
    kind: "loopback",
  });
  assert.deepEqual(classifyRedirectUri("http://[::1]:49152/callback"), {
    ok: true,
    kind: "loopback",
  });
  assert.deepEqual(classifyRedirectUri("com.example.tutor:/oauth/callback"), {
    ok: true,
    kind: "private_scheme",
  });
});

test("each refusal names its own reason", () => {
  const cases = {
    "": "required",
    "https://app.example.com/cb#f": "fragment",
    "https://app.example.com/cb?x=1": "query",
    "app.example.com/cb": "notAbsolute",
    "https://user:pw@app.example.com/cb": "credentials",
    "http://localhost:8080/cb": "localhost",
    "http://LOCALHOST/cb": "localhost",
    "http://example.com/cb": "httpNotLoopback",
    "http://127.0.0.1:99999/cb": "badPort",
    "http://127.0.0.1:0": "loopbackNoPath",
    "https:///cb": "httpsNoHost",
    "https://127.0.0.1/cb": "httpsLoopback",
    "https://localhost/cb": "httpsLoopback",
    "myapp:/cb": "badScheme",
    "com.example.app://cb": "privateSchemeSlashes",
    "com.example.app:cb": "privateSchemeNoPath",
    "https://a.example.com/cb https://b.example.com/cb": "whitespace",
  };
  for (const [uri, problem] of Object.entries(cases)) {
    assert.deepEqual(classifyRedirectUri(uri), { ok: false, problem }, uri);
  }
});

test("confidential clients may register https only, and a URI appears once", () => {
  const lines = validateRedirectUris(
    [
      "https://api.example.com/cb",
      "http://127.0.0.1:0/cb",
      "com.example.app:/cb",
      "https://api.example.com/cb",
    ],
    "confidential",
  );
  assert.deepEqual(
    lines.map((line) => (line.verdict.ok ? "ok" : line.verdict.problem)),
    ["ok", "confidentialHttpsOnly", "confidentialHttpsOnly", "duplicate"],
  );
  const publicLines = validateRedirectUris(
    ["http://127.0.0.1:0/cb", "com.example.app:/cb"],
    "public",
  );
  assert.equal(
    publicLines.every((line) => line.verdict.ok),
    true,
  );
});

test("the textarea is one URI per line, blanks ignored", () => {
  assert.deepEqual(
    redirectUriLines("  https://a.example.com/cb \r\n\n com.example.app:/cb\n"),
    ["https://a.example.com/cb", "com.example.app:/cb"],
  );
});
