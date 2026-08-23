import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker: ${end}`);
  return source.slice(from, to);
}

test("awaited raw login helpers cannot publish the global token", () => {
  const api = readFileSync(new URL("../src/lib/api/free2z.ts", import.meta.url), "utf8");
  const transport = readFileSync(new URL("../src/lib/api/http.ts", import.meta.url), "utf8");
  const rawHelpers = [
    between(api, "  async login(", "  /** Whether the currently-authenticated"),
    between(api, "  async completeOtp(", "  async me("),
    between(api, "  async zcashLogin(", "  /** Ask the backend"),
    between(api, "  async completeSocialOAuth(", "};\n\n// ─── Profile"),
    between(transport, "export async function basicLogin(", "function safeJson("),
  ];

  for (const helper of rawHelpers) {
    assert.doesNotMatch(helper, /\bsetToken\s*\(/);
    assert.doesNotMatch(helper, /localStorage\s*\./);
  }
});

test("uncommitted profile probes use a private explicit token header", () => {
  const transport = readFileSync(new URL("../src/lib/api/http.ts", import.meta.url), "utf8");
  const requestBody = between(
    transport,
    "export async function request<T>(",
    "/** Knox login:",
  );

  assert.match(requestBody, /opts\.authToken \?\? getToken\(\)/);
  assert.match(requestBody, /headers\["Authorization"\] = `Token \$\{token\}`/);
});

test("every social OAuth transport pins completion to its initiating session", () => {
  const api = readFileSync(new URL("../src/lib/api/free2z.ts", import.meta.url), "utf8");
  const transport = readFileSync(
    new URL("../src/lib/oauth/transport.ts", import.meta.url),
    "utf8",
  );
  const completion = between(
    api,
    "  async completeSocialOAuth(",
    "};\n\n// ─── Profile",
  );

  assert.match(transport, /sessionBinding: string/);
  assert.match(transport, /transport: OAuthCallbackTransport/);
  assert.match(transport, /onTokenChange\(\(token\)/);
  assert.match(transport, /export async function assertOAuthSession/);
  assert.doesNotMatch(transport, /assertMobileOAuthSession/);
  assert.match(completion, /const initiatingToken = await assertOAuthSession\(capture\)/);
  assert.match(completion, /authToken: initiatingToken \?\? undefined/);

  const logout = between(api, "  async logout():", "  /**\n   * Login with Zcash:");
  assert.match(
    logout,
    /const token = getToken\(\);[\s\S]*?setToken\(null\);[\s\S]*?authToken: token \?\? undefined/,
  );
});

test("recovery phrases cannot enter browser persistence, URLs, logs, or toasts", () => {
  const flow = readFileSync(
    new URL("../src/features/auth/useZcashChallengeFlow.ts", import.meta.url),
    "utf8",
  );
  const form = readFileSync(
    new URL("../src/features/auth/RestoreIdentity.tsx", import.meta.url),
    "utf8",
  );
  const restoreFlow = between(
    flow,
    "  const restoreIdentity = useCallback",
    "  const createIdentity = useCallback",
  );

  for (const source of [restoreFlow, form]) {
    assert.doesNotMatch(source, /localStorage\s*\./);
    assert.doesNotMatch(source, /sessionStorage\s*\./);
    assert.doesNotMatch(source, /URLSearchParams|location\.(?:href|search|hash)/);
    assert.doesNotMatch(source, /console\.(?:debug|info|log|warn|error)\s*\(/);
    assert.doesNotMatch(source, /toast\s*\./);
  }

  assert.match(
    restoreFlow,
    /const restoration = wallet\.restoreWallet\([\s\S]*?seedPhrase = "";[\s\S]*?const restored = await restoration;/,
  );
  assert.match(
    restoreFlow,
    /clearPhrase\(\);[\s\S]*?await useWallet\.getState\(\)\.bootstrap\(\);[\s\S]*?if \(!isCurrent\(\)\) return;[\s\S]*?await runCrypto/,
  );
  assert.doesNotMatch(form, /await onRestore\(/);
});
