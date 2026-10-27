import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

/**
 * The ⌘K palette's image bound, and the two props that keep its filtering
 * server-side.
 *
 * Reported as Chrome's "Page Unresponsive" kill dialog while typing on the
 * homepage. `imageUrl()` read `thumbnail || url`; `GenericFile.get_thumbnail()`
 * returns `get_url()` — the ORIGINAL upload — whenever there is no legacy WebP
 * row, so `thumbnail` was frequently the multi-thousand-pixel hero image
 * itself. `thumbnail || url` reads as "the small one, or else the big one",
 * when the first branch was already the big one.
 *
 * Measured on the real component in Chromium (tests/browser/
 * the former browser image-ladder check) with five zPage and five creator results
 * whose uploads are 4000x4000: 23.6 MB over the wire and 960 MB of decoded
 * bitmap, for a strip of 36px chips. After: 0 bytes of original.
 *
 * The browser spec is the behavioural proof. This file pins the decision
 * function itself — every branch, including the ones a fixture would have to
 * be lucky to hit — and guards the two props whose absence cannot be seen from
 * outside at all.
 */

let vite;
let paletteImageSrc;

const componentSource = await readFile(
  new URL("../src/lib/components/layout/SearchCommand.svelte", import.meta.url),
  "utf8",
);

before(async () => {
  const { createServer } = await import("vite");
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ paletteImageSrc } = await vite.ssrLoadModule(
    "/src/lib/search/palette-image.ts",
  ));
});

after(async () => {
  await vite?.close();
});

describe("paletteImageSrc", () => {
  test("prefers the #590 ladder rung, which is never the original", () => {
    assert.equal(
      paletteImageSrc({
        url: "/uploadz/public/free2z/hero.png",
        thumbnail: "/uploadz/public/free2z/hero-legacy.webp",
        thumb: "/uploadz/public/free2z/hero.128.webp",
      }),
      "/uploadz/public/free2z/hero.128.webp",
    );
  });

  test("takes the ladder even when `thumbnail` is the original", () => {
    // The likeliest shape for a recent upload: variants generated, no legacy
    // webp row, so get_thumbnail() fell back to get_url(). Under the old
    // `thumbnail || url` this branch fetched a full-size original while a
    // 128px rung sat unused in the same payload.
    const url = "/uploadz/public/free2z/1418.webp";
    assert.equal(
      paletteImageSrc({ url, thumbnail: url, thumb: "/uploadz/1418.128.webp" }),
      "/uploadz/1418.128.webp",
    );
  });

  test("accepts a legacy thumbnail only when it differs from the original", () => {
    assert.equal(
      paletteImageSrc({
        url: "/uploadz/public/free2z/hero.png",
        thumbnail: "/uploadz/public/free2z/hero.webp",
      }),
      "/uploadz/public/free2z/hero.webp",
    );
  });

  test("returns nothing rather than the original", () => {
    // Every shape that leaves no bounded derivative. The row falls back to its
    // icon placeholder: a 36px picture is not worth an unbounded download.
    const url = "/uploadz/public/free2z/1418.webp";
    assert.equal(paletteImageSrc({ url }), "");
    assert.equal(paletteImageSrc({ url, thumbnail: url }), "");
    assert.equal(paletteImageSrc({ url, thumbnail: "" }), "");
    assert.equal(paletteImageSrc({ url, thumb: "" }), "");
    assert.equal(paletteImageSrc({ url, thumb: null }), "");
  });

  test("survives a missing or empty image", () => {
    assert.equal(paletteImageSrc(undefined), "");
    assert.equal(paletteImageSrc(null), "");
    assert.equal(paletteImageSrc({}), "");
  });

  test("never returns the `url` field, whatever the combination", () => {
    // The property, stated once over the whole input space this helper can
    // see, rather than case by case: `url` is the original and is never the
    // answer.
    const url = "/uploadz/original.png";
    for (const thumbnail of [undefined, null, "", url, "/uploadz/t.webp"]) {
      for (const thumb of [undefined, null, "", url, "/uploadz/l.webp"]) {
        const chosen = paletteImageSrc({ url, thumbnail, thumb });
        assert.notEqual(
          chosen,
          url,
          `chose the original for thumbnail=${thumbnail} thumb=${thumb}`,
        );
      }
    }
  });
});

describe("SearchCommand.svelte", () => {
  test("routes both result images through the bounded helper", () => {
    assert.match(componentSource, /paletteImageSrc\(image\)/);
    // The exact expression that caused  must not come back — in this
    // component, on any field.
    assert.doesNotMatch(
      componentSource,
      /\?\.thumbnail\s*\|\|\s*\w+\?\.url/,
      "the `thumbnail || url` fallback is back in the palette",
    );
  });

  test("the avatar image keeps its decode off the keystroke path", () => {
    // The one <img> the palette renders itself (the zPage rows go through
    // FeaturedImageFrame, which already sets these). Without decoding="async"
    // a 4000x4000 avatar is eligible to decode synchronously on the thread
    // that is handling the next keystroke.
    const avatar = componentSource.slice(
      componentSource.indexOf("src={avatar}"),
      componentSource.indexOf("rounded-full object-cover"),
    );
    assert.ok(avatar.length > 0, "the avatar <img> moved; update this guard");
    assert.match(avatar, /decoding="async"/);
    assert.match(avatar, /loading="lazy"/);
    // Intrinsic size: reserves the box so a late avatar cannot reflow the list
    // under the user's cursor.
    assert.match(avatar, /width="36"/);
    assert.match(avatar, /height="36"/);
  });

  test("both command roots keep client-side filtering switched off", () => {
    // Count the real attributes only: the explanatory HTML comments name the
    // same props, and a guard that counts its own documentation is a guard
    // that stops going red when the props are deleted.
    const markup = componentSource.replace(/<!--[\s\S]*?-->/g, "");
    // Load-bearing for performance, not for styling: search is server-side, so
    // with filtering left on bits-ui re-scores and re-sorts every registered
    // item on every keystroke — the classic cmdk main-thread freeze. There are
    // two roots (desktop dialog, mobile drawer) and a refactor that drops
    // either one reintroduces it on that surface only, which is exactly the
    // kind of regression nothing else here would catch.
    assert.equal(
      markup.match(/shouldFilter=\{false\}/g)?.length,
      2,
      "shouldFilter={false} must be on both the dialog and the drawer root",
    );
    assert.equal(
      markup.match(/filter=\{\(\) => 1\}/g)?.length,
      2,
      "filter={() => 1} must be on both the dialog and the drawer root",
    );
  });
});
