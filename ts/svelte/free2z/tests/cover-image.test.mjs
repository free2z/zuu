import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

/**
 * The write path for a cover image.
 *
 * The read path was fixed in / — nothing crops a featured image any
 * more. The write path still assumed the old world: `CoverCropDialog` forced
 * every upload through a locked 4:1 selection and wrote it out at exactly
 * 1600 x 400, while its own copy promised, one sentence later, that the image
 * would be "shown in full everywhere... rather than cropping it again".
 *
 * What these guard is the whole point of the change: the shape is the
 * creator's, the bound is ours.
 */

let vite;
let boundedCoverSize;
let isWithinCoverBounds;
let canUseSourceFileDirectly;
let coverFileExtension;
let MAX_COVER_EDGE;
let MAX_PASSTHROUGH_BYTES;

const dialogSource = await readFile(
  new URL(
    "../src/lib/components/mdEditor/CoverCropDialog.svelte",
    import.meta.url,
  ),
  "utf8",
);
const coverFieldSource = await readFile(
  new URL(
    "../src/lib/components/mdEditor/EditorCoverField.svelte",
    import.meta.url,
  ),
  "utf8",
);
const uploadPanelSource = await readFile(
  new URL(
    "../src/lib/components/mdEditor/CoverUploadPanel.svelte",
    import.meta.url,
  ),
  "utf8",
);

const LOCALES = ["en", "es", "fr", "pt-BR"];

/**
 * The English fallback of every `$t()` call in a component — i.e. the copy a
 * reader actually sees. Asserting against the raw file would also match the
 * code comments explaining what 1600 x 400 was and why it went, which is the
 * documentation this change is supposed to leave behind.
 */
function visibleCopy(source) {
  return [...source.matchAll(/\$t\(\s*"[^"]+",\s*"((?:[^"\\]|\\.)*)"/g)].map(
    ([, fallback]) => fallback,
  );
}

before(async () => {
  const { createServer } = await import("vite");
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({
    boundedCoverSize,
    isWithinCoverBounds,
    canUseSourceFileDirectly,
    coverFileExtension,
    MAX_COVER_EDGE,
    MAX_PASSTHROUGH_BYTES,
  } = await vite.ssrLoadModule("/src/lib/utils/cover-image.ts"));
});

after(async () => {
  await vite?.close();
});

describe("boundedCoverSize", () => {
  test("bounds the longest edge and never the aspect ratio", () => {
    // The owner's case: a full-height poster. Under the old dialog this became
    // a 1600x400 strip, discarding ~90% of the artwork. It now keeps its shape
    // and only loses resolution.
    const poster = boundedCoverSize({ width: 2480, height: 3508 }, 2048);
    assert.deepEqual(poster, { width: 1448, height: 2048 });
    assert.ok(
      Math.abs(poster.width / poster.height - 2480 / 3508) < 0.001,
      "the poster's aspect ratio survived",
    );

    // A panorama loses width, not shape.
    const panorama = boundedCoverSize({ width: 6000, height: 1000 }, 2048);
    assert.deepEqual(panorama, { width: 2048, height: 341 });

    // A square stays square, which is the shape the old 4:1 crop punished most
    // even though the square thumbnail is the densest surface on the site.
    assert.deepEqual(boundedCoverSize({ width: 4000, height: 4000 }, 2048), {
      width: 2048,
      height: 2048,
    });
  });

  test("never enlarges a small image", () => {
    // Inventing pixels serves nobody, and the blur pad handles a small image
    // better than an upscale does.
    assert.deepEqual(boundedCoverSize({ width: 400, height: 300 }, 2048), {
      width: 400,
      height: 300,
    });
    assert.deepEqual(boundedCoverSize({ width: 2048, height: 100 }, 2048), {
      width: 2048,
      height: 100,
    });
  });

  test("an extreme ratio still yields a drawable canvas", () => {
    // 4096x9 scales to 2048x4.5. Rounding alone would be fine; a ratio one
    // step more extreme rounds to zero, and a zero-height canvas throws.
    assert.deepEqual(boundedCoverSize({ width: 4096, height: 9 }, 2048), {
      width: 2048,
      height: 5,
    });
    assert.deepEqual(boundedCoverSize({ width: 20000, height: 3 }, 2048), {
      width: 2048,
      height: 1,
    });
  });

  test("nothing measured yet is not a crash", () => {
    for (const source of [
      { width: 0, height: 0 },
      { width: Number.NaN, height: 100 },
      { width: 100, height: Number.POSITIVE_INFINITY },
      { width: -100, height: 100 },
    ]) {
      assert.deepEqual(boundedCoverSize(source, 2048), {
        width: 0,
        height: 0,
      });
    }
  });

  test("the shipped cap clears the largest box on the site", () => {
    // The article hero measures 1614x658 at a 1614px viewport. A cap
    // below that would upscale the stored original into the hero on a common
    // desktop — a quality loss we would be choosing deliberately.
    assert.equal(MAX_COVER_EDGE, 2048);
    assert.ok(MAX_COVER_EDGE >= 1614);
    //...and stays inside what the OG rasterizer can decode next to:
    // a square at this cap is a 16.8MB RGBA decode, where 4096 would be 67MB.
    assert.ok((MAX_COVER_EDGE * MAX_COVER_EDGE * 4) / 1e6 < 20);
  });
});

describe("isWithinCoverBounds", () => {
  test("is inclusive at the cap", () => {
    assert.equal(
      isWithinCoverBounds({ width: 2048, height: 2048 }, 2048),
      true,
    );
    assert.equal(isWithinCoverBounds({ width: 2049, height: 10 }, 2048), false);
    assert.equal(isWithinCoverBounds({ width: 10, height: 2049 }, 2048), false);
    assert.equal(isWithinCoverBounds({ width: 0, height: 0 }, 2048), false);
  });
});

describe("canUseSourceFileDirectly", () => {
  const inBounds = { width: 1200, height: 1600 };
  const small = 900 * 1024;

  test("an uncropped, in-bounds, in-budget image is uploaded byte-for-byte", () => {
    // The point of "use full image" is that it is literal: no generational
    // JPEG loss, no PNG alpha flattened to black.
    for (const mimeType of ["image/jpeg", "image/png", "IMAGE/PNG"]) {
      assert.equal(
        canUseSourceFileDirectly({
          cropped: false,
          natural: inBounds,
          mimeType,
          byteLength: small,
          maxEdge: 2048,
        }),
        true,
        mimeType,
      );
    }
  });

  test("dimensions are not a proxy for bytes", () => {
    // A noisy 2048px PNG can be 12MB. nginx caps a zero-balance account at
    // 5MB, so forwarding it would promise a success and deliver a rejection —
    // and above the free tier the request process reads the whole file into
    // memory to strip EXIF.
    assert.ok(MAX_PASSTHROUGH_BYTES <= 5 * 1024 * 1024);
    assert.equal(
      canUseSourceFileDirectly({
        cropped: false,
        natural: inBounds,
        mimeType: "image/png",
        byteLength: MAX_PASSTHROUGH_BYTES + 1,
        maxEdge: 2048,
      }),
      false,
      "over the byte cap",
    );
    assert.equal(
      canUseSourceFileDirectly({
        cropped: false,
        natural: inBounds,
        mimeType: "image/png",
        byteLength: MAX_PASSTHROUGH_BYTES,
        maxEdge: 2048,
      }),
      true,
      "exactly at the byte cap",
    );
    // An unknown size is not a small size.
    for (const byteLength of [undefined, Number.NaN]) {
      assert.equal(
        canUseSourceFileDirectly({
          cropped: false,
          natural: inBounds,
          mimeType: "image/png",
          byteLength,
          maxEdge: 2048,
        }),
        false,
        String(byteLength),
      );
    }
  });

  test("only the containers the server builds derivatives from pass through", () => {
    // GIF: an animated one gets no thumbnail and no variant ladder
    // (`_is_animated` bails in both), so passing it through would put the full
    // original on every card. WebP: `create_thumbnail` runs for JPEG/PNG only,
    // so `get_thumbnail()` would fall back to the original for the same
    // result. HEIC: only Safari can display it.
    for (const mimeType of [
      "image/gif",
      "image/webp",
      "image/heic",
      "image/svg+xml",
      "",
      null,
    ]) {
      assert.equal(
        canUseSourceFileDirectly({
          cropped: false,
          natural: inBounds,
          mimeType,
          byteLength: small,
          maxEdge: 2048,
        }),
        false,
        String(mimeType),
      );
    }
  });

  test("a crop or an oversized image goes to canvas", () => {
    assert.equal(
      canUseSourceFileDirectly({
        cropped: true,
        natural: inBounds,
        mimeType: "image/png",
        byteLength: small,
        maxEdge: 2048,
      }),
      false,
      "a crop has to be applied",
    );
    assert.equal(
      canUseSourceFileDirectly({
        cropped: false,
        natural: { width: 4032, height: 3024 },
        mimeType: "image/jpeg",
        byteLength: small,
        maxEdge: 2048,
      }),
      false,
      "a phone photo has to be bounded",
    );
  });
});

describe("coverFileExtension", () => {
  test("names the upload after its bytes", () => {
    // The server sniffs an upload and 400s when the declared extension names a
    // different format. The old code hardcoded `.jpg`, which was true
    // only while every cover was a canvas-encoded JPEG.
    assert.equal(coverFileExtension("image/webp"), "webp");
    assert.equal(coverFileExtension("image/png"), "png");
    assert.equal(coverFileExtension("image/gif"), "gif");
    assert.equal(coverFileExtension("image/jpeg"), "jpg");
    assert.equal(coverFileExtension("IMAGE/WEBP"), "webp");
    assert.equal(coverFileExtension(undefined), "jpg");
  });
});

describe("the cover dialog imposes no shape", () => {
  test("no code path writes a fixed output size", () => {
    // The whole failure was two literals: `canvas.width = coverWidth` where
    // coverWidth was always 1600. Every output dimension now comes from
    // boundedCoverSize, which is a function of the source.
    assert.doesNotMatch(dialogSource, /coverWidth|coverHeight/);
    assert.doesNotMatch(coverFieldSource, /COVER_WIDTH|COVER_HEIGHT/);
    // Nothing hands the canvas a constant any more; every output dimension is
    // a function of the source region.
    assert.doesNotMatch(dialogSource, /canvas\.(?:width|height) = \d/);
    assert.match(dialogSource, /canvas\.width = target\.width/);
    assert.match(dialogSource, /canvas\.height = target\.height/);
    assert.match(dialogSource, /boundedCoverSize/);
  });

  test("cropping is off by default and free-form when switched on", () => {
    assert.match(dialogSource, /let cropping = \$state\(false\)/);
    assert.match(
      dialogSource,
      /let lockedRatio = \$state<number \| null>\(null\)/,
    );
    // Starting a crop selects the entire image and locks nothing.
    assert.match(
      dialogSource,
      /function startCropping\(\)[\s\S]{0,200}lockedRatio = null;[\s\S]{0,80}selectEverything\(\)/,
    );
    //...and a free selection resizes both axes independently.
    assert.match(dialogSource, /function applyFreeResize/);
    assert.match(
      dialogSource,
      /if \(lockedRatio === null\) \{\s*applyFreeResize/,
    );
  });

  test("the primary action completes an upload with no crop", () => {
    // A creator must be able to finish without cropping: the primary button
    // says so, and the confirm path is reachable the moment the image loads.
    assert.match(dialogSource, /editor\.coverUseFullImage/);
    assert.match(dialogSource, /editor\.coverAdjustFraming/);
    assert.match(dialogSource, /const ready = \$derived\(loaded &&/);
    assert.match(dialogSource, /canUseSourceFileDirectly/);
    assert.match(dialogSource, /cropped: cropping/);
    assert.match(dialogSource, /byteLength: sourceFile\.size/);
  });

  test("the canvas writes a format the server makes derivatives from", () => {
    // Never WebP, however much smaller it is: `create_thumbnail` runs for
    // image/jpeg and image/png only, `get_thumbnail()` falls back to the
    // ORIGINAL when there is no thumbnail row, and `ZpageCard` reads
    // `thumbnail || url` — so a WebP cover puts the full 2048px original on
    // every card in the feed.
    assert.doesNotMatch(dialogSource, /"image\/webp"/);
    assert.match(dialogSource, /encode\(canvas, "image\/png"\)/);
    assert.match(dialogSource, /encode\(canvas, "image\/jpeg"\)/);
    // PNG only while there is alpha to keep, and only while it fits the
    // upload ceiling — otherwise a stray translucent pixel makes a 10MB cover.
    assert.match(dialogSource, /hasTransparency\(/);
    assert.match(dialogSource, /png\.size <= MAX_ENCODED_COVER_BYTES/);
  });

  test("the previews are the real renderer, at the real surface ratios", () => {
    // A hand-drawn mockup would drift from the renderer the first time either
    // changed — which is the exact bug class / were about. These are
    // `FeaturedImageFrame`, blur pad and all.
    assert.match(dialogSource, /import FeaturedImageFrame from/);
    assert.match(dialogSource, /<FeaturedImageFrame\b/);
    assert.match(dialogSource, /aspect-square/); // 1.00 thumbnail
    assert.match(dialogSource, /aspect-\[382\/176\]/); // 2.17 standard card
    assert.match(dialogSource, /aspect-\[1614\/658\]/); // 2.45 article hero
    // They track the crop rather than showing a stale original, and the
    // re-raster is debounced so a drag is not fighting a 2048px drawImage.
    assert.match(dialogSource, /previewSrc/);
    assert.match(dialogSource, /setTimeout\(/);
    assert.match(dialogSource, /PREVIEW_EDGE/);
    // An object URL we minted has to be released, including on an unmount that
    // never reaches "clear crop".
    assert.match(dialogSource, /onDestroy\(\(\) => \{\s*releasePreviewUrl\(\)/);
  });
});

describe("no copy states a required or fixed output size", () => {
  test("every locale catalog is free of the 1600 x 400 promise", async () => {
    for (const locale of LOCALES) {
      const raw = await readFile(
        new URL(`../src/lib/locales/${locale}.json`, import.meta.url),
        "utf8",
      );
      assert.doesNotMatch(raw, /1600/, `${locale}.json still names 1600`);
      assert.doesNotMatch(
        raw,
        /1[\s.,]?600\s*[x×]\s*400/i,
        `${locale}.json still names a fixed cover size`,
      );
    }
  });

  test("the catalogs carry the replacement strings in every language", async () => {
    const required = [
      "coverFramingTitle",
      "coverFramingDescription",
      "coverUseFullImage",
      "coverUseThisCrop",
      "coverAdjustFraming",
      "coverClearCrop",
      "coverRatioFree",
      "coverPreviewThumbnail",
      "coverPreviewCard",
      "coverPreviewHero",
      "coverSizeCapNote",
      "coverStoredSizeNote",
    ];

    for (const locale of LOCALES) {
      const catalog = JSON.parse(
        await readFile(
          new URL(`../src/lib/locales/${locale}.json`, import.meta.url),
          "utf8",
        ),
      );
      for (const key of required) {
        assert.equal(
          typeof catalog.editor?.[key] === "string" &&
            catalog.editor[key].trim().length > 0,
          true,
          `${locale}.json is missing editor.${key}`,
        );
      }
      // The dead keys must be gone rather than left to rot behind the new ones.
      for (const key of [
        "cropCoverTitle",
        "cropCoverDescription",
        "cropCoverWholeImageNote",
        "applyCoverCrop",
      ]) {
        assert.equal(
          key in (catalog.editor ?? {}),
          false,
          `${locale}.json still defines the removed editor.${key}`,
        );
      }
    }
  });

  test("the upload surfaces no longer advertise a standard banner", () => {
    for (const source of [uploadPanelSource, coverFieldSource, dialogSource]) {
      const copy = visibleCopy(source);
      assert.ok(copy.length > 0, "found no translated copy to check");
      for (const line of copy) {
        assert.doesNotMatch(line, /standard banner/i);
        assert.doesNotMatch(line, /1[\s.,]?600/);
        assert.doesNotMatch(line, /4:1/);
      }
    }
  });
});
