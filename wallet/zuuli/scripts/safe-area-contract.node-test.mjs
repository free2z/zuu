import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativeUrl) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

const html = source("../index.html");
const css = source("../src/index.css");
const app = source("../src/App.tsx");
const shell = source("../src/components/layout/AppShell.tsx");
const topBar = source("../src/components/layout/TopBar.tsx");
const sidebar = source("../src/components/layout/Sidebar.tsx");
const auth = source("../src/features/auth/index.tsx");
const ai = source("../src/features/ai/index.tsx");
const root = source("../src/main.tsx");
const androidActivity = source(
  "../src-tauri/gen/android/app/src/main/java/cash/free2z/zuuli/MainActivity.kt",
);

function cssRule(className) {
  const match = css.match(new RegExp(`\\.${className}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `missing .${className} CSS rule`);
  return match[1];
}

test("cover is enabled only together with four authoritative inset fallbacks", () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /interactive-widget=resizes-content/);

  for (const side of ["top", "right", "bottom", "left"]) {
    assert.match(
      css,
      new RegExp(
        `--safe-area-${side}: env\\(safe-area-inset-${side}, 0px\\);`,
      ),
    );
  }

  assert.match(cssRule("app-top-bar"), /var\(--safe-area-top\)/);
  assert.match(cssRule("app-bottom-nav"), /var\(--safe-area-bottom\)/);
  assert.match(cssRule("app-viewport"), /var\(--safe-area-left\)/);
  assert.match(cssRule("app-viewport"), /var\(--safe-area-right\)/);
  assert.match(topBar, /className="app-top-bar /);
  assert.match(sidebar, /className="app-bottom-nav /);
  assert.match(topBar, /data-app-top-bar/);
  assert.match(sidebar, /data-app-bottom-nav/);
});

test("the document and app are bounded to one dynamic viewport frame", () => {
  assert.match(css, /html,\s*body,\s*#root\s*\{[^}]*overflow: hidden;/s);
  assert.match(cssRule("app-viewport"), /height: 100dvh;/);
  assert.match(cssRule("app-viewport"), /overflow: hidden;/);
  assert.match(shell, /className="app-viewport flex bg-background"/);
  assert.match(shell, /data-app-frame/);
  assert.match(root, /height: "100dvh"/);

  for (const framingSource of [shell, auth, root]) {
    assert.doesNotMatch(framingSource, /(?:min-h-screen|\bh-screen\b|100vh)/);
  }
});

test("login stays inside pinned chrome with one bounded scroll owner", () => {
  const shellRoute = app.indexOf('<Route element={<AppShell />}>');
  const loginRoute = app.indexOf(
    '<Route path="/login" element={<AuthFeature />} />',
  );
  const catchAll = app.indexOf('<Route path="*" element={<NotFound />} />');

  assert.ok(shellRoute >= 0);
  assert.ok(loginRoute > shellRoute);
  assert.ok(loginRoute < catchAll);
  assert.match(shell, /location\.pathname === "\/login"/);
  assert.equal(auth.match(/overflow-y-auto/g)?.length, 1);
  assert.equal(auth.match(/data-route-scroll/g)?.length, 1);
  assert.equal(shell.match(/data-route-scroll/g)?.length, 1);
  assert.match(auth, /h-full min-h-0/);
  assert.match(shell, /className="min-h-0 flex-1 overflow-hidden"/);
});

test("chrome and full-bleed clearance use centralized variables", () => {
  assert.match(sidebar, /app-sidebar/);
  assert.match(ai, /app-full-bleed-inset/);
  assert.match(shell, /app-scroll-content/);
  assert.match(auth, /app-auth-content/);

  for (const component of [shell, topBar, sidebar, auth, ai]) {
    assert.doesNotMatch(component, /env\(safe-area-inset-/);
  }
});

test("native edge-to-edge setup precedes WebView creation", () => {
  const enable = androidActivity.indexOf("enableEdgeToEdge()");
  const create = androidActivity.indexOf("super.onCreate(savedInstanceState)");

  assert.ok(enable >= 0);
  assert.ok(create > enable);
});
