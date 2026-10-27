// The web app manifest and its icons — issue  phase 4.
//
// The classic CRA build owned the site's favicon, manifest and app icons
// (ts/react/free2z/public/{favicon.ico,manifest.json,logo192.png,logo512.png}),
// served off disk by nginx's `root /base/build/`. Phase 4 deletes that tree.
// Nothing in CI or in any probe would have noticed: /healthz and /robots.txt
// are nginx literals, the build still compiles, and the only symptom is a tab
// with no icon and an install prompt that reports the app as broken.
//
// So this file asserts the whole chain, end to end, from files that exist:
//
//   manifest fields -> icon files at the declared PIXEL sizes -> the /brand/
//   prefix that nginx already routes -> the <link> tags in app.html.
//
// The single most valuable assertion here is the size check. A manifest that
// lists an icon the browser cannot fetch, or one whose real dimensions differ
// from `sizes`, is WORSE than shipping no manifest at all — Chrome surfaces it
// as a failed install rather than as no install.
//
// This is a static-file check, not a browser check. It cannot tell you the
// icon looks good, that the maskable variant survives a real Android mask, or
// that the install prompt appears. Those need a device.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const APP_DIR = new URL("../", import.meta.url);
const STATIC_DIR = new URL("static/", APP_DIR);
const MANIFEST_URL = new URL("manifest.json", STATIC_DIR);
const APP_HTML_URL = new URL("src/app.html", APP_DIR);
const SEO_URL = new URL("src/lib/seo.ts", APP_DIR);

const manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf8"));
const appHtml = readFileSync(APP_HTML_URL, "utf8");

// The path a manifest `src` maps to on disk. Everything must be root-absolute:
// a relative `src` resolves against the MANIFEST's URL, not the document's, so
// it silently means something different on a nested route.
function staticFileFor(src) {
  assert.ok(
    src.startsWith("/"),
    `manifest icon src ${JSON.stringify(src)} must be root-absolute`,
  );
  return new URL(src.slice(1), STATIC_DIR);
}

// Width/height straight out of the PNG IHDR chunk: 8-byte signature, 4-byte
// length, 4-byte type, then two big-endian uint32s. Reading the real bytes is
// the point — a filename that says 512 proves nothing.
function pngSize(fileUrl) {
  const buf = readFileSync(fileUrl);
  assert.ok(
    buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    `${fileURLToPath(fileUrl)} is not a PNG`,
  );
  assert.equal(
    buf.subarray(12, 16).toString("ascii"),
    "IHDR",
    `${fileURLToPath(fileUrl)} has no IHDR chunk`,
  );
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("manifest carries every field an installable app needs", () => {
  for (const field of [
    "id",
    "name",
    "short_name",
    "description",
    "start_url",
    "scope",
    "display",
    "theme_color",
    "background_color",
    "icons",
  ]) {
    assert.ok(
      manifest[field],
      `manifest.json is missing the ${field} field — without it the install ` +
        `prompt is either suppressed or falls back to a page-derived guess`,
    );
  }

  assert.equal(manifest.display, "standalone");
  // scope must contain start_url or navigations leave the installed app and
  // hand the user back to the browser mid-session.
  assert.ok(manifest.start_url.startsWith(manifest.scope));
  for (const colour of [manifest.theme_color, manifest.background_color]) {
    assert.match(colour, /^#[0-9a-f]{6}$/);
  }
});

test("manifest copy is the site copy, not a second source of truth", () => {
  const seo = readFileSync(SEO_URL, "utf8");
  // Quote style is the formatter's choice  -- accept either.
  const nameMatch = seo.match(/export const SITE_NAME = (['"])(.*?)\1/);
  const descMatch = seo.match(
    /export const SITE_DESCRIPTION =\s*(['"])(.*?)\1/,
  );
  assert.ok(
    nameMatch && descMatch,
    "could not read SITE_NAME/SITE_DESCRIPTION out of src/lib/seo.ts — if " +
      "those constants were renamed or reformatted, update this test rather " +
      "than letting the manifest drift from the rest of the site's metadata",
  );

  assert.equal(manifest.name, nameMatch[2]);
  assert.equal(manifest.short_name, nameMatch[2]);
  assert.equal(manifest.description, descMatch[2]);

  // 2Z are platform credits, never money or cryptocurrency. `description` is
  // user-facing copy shown in the install prompt and in app listings, where a
  // monetary reading is a compliance problem rather than a style one.
  assert.doesNotMatch(
    manifest.description,
    /\b(crypto|cryptocurrency|zcash|zec|bitcoin|wallet|money|cash out|payout|invest)\b/i,
    "manifest description must not imply 2Z are money or cryptocurrency",
  );
});

test("every declared icon exists at exactly the size it claims", () => {
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);

  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png");
    assert.match(icon.sizes, /^\d+x\d+$/);

    const file = staticFileFor(icon.src);
    assert.ok(
      existsSync(file),
      `manifest lists ${icon.src} but ${fileURLToPath(file)} does not exist — ` +
        `the browser reports an unfetchable icon as a broken install`,
    );

    const [declaredW, declaredH] = icon.sizes.split("x").map(Number);
    const actual = pngSize(file);
    assert.deepEqual(
      actual,
      { width: declaredW, height: declaredH },
      `${icon.src} is ${actual.width}x${actual.height} but declares ${icon.sizes}`,
    );
  }
});

test("installability floor: a 192, a 512, and a maskable variant", () => {
  const anySizes = manifest.icons
    .filter((icon) => !icon.purpose || icon.purpose.split(" ").includes("any"))
    .map((icon) => icon.sizes);
  // Chrome's install criteria want a 192 and a 512; iOS/Android use them at
  // different densities.
  assert.ok(anySizes.includes("192x192"));
  assert.ok(anySizes.includes("512x512"));

  // Without a maskable icon Android letterboxes the icon inside a white
  // circle, which reads as broken next to every other app on the launcher.
  const maskable = manifest.icons.filter((icon) =>
    (icon.purpose ?? "").split(" ").includes("maskable"),
  );
  assert.ok(maskable.length > 0, "no purpose:maskable icon");
  assert.ok(maskable.some((icon) => icon.sizes === "512x512"));

  // A single icon must not claim both purposes. `purpose: "any maskable"` is
  // legal but means one bitmap serves both, so it is either letterboxed as
  // `any` or clipped as `maskable`. Ours are separate files on purpose: the
  // maskable one is the logo inset to 80% on an opaque background.
  for (const icon of manifest.icons) {
    const purposes = (icon.purpose ?? "any").split(" ");
    assert.ok(
      !(purposes.includes("any") && purposes.includes("maskable")),
      `${icon.src} claims both any and maskable; ship two files instead`,
    );
  }
});

test("app.html wires the manifest, the apple-touch-icon and the favicon", () => {
  assert.match(appHtml, /<link rel="manifest" href="[^"]*\/manifest\.json"/);

  // iOS ignores the manifest entirely for the home-screen icon and reads this
  // tag instead, so it is not redundant with the icons array above.
  const appleMatch = appHtml.match(
    /<link\s+rel="apple-touch-icon"\s+href="[^"]*?([^"/]+\.png)"/,
  );
  assert.ok(appleMatch, "app.html has no apple-touch-icon link");

  const appleFile = new URL(`brand/${appleMatch[1]}`, STATIC_DIR);
  assert.ok(existsSync(appleFile), `${appleMatch[1]} is not in static/brand/`);
  const appleSize = pngSize(appleFile);
  assert.equal(appleSize.width, appleSize.height);
  assert.ok(appleSize.width >= 180);

  // theme_color is one value but the app is light AND dark, so app.html also
  // carries the per-scheme metas. The manifest's value must agree with one of
  // them or the standalone title bar disagrees with the page it frames.
  const schemeColours = [
    ...appHtml.matchAll(
      /<meta\s+name="theme-color"\s+media="\(prefers-color-scheme: \w+\)"\s+content="(#[0-9a-f]{6})"/g,
    ),
  ].map((m) => m[1]);
  assert.equal(schemeColours.length, 2);
  assert.ok(schemeColours.includes(manifest.theme_color));
});

test("favicon.ico is SvelteKit's own file, not the CRA build's", () => {
  const favicon = new URL("favicon.ico", STATIC_DIR);
  assert.ok(existsSync(favicon), "static/favicon.ico is missing");
  assert.match(appHtml, /<link rel="icon" href="[^"]*\/favicon\.ico/);

  // Self-retiring: while the classic build still exists the two copies must be
  // byte-identical, so routing /favicon.ico to SvelteKit is provably a no-op
  // for users. Once ts/react/free2z is deleted this half simply stops running.
  const classic = new URL("../../react/free2z/public/favicon.ico", APP_DIR);
  if (existsSync(classic)) {
    assert.ok(
      readFileSync(favicon).equals(readFileSync(classic)),
      "static/favicon.ico has drifted from the classic CRA favicon; routing " +
        "/favicon.ico to SvelteKit would change what users see",
    );
  }
});

test("no service worker — deliberately", () => {
  // NOT an oversight, and please do not "complete the PWA" by adding one.
  // This repo has a live stale-asset problem across rolling deploys (  // and  exists to fix asset immutability). A service worker caching the
  // app shell would pin a user to a dead build across deploys with no obvious
  // recovery, and make the existing problem much harder to diagnose.
  //
  // A manifest plus icons is enough: installable on Android and desktop
  // Chrome, and iOS home-screen works off the apple-touch-icon link. Offline
  // support is the only thing a service worker would add, and it is not what
  //  phase 4 asked for. If it is ever wanted, it is its own decision with
  // its own rollout and kill switch — delete this test in that PR.
  const srcFiles = readdirSync(new URL("src/", APP_DIR));
  assert.equal(
    srcFiles.filter((f) => f.startsWith("service-worker.")).length,
    0,
    "src/service-worker.* exists; SvelteKit auto-registers it",
  );
  assert.doesNotMatch(appHtml, /serviceWorker/);
  assert.doesNotMatch(
    readFileSync(new URL("vite.config.ts", APP_DIR), "utf8"),
    /serviceWorker/,
  );
});
