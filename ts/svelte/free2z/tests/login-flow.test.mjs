import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

//  every "log in" dead end in the new UI pointed at `/?login=true`,
// which nothing read: the visitor lost the page they were on and got no login.
// Public pages now open the shared modal IN PLACE (`$lib/stores/auth-modal`),
// and server guards redirect to the real `/login` with a safe `?next=`
// (`$lib/login-destination`). These tests pin the contract at the source and
// exercise the pure helpers and the real loaders; the browser half lives in
// tests/browser/converse-composer.spec.ts, login-return-path.spec.ts and
// logout-stay-put.spec.ts.
//
//  logout keeps the visitor on a public page (a full document reload)
// and only leaves for `/` when the page needs a session; the classifier is
// `$lib/logout-destination`, fail-safe by default.
//
//  the email-change surface says, before and after, that replacing or
// removing a confirmed address signs the account out everywhere.

const UI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = path.join(UI_ROOT, "src");

function read(relative) {
  return fs.readFileSync(path.join(UI_ROOT, relative), "utf8");
}

function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
}

let vite;
let loginDestination;
let LOGIN_DESTINATION;
let parseLoginReason;
let logoutDestination;
let requireAuthenticatedUser;
let settingsLoad;
let billingActions;
let editLoad;

const previousApiBase = process.env.PRIVATE_API_BASE_URL;

before(async () => {
  process.env.PRIVATE_API_BASE_URL = "https://api.free2z.test";
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  ({ loginDestination, LOGIN_DESTINATION, parseLoginReason } =
    await vite.ssrLoadModule("/src/lib/login-destination.ts"));
  ({ logoutDestination } = await vite.ssrLoadModule(
    "/src/lib/logout-destination.ts",
  ));
  ({ requireAuthenticatedUser } = await vite.ssrLoadModule(
    "/src/lib/server/backend.ts",
  ));
  ({ load: settingsLoad } = await vite.ssrLoadModule(
    "/src/routes/[username]/dashboard/settings/+page.server.ts",
  ));
  ({ actions: billingActions } = await vite.ssrLoadModule(
    "/src/routes/[username]/dashboard/billing/+page.server.ts",
  ));
  ({ load: editLoad } = await vite.ssrLoadModule("/src/routes/edit/+page.ts"));
});

after(async () => {
  await vite?.close();
  if (previousApiBase === undefined) {
    delete process.env.PRIVATE_API_BASE_URL;
  } else {
    process.env.PRIVATE_API_BASE_URL = previousApiBase;
  }
});

async function redirectFrom(fn) {
  try {
    await fn();
  } catch (thrown) {
    if (thrown && typeof thrown.status === "number" && thrown.location) {
      return { status: thrown.status, location: thrown.location };
    }
    throw thrown;
  }
  assert.fail("expected a redirect to be thrown");
}

// --- the source invariant ----------------------------------------------------

test("no executable or documentary `login=true` survives anywhere under src/", () => {
  // The cheap invariant the issue asked for: the sentinel must not come back,
  // in code OR in a comment that would teach the next reader it is a thing.
  const offenders = walk(SRC)
    .filter((file) => !file.includes(`${path.sep}lib${path.sep}api${path.sep}`))
    .filter((file) => read(path.relative(UI_ROOT, file)).includes("login=true"))
    .map((file) => path.relative(UI_ROOT, file));
  assert.deepEqual(offenders, []);
});

test("the always-allow auth-guards module is gone", () => {
  assert.equal(
    fs.existsSync(path.join(SRC, "lib/utils/auth-guards.ts")),
    false,
  );
  const offenders = walk(SRC)
    .filter((file) => /\.(ts|svelte|js)$/.test(file))
    .filter((file) =>
      /\bhasPermission\b|auth-guards/.test(read(path.relative(UI_ROOT, file))),
    )
    .map((file) => path.relative(UI_ROOT, file));
  assert.deepEqual(offenders, []);
});

// --- one modal, opened in place --------------------------------------------

test("the root layout mounts the single AuthModalHost and the navbar button is a caller", () => {
  const layout = read("src/routes/+layout.svelte");
  assert.match(
    layout,
    /import AuthModalHost from "\$lib\/components\/auth\/AuthModalHost\.svelte"/,
  );
  assert.match(layout, /<AuthModalHost \/>/);

  const button = read("src/lib/components/auth/AuthButton.svelte");
  assert.match(
    button,
    /requestLogin\(\{ trigger: e\.currentTarget as HTMLElement \}\)/,
  );
  assert.doesNotMatch(button, /UnifiedAuthModal|OTPModal/);

  // The host carries the password → OTP contract, captcha_result included.
  const host = read("src/lib/components/auth/AuthModalHost.svelte");
  assert.match(host, /captchaResult=\{otpData\.captcha_result\}/);
  assert.match(
    host,
    /on:requiresOTP=\{\(event\) => handleAuthRequiresOTP\(event, requestId\)\}/,
  );
  assert.match(host, /on:back=\{\(\) => handleOTPBack\(requestId\)\}/);
});

test("every public-page login CTA opens the modal in place instead of navigating", () => {
  for (const [file, testId] of [
    [
      "src/lib/components/converse/ConverseComposer.svelte",
      "converse-login-prompt",
    ],
    ["src/lib/components/comments/CommentForm.svelte", "comment-login-prompt"],
    ["src/lib/components/profile/ProfileDonate.svelte", "donate-login-prompt"],
  ]) {
    const source = read(file);
    assert.match(
      source,
      /import \{ requestLogin \} from "\$lib\/stores\/auth-modal"/,
      file,
    );
    // A real link to the real login page (the pre-hydration fallback, and
    // it comes back here) whose click handler cancels the navigation and
    // opens the modal instead: hydrated, the control must not change
    // pathname, query, hash, scroll or history.
    // `[^>]` alone would stop at the `=>` of the arrow handler.
    const control = source.match(
      new RegExp(
        `<Button(?:=>|[^>])*data-testid="${testId}"(?:=>|[^>])*>`,
        "s",
      ),
    );
    assert.ok(control, `${file} renders ${testId}`);
    assert.match(
      control[0],
      /href=\{loginDestination\(\$page\.url\.pathname \+ \$page\.url\.search\)\}/,
      file,
    );
    assert.match(
      control[0],
      /onclick=\{\(e\) => \{\s*e\.preventDefault\(\);\s*requestLogin\(\{ trigger: e\.currentTarget \}\);\s*\}\}/,
      file,
    );
    assert.doesNotMatch(control[0], /href="/, file);
  }

  const bell = read("src/lib/components/layout/NotificationBell.svelte");
  assert.match(bell, /requestLogin\(\);/);
  assert.doesNotMatch(bell, /goto\("\/\?login/);
});

test("an expired session in the editor opens the modal over the draft rather than leaving it", () => {
  const editor = read("src/routes/edit/+page.svelte");
  const branch = editor.match(
    /if \(response\.status === 401 \|\| response\.status === 403\) \{([\s\S]*?)return failSave\("auth-required"\);/,
  );
  assert.ok(branch, "the 401/403 branch after a save exists");
  assert.match(branch[1], /authStore\.handleAuthFailure\(response\.status\)/);
  assert.match(branch[1], /promptOwnerSignIn\("auth-required"\)/);
  assert.doesNotMatch(branch[1], /goto\(/);

  // And the prompt it calls opens the SHARED modal in place, with copy for
  // both the expired-session and the wrong-account cases.
  const prompt = editor.match(
    /function promptOwnerSignIn\(reason: SaveBlockReason\) \{([\s\S]*?)\n  \}\n/,
  );
  assert.ok(prompt, "promptOwnerSignIn exists");
  assert.match(prompt[1], /requestLogin\(\{/);
  assert.match(prompt[1], /editor\.saveBlockedAuth/);
  assert.match(prompt[1], /editor\.saveBlockedWrongAccount/);
  assert.doesNotMatch(prompt[1], /goto\(/);
});

test("the editor refuses to save a draft under an account that did not open it", () => {
  const editor = read("src/routes/edit/+page.svelte");
  // Fail CLOSED: a login POST that succeeds and an identity fetch that then
  // fails leaves the OTHER account's cookie installed and `$currentUser`
  // null, so null must not read as permission to save.
  assert.match(editor, /const cannotSaveAsOwner = \$derived\(!ownerSignedIn\)/);
  // …and the gate runs before anything is sent, at the top of handleSave.
  const gate = editor.match(
    /async function handleSave\(options: SaveOptions = \{\}\): Promise<boolean> \{([\s\S]*?)if \(isDeletingTranslation\)/,
  );
  assert.ok(gate, "handleSave's preamble exists");
  assert.match(gate[1], /if\s*\(!confirmSaveOwner\(options\)\)\s*return false/);
  const ownerCheck = editor.match(
    /function confirmSaveOwner\(options: SaveOptions\): boolean \{([\s\S]*?)\n  \}/,
  );
  assert.ok(ownerCheck, "the shared ownership check exists");
  assert.match(ownerCheck[1], /if\s*\(!cannotSaveAsOwner\)\s*return true/);
  assert.match(ownerCheck[1], /return failSave\(reason\)/);
});

// --- the return path ---------------------------------------------------------

test("loginDestination builds /login with a safe next and an allow-listed reason", () => {
  assert.equal(LOGIN_DESTINATION, "/login");
  assert.equal(loginDestination(), "/login");
  assert.equal(loginDestination(null), "/login");
  assert.equal(
    loginDestination("/alice/dashboard/billing?tab=stripe&checkoutRef=abc"),
    "/login?next=%2Falice%2Fdashboard%2Fbilling%3Ftab%3Dstripe%26checkoutRef%3Dabc",
  );
  assert.equal(
    loginDestination("/edit?id=42"),
    "/login?next=%2Fedit%3Fid%3D42",
  );
  // Open-redirect shapes are dropped, not sanitised: the visitor still gets
  // a login page, just no return trip.
  assert.equal(loginDestination("https://evil.test/steal"), "/login");
  assert.equal(loginDestination("//evil.test/steal"), "/login");
  assert.equal(loginDestination("/\\evil.test/steal"), "/login");
  assert.equal(loginDestination("/%5Cevil.test/steal"), "/login");
  assert.equal(
    loginDestination("/alice/dashboard/settings", "email-changed"),
    "/login?next=%2Falice%2Fdashboard%2Fsettings&reason=email-changed",
  );
  assert.equal(
    loginDestination(null, "session-expired"),
    "/login?reason=session-expired",
  );
});

test("parseLoginReason only admits the reasons the login page can explain", () => {
  assert.equal(parseLoginReason("email-changed"), "email-changed");
  assert.equal(parseLoginReason("email-removed"), "email-removed");
  assert.equal(parseLoginReason("session-expired"), "session-expired");
  assert.equal(parseLoginReason("reauthenticate"), "reauthenticate");
  assert.equal(parseLoginReason("confirm-limit"), "confirm-limit");
  assert.equal(parseLoginReason("You have been hacked, call +1-800"), null);
  assert.equal(parseLoginReason(""), null);
  assert.equal(parseLoginReason(null), null);
  assert.equal(parseLoginReason("__proto__"), null);
});

test("requireAuthenticatedUser redirects to /login with the caller's return path", async () => {
  const noCookie = { get: () => undefined };
  assert.deepEqual(
    await redirectFrom(() =>
      requireAuthenticatedUser(
        async () => new Response("{}"),
        noCookie,
        "/alice/dashboard/kyc",
      ),
    ),
    { status: 302, location: "/login?next=%2Falice%2Fdashboard%2Fkyc" },
  );

  const staleCookie = {
    get: (name) => (name === "sessionid" ? "stale" : undefined),
  };
  const unauthorized = async () => new Response("{}", { status: 401 });
  assert.deepEqual(
    await redirectFrom(() =>
      requireAuthenticatedUser(
        unauthorized,
        staleCookie,
        "/alice/dashboard/kyc",
      ),
    ),
    { status: 302, location: "/login?next=%2Falice%2Fdashboard%2Fkyc" },
  );
  // No return path known: still the real login page, never the homepage.
  assert.deepEqual(
    await redirectFrom(() =>
      requireAuthenticatedUser(unauthorized, staleCookie),
    ),
    {
      status: 302,
      location: "/login",
    },
  );
});

test("an anonymous dashboard load lands on /login and comes back to the page it wanted", async () => {
  const url = new URL("https://free2z.test/alice/dashboard/settings");
  const event = {
    params: { username: "alice" },
    cookies: { get: () => undefined },
    fetch: async () => assert.fail("no cookie, no backend call"),
    url,
    setHeaders: () => {},
  };
  assert.deepEqual(await redirectFrom(() => settingsLoad(event)), {
    status: 302,
    location: "/login?next=%2Falice%2Fdashboard%2Fsettings",
  });

  // An expired cookie is the same answer, and the query string survives.
  const expired = {
    ...event,
    url: new URL("https://free2z.test/alice/dashboard/settings?tab=security"),
    cookies: { get: (name) => (name === "sessionid" ? "expired" : undefined) },
    fetch: async () => new Response("{}", { status: 401 }),
  };
  assert.deepEqual(await redirectFrom(() => settingsLoad(expired)), {
    status: 302,
    location: "/login?next=%2Falice%2Fdashboard%2Fsettings%3Ftab%3Dsecurity",
  });
});

test("an anonymous form action redirects to /login and returns to the PAGE, not the action", async () => {
  const url = new URL("https://free2z.test/alice/dashboard/billing?/checkout");
  const event = {
    params: { username: "alice" },
    cookies: { get: () => undefined },
    fetch: async () => assert.fail("no cookie, no backend call"),
    request: new Request(url, { method: "POST" }),
    url,
  };
  for (const name of ["checkout", "updateSubscription", "unsubscribe"]) {
    assert.deepEqual(
      await redirectFrom(() => billingActions[name](event)),
      { status: 302, location: "/login?next=%2Falice%2Fdashboard%2Fbilling" },
      name,
    );
  }
});

test("the editor's client load sends an expired session to /login and back to the same draft", async () => {
  const url = new URL("https://free2z.test/edit?id=42&lang=fr");
  const event = {
    fetch: async () => new Response("{}", { status: 401 }),
    url,
    parent: async () => ({ locale: "en" }),
  };
  assert.deepEqual(await redirectFrom(() => editLoad(event)), {
    status: 302,
    location: "/login?next=%2Fedit%3Fid%3D42%26lang%3Dfr",
  });
});

test("the login page reads ?reason= through the allow-list and shows it inside the modal", () => {
  const page = read("src/routes/(auth)/login/+page.svelte");
  assert.match(
    page,
    /parseLoginReason\(\$page\.url\.searchParams\.get\("reason"\)\)/,
  );
  assert.match(page, /notice: reasonCopy\(reason\)/);
  assert.match(page, /onSuccess: \(\) => \{\s*goto\(nextPath \|\| "\/"\);/);
  // Never the raw parameter into the DOM.
  assert.doesNotMatch(page, /searchParams\.get\("reason"\)\}/);

  const modal = read("src/lib/components/auth/UnifiedAuthModal.svelte");
  assert.match(modal, /export let notice = "";/);
  assert.match(modal, /data-testid="auth-modal-notice"/);
});

// --- logout: stay put on a public page, full document either way -------------

test("logoutDestination reloads public pages and leaves for / from everything else", () => {
  for (const pathname of [
    "/",
    "/converse",
    "/converse/",
    "/converse/0b8c4e8a-1d2f-4c3b-9a7e-5f6d7c8b9a0e",
    "/creators",
    "/search",
    "/trending",
    "/tag/zcash",
    "/article/42",
    "/live/alice",
    "/alice",
    "/alice/",
    "/alice/my-first-zpage",
    "/a.b_c-d/another-page",
  ]) {
    assert.equal(logoutDestination(pathname), "reload", pathname);
  }

  for (const pathname of [
    // needs a session
    "/alice/dashboard/pages",
    "/alice/dashboard/settings",
    "/alice/dashboard",
    "/alice/broadcast",
    "/edit",
    "/buy-2z",
    // gated listings and capability URLs — never reload a secret
    "/alice/ppv",
    "/alice/subscribers-only",
    "/alice/private/s3cr3t",
    // routes for the unauthenticated, checkout, retired entry points
    "/login",
    "/reset-password",
    "/checkout/abc",
    "/projects/zcash",
    "/begin",
    "/profile",
    // unknown depth or shape: fail-safe
    "/tag/zcash/extra",
    "/alice/page/extra",
    "/alice//page",
    "/alice/../bob",
    "/\\evil.test",
    "",
    "converse",
  ]) {
    assert.equal(logoutDestination(pathname), "home", JSON.stringify(pathname));
  }
});

test("the auth store's logout is still a full document load, on the page's own verdict", () => {
  const store = read("src/lib/stores/auth.ts");
  assert.match(
    store,
    /import \{ logoutDestination \} from "\$lib\/logout-destination"/,
  );
  // Verdict and URL are snapshotted BEFORE the request…
  assert.match(
    store,
    /const startedAt = window\.location\.href;\s*const destination = logoutDestination\(window\.location\.pathname\);[\s\S]*?await apiFetch\("\/api\/auth\/logout\/"/,
  );
  // …and the reload applies only if the URL has not moved since.
  assert.match(
    store,
    /if \(\s*destination === "reload" &&\s*window\.location\.href === startedAt\s*\) \{\s*window\.location\.reload\(\);\s*\} else \{\s*window\.location\.assign\("\/"\);/,
  );
  assert.doesNotMatch(store, /\bgoto\(|invalidateAll\(/);
});

// --- the email-change copy -----------------------------------------------------

test("the email surface warns before, and explains after, a sign-out-everywhere change", () => {
  const settings = read("src/lib/components/settings/AccountSettings.svelte");
  assert.match(settings, /data-testid="email-signout-warning"/);
  assert.match(settings, /settings\.account\.signOutEverywhereWarning/);
  // The warning is gated on a CONFIRMED address: a first add signs nobody out.
  assert.match(
    settings,
    /\{#if hasConfirmedEmail\}[\s\S]*?email-signout-warning/,
  );
  assert.match(
    settings,
    /hasConfirmedEmail = Boolean\(emailStatus\?\.confirmed && emailStatus\.email\)/,
  );
  // Replace-confirmed → login page with the reason; delete-confirmed likewise.
  assert.match(
    settings,
    /const signsOutEverywhere =\s*hasConfirmedEmail && emailStatus\?\.email !== trimmed;[\s\S]*?leaveForLogin\("email-changed"\)/,
  );
  assert.match(
    settings,
    /const signsOutEverywhere = hasConfirmedEmail;[\s\S]*?leaveForLogin\("email-removed"\)/,
  );
  // A new document, like a logout — and the cached store dropped first.
  assert.match(
    settings,
    /authStore\.clear\(\);\s*window\.location\.assign\(\s*loginDestination\(`\/\$\{username\}\/dashboard\/settings`, reason\),/,
  );
});

test("the new copy exists in all four catalogs", () => {
  const keys = [
    ["auth", "signedOut", "emailChanged"],
    ["auth", "signedOut", "emailRemoved"],
    ["auth", "signedOut", "sessionExpired"],
    ["settings", "account", "signOutEverywhereWarning"],
    ["profile", "donate", "logInToSend"],
    ["editor", "saveBlockedWrongAccount"],
  ];
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(read(`src/lib/locales/${locale}.json`));
    for (const key of keys) {
      const value = key.reduce((node, part) => node?.[part], catalog);
      assert.equal(typeof value, "string", `${locale}: ${key.join(".")}`);
      assert.ok(value.trim().length > 0, `${locale}: ${key.join(".")}`);
    }
  }
  const en = JSON.parse(read("src/lib/locales/en.json"));
  assert.match(
    en.settings.account.signOutEverywhereWarning,
    /all your devices/,
  );
  assert.match(en.auth.signedOut.emailChanged, /email address was changed/);
  // The interpolation the notice depends on to name the owner.
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(read(`src/lib/locales/${locale}.json`));
    assert.match(catalog.editor.saveBlockedWrongAccount, /\{owner\}/, locale);
  }
});
