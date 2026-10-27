//identity stability across authentication hydration.
//
// The vote button is visible while the auth store is still `unknown`, so the
// common cold-load click runs with `$currentUser === null`. An idempotency key
// minted at that moment goes into a bucket named for a placeholder actor;
// `ensureAuthenticated()` then resolves the real user and the POST debits 1 2Z.
// If that response is lost, the next click derives the REAL identity, opens a
// different bucket, mints a different UUID, and the server treats it as a new
// purchase: debited and voted twice.
//
// The source-order test in payment-idempotency-races.test.mjs pins WHERE the
// key is derived. This file pins the PROPERTY that ordering exists for, by
// running the component's real handler: click while unhydrated, lose the
// response, click again hydrated, and the same key must go out both times.
//
// The handler runs as written. The `<script>` block is transpiled and
// evaluated with its imports replaced by stubs — except the idempotency store,
// which is the real module over a fake localStorage — so a change to the
// handler's ordering, its actor, or its guard is exercised, not pattern-
// matched.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

import {
  clearIntentIdempotencyKey,
  isIdempotencyStorageCleanupFailure,
  isIdempotencyStorageUnavailable,
  intentIdempotencyKey,
  storedIntentIdempotencyKey,
  intentIdempotencySnapshot,
} from "../src/lib/subscribe-idempotency.js";
import { readApiError } from "../src/lib/api/api-errors.js";
import { requestTimeoutMessage } from "../src/lib/api/request-timeout.js";

const root = new URL("../", import.meta.url);
const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, root)), "utf8");

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Minimal in-memory `localStorage`. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    keys: () => [...map.keys()],
  };
}

/**
 * Evaluate a legacy-mode (`export let`) Svelte component's `<script>` and
 * return the named handlers. Imports are stripped and supplied through
 * `deps`; `export let` props are read from `props`; `$store` auto-
 * subscriptions must be installed by the caller as global getters.
 */
function loadHandlers(relative, deps, props, handlerNames) {
  deps.captureAccountToast ??= () => ({ ...deps.toast, isCurrent: () => true });
  deps.authStore.captureRequestOwnership ??= () => () => true;
  const svelte = read(relative);
  const match = svelte.match(/<script lang="ts">([\s\S]*?)<\/script>/);
  assert.ok(match, `${relative}: no <script lang="ts"> block`);
  let script = match[1];
  script = script.replace(/^\s*import\b[\s\S]*?from\s+"[^"]+";[ \t]*$/gm, "");
  script = script.replace(
    /^(\s*)export let (\w+)(?::[^=;]+?)?(\s*=\s*[^;]+)?;/gm,
    (_, indent, name, init) =>
      `${indent}let ${name} = "${name}" in __props ? __props.${name} : (${
        init ? init.replace(/^\s*=\s*/, "") : "undefined"
      });`,
  );
  assert.doesNotMatch(
    script,
    /^\s*(import|export)\b/m,
    "leftover module syntax",
  );
  const js = ts.transpileModule(script, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const factory = new Function(
    "__deps",
    "__props",
    `const { ${Object.keys(deps).join(", ")} } = __deps;\n${js}\nreturn { ${handlerNames.join(", ")} };`,
  );
  return factory(deps, props);
}

/** Install `$name` as a live global getter for the duration of a test. */
function installStoreGlobal(t, name, get) {
  const had = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, get });
  t.after(() => {
    if (had) Object.defineProperty(globalThis, name, had);
    else delete globalThis[name];
  });
}

function installBrowserStorage(t, storage) {
  const originalWindow = globalThis.window;
  const originalLocal = globalThis.localStorage;
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  globalThis.window = /** @type {any} */ ({});
  globalThis.localStorage = /** @type {any} */ (storage);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      // The component handler tests do not exercise cross-tab scheduling;
      // browser coverage uses Chromium's real Web Locks implementation.
      locks: { request: async (_name, callback) => callback() },
    },
  });
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalLocal === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocal;
    if (originalNavigator)
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("CommentVote sends the same Idempotency-Key for the unhydrated click and the hydrated retry", async (t) => {
  const storage = fakeStorage();
  installBrowserStorage(t, storage);

  // The auth store as the component sees it: `$currentUser` is null until
  // `ensureAuthenticated()` has resolved, exactly like a cold load with a
  // valid session cookie.
  const auth = { creator: null };
  installStoreGlobal(t, "$currentUser", () => auth.creator);
  installStoreGlobal(t, "$t", () => (_key, fallback) => fallback);

  /** @type {string[]} Idempotency-Key header of every POST that went out. */
  const sent = [];
  let network = "lost";
  const toasts = [];
  const logged = [];

  const { handleVote } = loadHandlers(
    "src/lib/components/comments/CommentVote.svelte",
    {
      console: { error: (...args) => logged.push(args) },
      onDestroy: () => {},
      authStore: {
        ensureAuthenticated: async () => {
          // Hydration happens HERE, after the click, before the POST.
          auth.creator = { username: "alice" };
          return true;
        },
        ensureCSRFToken: async () => "csrf",
        handleAuthFailure: () => false,
      },
      currentUser: {},
      env: {},
      toast: {
        error: (message) => toasts.push(["error", message]),
        success: (message) => toasts.push(["success", message]),
      },
      formatLocalizedNumber: (n) => String(n),
      locale: {},
      insufficientFundsFromResponse: async () => null,
      clearIntentIdempotencyKey,
      isIdempotencyStorageCleanupFailure,
      isIdempotencyStorageUnavailable,
      intentIdempotencyKey,
      readApiError,
      requestTimeoutMessage,
      // The vote goes through `apiFetch`; CSRF is apiFetch's job.
      apiFetch: async (_url, init) => {
        sent.push(init.headers["Idempotency-Key"]);
        if (network === "lost") throw new TypeError("Failed to fetch");
        return jsonResponse({ tuzis: 2 });
      },
    },
    { comment: { uuid: "comment-1", tuzis: 1 } },
    ["handleVote"],
  );

  // 1. Click before the store hydrates. The debit commits server-side; the
  //    response is lost.
  assert.equal(auth.creator, null, "precondition: unhydrated");
  await handleVote("up");
  assert.equal(sent.length, 1, "the vote must have been POSTed");
  const [firstKey] = sent;
  assert.match(firstKey, UUID_V4);
  assert.deepEqual(toasts.at(-1), ["error", "Vote failed"]);
  assert.equal(logged.length, 1, "the lost response is logged once");
  assert.match(String(logged[0][0]), /Failed to fetch/);

  // Nothing may have been stored under a placeholder identity.
  for (const name of storage.keys()) {
    assert.doesNotMatch(
      decodeURIComponent(name),
      /"actor":"(?:unknown|anonymous|null|undefined|)"/,
      `placeholder actor bucket: ${name}`,
    );
  }

  // 2. Click again, hydrated. This is the retry the key exists for.
  assert.equal(auth.creator.username, "alice", "precondition: hydrated");
  network = "ok";
  await handleVote("up");
  assert.equal(sent.length, 2);
  assert.equal(
    sent[1],
    firstKey,
    "the hydrated retry must replay the unhydrated click's key, or it is a second charge",
  );
  assert.deepEqual(
    toasts.filter(([kind]) => kind === "error").length,
    1,
    "the successful retry must not toast an error",
  );

  // 3. The purchase settled, so the NEXT vote is a new one.
  await handleVote("up");
  assert.equal(sent.length, 3);
  assert.notEqual(sent[2], firstKey, "a settled key must be retired");
  assert.match(sent[2], UUID_V4);
});

test("CommentVote never POSTs, and never mints, when authentication does not resolve to a user", async (t) => {
  const storage = fakeStorage();
  installBrowserStorage(t, storage);
  installStoreGlobal(t, "$currentUser", () => null);
  installStoreGlobal(t, "$t", () => (_key, fallback) => fallback);

  const sent = [];
  const toasts = [];
  const { handleVote } = loadHandlers(
    "src/lib/components/comments/CommentVote.svelte",
    {
      console: { error: () => {} },
      onDestroy: () => {},
      authStore: {
        // A session that answers "yes" while the creator is still null is the
        // hydration window itself; the guard must treat it as not signed in.
        ensureAuthenticated: async () => true,
        ensureCSRFToken: async () => "csrf",
        handleAuthFailure: () => false,
      },
      currentUser: {},
      env: {},
      toast: {
        error: (message) => toasts.push(["error", message]),
        success: (message) => toasts.push(["success", message]),
      },
      formatLocalizedNumber: (n) => String(n),
      locale: {},
      insufficientFundsFromResponse: async () => null,
      clearIntentIdempotencyKey,
      isIdempotencyStorageCleanupFailure,
      isIdempotencyStorageUnavailable,
      intentIdempotencyKey,
      readApiError,
      requestTimeoutMessage,
      // The vote goes through `apiFetch`; CSRF is apiFetch's job.
      apiFetch: async (_url, init) => {
        sent.push(init.headers["Idempotency-Key"]);
        return jsonResponse({ tuzis: 2 });
      },
    },
    { comment: { uuid: "comment-1", tuzis: 1 } },
    ["handleVote"],
  );

  await handleVote("down");
  assert.equal(sent.length, 0, "no identity, no charge");
  assert.deepEqual(storage.keys(), [], "no identity, no key");
  assert.deepEqual(toasts, [["error", "Please log in to vote"]]);
});

test("AI cover preserves the returned image when settlement storage becomes read-only", async (t) => {
  const storage = fakeStorage();
  installBrowserStorage(t, storage);
  installStoreGlobal(t, "$currentUser", () => ({ id: 42, username: "alice" }));
  installStoreGlobal(t, "$t", () => (_key, fallback) => fallback);
  installStoreGlobal(t, "$toastPresentation", () => ({ generation: 1 }));
  const warnings = [];
  let completed = 0;
  let sentKey;
  let sentBody;
  const chosen = [];
  const choice = {
    id: "openai-image",
    provider: "openai",
    model: "fixture-image-model",
    display_name: "Fixture image model",
    destination: "OpenAI",
    privacy_policy_url: "https://openai.com/policies/privacy-policy/",
    snapshot_token: "signed-fixture-snapshot",
    price_2z: 6,
    availability: "Configured; checked again at submission.",
    queue: "Processed synchronously; no queue position or SLA.",
  };
  const props = {
    apiBase: "",
    buildMediaUrl: (path) => path,
    onGenerated: () => completed++,
    onChoose: (file, prompt) => chosen.push([file, prompt]),
  };
  const handlers = loadHandlers(
    "src/lib/components/mdEditor/CoverAIPanel.svelte",
    {
      $props: () => props,
      $state: (value) => value,
      $derived: Object.assign((value) => value, { by: (compute) => compute() }),
      $effect: () => {},
      ProviderEnum: { openai: "openai" },
      providerLabel: (value) => value,
      onDestroy: () => {},
      onMount: () => {},
      authStore: { ensureAuthenticated: async () => true },
      currentUser: {},
      insufficientFundsFromResponse: async () => null,
      clearIntentIdempotencyKey,
      intentIdempotencyKey,
      isIdempotencyStorageCleanupFailure,
      isIdempotencyStorageUnavailable,
      toast: { error: (message) => warnings.push(message) },
      intentIdempotencySnapshot,
      storedIntentIdempotencyKey,
      apiFetch: async (_url, init) => {
        sentKey = init.headers["Idempotency-Key"];
        sentBody = JSON.parse(init.body);
        storage.removeItem = () => {
          throw new Error("storage became read-only");
        };
        return jsonResponse({ url: "/generated-cover.png" });
      },
      fetch: async () =>
        new Response(new Blob(["image fixture"], { type: "image/png" })),
    },
    {},
    [
      "generateImage",
      "setPrompt: (value) => { prompt = value; }",
      "setChoice: (value) => { choices = [value]; selectedChoice = value.id; selectedModel = value; }",
      "getFile: () => generatedFile",
      "chooseGeneratedImage",
      "revokePreviewUrl",
    ],
  );
  handlers.setPrompt("a garden");
  handlers.setChoice(choice);
  await handlers.generateImage();
  assert.equal(completed, 1, "confirmed generation must reach its caller");
  assert.ok(
    handlers.getFile() instanceof File,
    "paid image remains selectable",
  );
  assert.equal(sentBody.choice, choice.id);
  assert.equal(sentBody.choice_snapshot, choice.snapshot_token);
  await handlers.chooseGeneratedImage();
  assert.deepEqual(chosen, [[handlers.getFile(), "a garden"]]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Check the request's outcome/);
  assert.ok(
    storage.keys().some((key) => storage.getItem(key) === sentKey),
    "retry evidence survives",
  );
  handlers.revokePreviewUrl();
});

test("AI cover keeps the legacy body when replaying an adopted pre-choice key", async (t) => {
  const storage = fakeStorage();
  installBrowserStorage(t, storage);
  installStoreGlobal(t, "$currentUser", () => ({ id: 42, username: "alice" }));
  installStoreGlobal(t, "$t", () => (_key, fallback) => fallback);
  installStoreGlobal(t, "$toastPresentation", () => ({ generation: 1 }));
  const choice = {
    id: "openai-image",
    provider: "openai",
    model: "fixture-image-model",
    display_name: "Fixture image model",
    destination: "OpenAI",
    privacy_policy_url: "https://openai.com/policies/privacy-policy/",
    snapshot_token: "signed-fixture-snapshot",
    price_2z: 6,
    availability: "Configured; checked again at submission.",
    queue: "Processed synchronously; no queue position or SLA.",
  };
  let sentKey;
  let sentHeaders;
  let sentBody;
  const props = {
    apiBase: "",
    buildMediaUrl: (path) => path,
    onGenerated: () => {},
    onChoose: () => {},
  };
  const handlers = loadHandlers(
    "src/lib/components/mdEditor/CoverAIPanel.svelte",
    {
      $props: () => props,
      $state: (value) => value,
      $derived: Object.assign((value) => value, { by: (compute) => compute() }),
      $effect: () => {},
      onDestroy: () => {},
      onMount: () => {},
      authStore: { ensureAuthenticated: async () => true },
      currentUser: {},
      insufficientFundsFromResponse: async () => null,
      clearIntentIdempotencyKey,
      intentIdempotencyKey,
      storedIntentIdempotencyKey,
      intentIdempotencySnapshot,
      isIdempotencyStorageCleanupFailure,
      isIdempotencyStorageUnavailable,
      toast: { error: () => {} },
      apiFetch: async (_url, init) => {
        sentKey = init.headers["Idempotency-Key"];
        sentHeaders = init.headers;
        sentBody = JSON.parse(init.body);
        return jsonResponse({ url: "/generated-cover.png" });
      },
      fetch: async () =>
        new Response(new Blob(["image fixture"], { type: "image/png" })),
    },
    {},
    [
      "generateImage",
      "setPrompt: (value) => { prompt = value; }",
      "setChoice: (value) => { choices = [value]; selectedChoice = value.id; selectedModel = value; }",
      "getLegacyIntent: () => ({ actor: $currentUser.username, action: 'ai_image', resource: '/api/openai/image', amount: '6', intent: JSON.stringify({ prompt: `${prompt.trim()}\n\n${COVER_COMPOSITION_GUIDANCE}`, size: '1536x1024' }) })",
    ],
  );
  handlers.setPrompt("a garden");
  handlers.setChoice(choice);
  const legacyKey = intentIdempotencyKey(handlers.getLegacyIntent(), {
    storage,
  });

  await handlers.generateImage();

  assert.equal(sentKey, legacyKey);
  assert.equal(sentHeaders["X-Expected-Actor"], "42");
  assert.equal(sentHeaders["X-Require-Existing-Receipt"], "true");
  assert.deepEqual(sentBody, {
    prompt: handlers.getLegacyIntent().intent
      ? JSON.parse(handlers.getLegacyIntent().intent).prompt
      : "",
    size: "1536x1024",
  });
  assert.equal("choice" in sentBody, false);
  assert.equal("choice_snapshot" in sentBody, false);
});
