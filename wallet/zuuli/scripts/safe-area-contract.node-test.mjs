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
const reader = source("../src/features/articles/pages/Reader.tsx");
const root = source("../src/main.tsx");
const androidManifest = source(
  "../src-tauri/gen/android/app/src/main/AndroidManifest.xml",
);
const androidGradle = source("../src-tauri/gen/android/app/build.gradle.kts");
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
  assert.match(cssRule("app-mobile-more-dialog"), /var\(--safe-area-left\)/);
  assert.match(cssRule("app-mobile-more-dialog"), /var\(--safe-area-right\)/);
  assert.match(cssRule("app-mobile-more-dialog"), /var\(--safe-area-bottom\)/);
  assert.match(cssRule("app-mobile-more-close"), /var\(--safe-area-right\)/);
  const moreDialogRule = cssRule("app-mobile-more-dialog");
  const legacyMoreHeight = moreDialogRule.indexOf("max-height: min(80vh, 32rem);");
  const dynamicMoreHeight = moreDialogRule.indexOf("max-height: min(80dvh, 32rem);");
  assert.ok(legacyMoreHeight >= 0, "More sheet lacks the legacy vh fallback");
  assert.ok(
    dynamicMoreHeight > legacyMoreHeight,
    "More sheet must override vh with dvh in declaration order",
  );
  assert.match(cssRule("app-viewport"), /var\(--safe-area-left\)/);
  assert.match(cssRule("app-viewport"), /var\(--safe-area-right\)/);
  assert.match(topBar, /className="app-top-bar /);
  assert.match(sidebar, /className="app-bottom-nav /);
  assert.match(topBar, /data-app-top-bar/);
  assert.match(sidebar, /data-app-bottom-nav/);
  assert.match(sidebar, /className="app-mobile-more-dialog /);
  assert.match(sidebar, /closeClassName="app-mobile-more-close /);
});

test("the document and app are bounded to one dynamic viewport frame", () => {
  assert.match(css, /html,\s*body,\s*#root\s*\{[^}]*overflow: hidden;/s);
  for (const className of ["app-viewport", "app-crash-frame"]) {
    const rule = cssRule(className);
    const legacyHeight = rule.indexOf("height: 100vh;");
    const dynamicHeight = rule.indexOf("height: 100dvh;");
    assert.ok(legacyHeight >= 0, `${className} lacks the legacy fallback`);
    assert.ok(
      dynamicHeight > legacyHeight,
      `${className} must override 100vh with 100dvh in declaration order`,
    );
  }
  assert.match(cssRule("app-viewport"), /overflow: hidden;/);
  assert.match(shell, /className="app-viewport flex bg-background"/);
  assert.match(shell, /data-app-frame/);
  assert.match(root, /className="app-crash-frame"/);

  for (const framingSource of [shell, auth, root]) {
    assert.doesNotMatch(framingSource, /(?:min-h-screen|\bh-screen\b)/);
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

  const authMain = auth.match(
    /<main className="([^"]*app-auth-content[^"]*)"/,
  );
  assert.ok(authMain, "login must keep the centralized auth inset container");
  assert.match(authMain[1], /\bjustify-start\b/);
  assert.doesNotMatch(
    authMain[1],
    /\bjustify-center\b/,
    "centering an overflowing auth column creates unreachable negative overflow",
  );
  assert.match(
    auth,
    /className="app-auth-stack my-auto flex w-full max-w-md flex-col"/,
  );
});

test("chrome and full-bleed clearance use centralized variables", () => {
  assert.match(sidebar, /app-sidebar/);
  assert.match(ai, /app-full-bleed-inset/);
  assert.match(shell, /app-scroll-content/);
  assert.match(auth, /app-auth-content/);
  assert.match(reader, /app-reader-content/);
  assert.match(reader, /app-reader-actions/);
  assert.doesNotMatch(reader, /fixed[^"\n]*\bbottom-0\b/);

  for (const component of [shell, topBar, sidebar, auth, ai, reader]) {
    assert.doesNotMatch(component, /env\(safe-area-inset-/);
  }
});

test("native edge-to-edge, IME resize, and dark-chrome contrast are explicit", () => {
  const enable = androidActivity.indexOf("enableEdgeToEdge(");
  const create = androidActivity.indexOf("super.onCreate(savedInstanceState)");
  const controller = androidActivity.indexOf("WindowCompat.getInsetsController");

  assert.ok(enable >= 0);
  assert.ok(create > enable);
  assert.ok(controller > create);
  assert.match(androidActivity, /statusBarStyle = SystemBarStyle\.dark/);
  assert.match(androidActivity, /navigationBarStyle = SystemBarStyle\.dark/);
  assert.match(androidActivity, /Color\.argb\(0x80, 0x0A, 0x0A, 0x0F\)/);
  assert.match(androidActivity, /isAppearanceLightStatusBars = false/);
  assert.match(androidActivity, /isAppearanceLightNavigationBars = false/);
  assert.match(androidManifest, /android:windowSoftInputMode="adjustResize"/);
  assert.match(androidGradle, /androidx\.core:core-ktx:1\.15\.0/);
});
