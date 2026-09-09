import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker: ${end}`);
  return source.slice(from, to);
}

// Parse the declaration being checked, not a neighboring comment or method.
// Include parameters as well as the body: default arguments can publish tokens.
function declarationSource(source, name, objectName) {
  const file = ts.createSourceFile("boundary.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(file.parseDiagnostics.length, 0, "auth source must parse before its boundary is checked");
  const named = (node, expected) => node.name &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === expected;
  let declarations;
  if (objectName) {
    const owners = file.statements.filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .filter((node) => named(node, objectName));
    assert.equal(owners.length, 1, `expected exactly one top-level ${objectName} declaration`);
    const initializer = owners[0].initializer;
    assert.ok(initializer && ts.isObjectLiteralExpression(initializer), `${objectName} must be an object literal`);
    declarations = initializer.properties.filter((node) => ts.isMethodDeclaration(node) && named(node, name));
  } else {
    declarations = file.statements.filter((node) => ts.isFunctionDeclaration(node) && named(node, name));
  }
  assert.equal(declarations.length, 1, `expected exactly one ${objectName ? `${objectName}.` : ""}${name} declaration`);
  assert.ok(declarations[0].body, `${name} must have a body`);
  return declarations[0].getText(file);
}

function assertNoTokenPublication(source) {
  assert.doesNotMatch(source, /\bsetToken\s*\(/);
  assert.doesNotMatch(source, /localStorage\s*\./);
}

function assertOAuthCompletion(completion) {
  assert.match(completion, /return withOAuthSession<SocialAuthResult>\(capture/);
  assert.match(completion, /authToken: lease\.initiatingToken \?\? undefined/);
  assert.match(completion, /auth\.me\(lease\.initiatingToken \?\? undefined, lease\.signal\)/);
  assert.match(completion, /signal: lease\.signal/);
}

test("awaited raw login helpers cannot publish the global token", () => {
  const api = readFileSync(new URL("../src/lib/api/free2z.ts", import.meta.url), "utf8");
  const transport = readFileSync(new URL("../src/lib/api/http.ts", import.meta.url), "utf8");
  const rawHelpers = [
    declarationSource(api, "login", "auth"),
    declarationSource(api, "completeOtp", "auth"),
    declarationSource(api, "zcashLogin", "auth"),
    declarationSource(api, "completeSocialOAuth", "auth"),
    declarationSource(transport, "basicLogin"),
  ];

  for (const helper of rawHelpers) {
    assertNoTokenPublication(helper);
  }
});

test("uncommitted profile probes use a private explicit token header", () => {
  const transport = readFileSync(new URL("../src/lib/api/http.ts", import.meta.url), "utf8");
  const requestBody = declarationSource(transport, "request");

  assert.match(requestBody, /opts\.authToken \?\? getToken\(\)/);
  assert.match(requestBody, /headers\["Authorization"\] = `Token \$\{token\}`/);
});

test("every social OAuth transport pins completion to its initiating session", () => {
  const api = readFileSync(new URL("../src/lib/api/free2z.ts", import.meta.url), "utf8");
  const transport = readFileSync(
    new URL("../src/lib/oauth/transport.ts", import.meta.url),
    "utf8",
  );
  const completion = declarationSource(api, "completeSocialOAuth", "auth");

  assert.match(transport, /sessionBinding: string/);
  assert.match(transport, /transport: OAuthCallbackTransport/);
  assert.match(transport, /onTokenChange\(\(\) => controller\.abort\(\)\)/);
  assert.match(transport, /export async function withOAuthSession/);
  assert.doesNotMatch(transport, /assertMobileOAuthSession/);
  assertOAuthCompletion(completion);

  const logout = declarationSource(api, "logout", "auth");
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
    /clearPhrase\(\);[\s\S]*?await useWallet\.getState\(\)\.refreshWalletIdentity\(restored\.walletId\);[\s\S]*?if \(!isCurrent\(\)\) return;[\s\S]*?await runCrypto/,
  );
  const committedRestoreBeforeRefresh = between(
    restoreFlow,
    "const restored = await restoration;",
    "await useWallet.getState().refreshWalletIdentity(restored.walletId);",
  );
  assert.doesNotMatch(committedRestoreBeforeRefresh, /isCurrent\(\)/);
  assert.doesNotMatch(form, /await onRestore\(/);
});

test("auth method boundaries survive removal or renaming of unrelated section headers", () => {
  const api = readFileSync(new URL("../src/lib/api/free2z.ts", import.meta.url), "utf8");
  const original = declarationSource(api, "completeSocialOAuth", "auth");
  const fixture = `export const auth = {\n  ${original}\n};\n\n// ─── Tuzi\nconst unrelated = {};`;
  for (const replacement of ["", "// Renamed unrelated section"]) {
    const changed = fixture.replace(/\/\/ ─── Tuzi[^\n]*/, replacement);
    assert.notEqual(changed, fixture, "negative control must actually change the former marker");
    const completion = declarationSource(changed, "completeSocialOAuth", "auth");
    assert.equal(completion, original);
    assertNoTokenPublication(completion);
    assertOAuthCompletion(completion);
  }
});

test("declaration discovery ignores nested braces, marker text and unrelated methods", () => {
  const method = 'async completeSocialOAuth() { const text = "};\\n\\n// ─── Tuzi"; const close = /}/; return (() => ({ text, close }))(); }';
  for (const properties of [
    `${method}, logout() { setToken(null); }`,
    `logout() { setToken(null); }, ${method}`,
  ]) {
    const source = `const decoy = { completeSocialOAuth() { setToken("unsafe"); } }; export const auth = { ${properties} };`;
    assert.equal(declarationSource(source, "completeSocialOAuth", "auth"), method);
    assertNoTokenPublication(declarationSource(source, "completeSocialOAuth", "auth"));
  }
});

test("declaration discovery fails closed on missing, ambiguous or invalid source", () => {
  for (const source of [
    'const other = { completeSocialOAuth() {} };',
    'function nested() { const auth = { completeSocialOAuth() {} }; }',
    'const auth = { anotherMethod() {} };',
    'const auth = { completeSocialOAuth() {}, completeSocialOAuth() {} };',
    'const auth = { completeSocialOAuth() {} }; const auth = { completeSocialOAuth() {} };',
    'const auth = somethingElse;',
    'const auth = { completeSocialOAuth() {',
  ]) assert.throws(() => declarationSource(source, "completeSocialOAuth", "auth"));
});

test("token publication and missing OAuth session binding still fail inside discovered methods", () => {
  for (const method of [
    'async completeSocialOAuth() { setToken("unsafe"); }',
    'async completeSocialOAuth() { localStorage.setItem("token", "unsafe"); }',
    'async completeSocialOAuth(token = setToken("unsafe")) { return token; }',
  ]) {
    const source = `export const auth = { ${method} };`;
    assert.throws(() => assertNoTokenPublication(declarationSource(source, "completeSocialOAuth", "auth")));
  }
  const api = readFileSync(new URL("../src/lib/api/free2z.ts", import.meta.url), "utf8");
  const changed = api.replace("return withOAuthSession<SocialAuthResult>(capture", "return anotherSession<SocialAuthResult>(capture");
  assert.notEqual(changed, api);
  assert.throws(() => assertOAuthCompletion(declarationSource(changed, "completeSocialOAuth", "auth")));
});
