import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

let server;
let vite;
let chooseImageFit;
let containedFraction;
let IMAGE_FIT;

before(async () => {
  const { createServer } = await import("vite");
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ chooseImageFit, containedFraction, IMAGE_FIT } = await vite.ssrLoadModule(
    "/src/lib/utils/image-fit.ts",
  ));
});

after(async () => {
  await vite?.close();
  await server?.close?.();
});

/**
 * The boxes a featured image actually lands in, measured against the running
 * site at a 1614px viewport rather than read off the CSS. `width kept` is the
 * fraction of a 1600x400 cover that survived `object-fit: cover`.
 *
 *   square thumbnail   78x78     25%
 *   homepage lead     793x395    50%
 *   standard card     382x176    54%
 *   article hero     1614x658    61%
 *   compact row       216x75     72%
 */
const SURFACES = {
  squareThumbnail: { width: 78, height: 78 },
  commandPaletteThumb: { width: 40, height: 40 },
  editorialThumb: { width: 96, height: 112 },
  homepageLead: { width: 793, height: 395 },
  standardCard: { width: 382, height: 176 },
  relatedCard: { width: 320, height: 180 },
  articleHero: { width: 1614, height: 658 },
  compactRow: { width: 216, height: 75 },
  editorCoverWell: { width: 720, height: 288 },
  // The editor shares the published hero's desktop minimum height. Keep the
  // exact 4:1 case below separate so this fixture cannot bless the old strip.
  editorPreview: { width: 804, height: 468 },
  editorPreviewMobile: { width: 342, height: 371 },
};

/** What the editor stores for every cover, without exception. */
const STORED_COVER = { width: 1600, height: 400 };

describe("chooseImageFit", () => {
  test("the stored 1600x400 cover is never cropped on any surface", () => {
    // The whole point. Every one of these was `cover` before, and every one of
    // them amputated a wordmark: "DYNAWALLA" rendered as "LLA" on a card.
    for (const [name, box] of Object.entries(SURFACES)) {
      const fit = chooseImageFit(STORED_COVER, box);
      assert.equal(fit, "contain", `${name} resolved to ${fit}`);
    }
  });

  test("an exact ratio match snaps to cover rather than showing a hairline", () => {
    // 4:1 in 4:1. A 0px letterbox is not a design, it is a rounding artifact.
    assert.equal(
      chooseImageFit({ width: 1600, height: 400 }, { width: 800, height: 200 }),
      "cover",
    );
    // And within the tolerance: a 3% band is a crop nobody can see, against an
    // artifact everybody can.
    assert.equal(
      chooseImageFit({ width: 1600, height: 400 }, { width: 800, height: 195 }),
      "cover",
    );
  });

  test("the near-match threshold remains cover for auto-fit surfaces", () => {
    // This is close enough to the 804x468 editor Preview box to crop about 5px
    // vertically. EditorPreview opts out of this heuristic; other surfaces
    // retain the intentional auto-fit behaviour.
    const image = { width: 1700, height: 1000 };
    const box = { width: 804, height: 468 };
    const fraction = containedFraction(image, box);
    assert.ok(fraction >= IMAGE_FIT.snapToCoverFraction);
    assert.ok(fraction < 1);
    assert.equal(chooseImageFit(image, box), "cover");
  });

  test("just outside the tolerance it stops cropping", () => {
    // 1600x400 in 800x180 leaves the image at 0.9 of the box height: a visible,
    // deliberate letterbox rather than a hairline.
    const fit = chooseImageFit(
      { width: 1600, height: 400 },
      { width: 800, height: 180 },
    );
    assert.equal(fit, "contain");
    assert.equal(
      Math.round(
        containedFraction(
          { width: 1600, height: 400 },
          { width: 800, height: 180 },
        ) * 100,
      ),
      100 * 0.9,
    );
  });

  test("a ribbon too thin to read as a picture is cropped instead", () => {
    // 15:1 into a nearly square phone hero: contained it is 6% of the box.
    assert.equal(
      chooseImageFit({ width: 6000, height: 400 }, { width: 390, height: 340 }),
      "cover",
    );
  });

  test("...but only while cover is a real alternative", () => {
    // 24x18 blown up to fill a 1440px hero is a 60x smear. The floor must not
    // be able to choose that, however small the contained result is.
    assert.equal(
      chooseImageFit({ width: 24, height: 18 }, { width: 1440, height: 460 }),
      "contain",
    );
    assert.equal(
      chooseImageFit({ width: 96, height: 64 }, { width: 390, height: 340 }),
      "contain",
    );
  });

  test("nothing measured yet resolves to contain, which is what SSR rendered", () => {
    for (const [image, box] of [
      [{ width: 0, height: 0 }, SURFACES.standardCard],
      [
        { width: 1600, height: 400 },
        { width: 0, height: 0 },
      ],
      [{ width: Number.NaN, height: 400 }, SURFACES.standardCard],
      [
        { width: 1600, height: Number.POSITIVE_INFINITY },
        SURFACES.standardCard,
      ],
      [{ width: -1600, height: 400 }, SURFACES.standardCard],
    ]) {
      assert.equal(chooseImageFit(image, box), "contain");
    }
  });

  test("the thresholds are the documented ones", () => {
    assert.equal(IMAGE_FIT.maxUpscale, 3);
    assert.equal(IMAGE_FIT.snapToCoverFraction, 0.97);
    assert.equal(IMAGE_FIT.minContainFraction, 0.12);
  });
});

describe("containedFraction", () => {
  test("is what scale-down would paint, never an enlargement", () => {
    // Smaller than the box in both axes: rendered 1:1, so the fraction is its
    // own size relative to the box — not 1.
    assert.equal(
      containedFraction({ width: 96, height: 64 }, { width: 384, height: 256 }),
      0.25,
    );
  });

  test("reports the short axis, which is the one that letterboxes", () => {
    // 1600x400 in 800x400: fills the width, half the height.
    assert.equal(
      containedFraction(
        { width: 1600, height: 400 },
        { width: 800, height: 400 },
      ),
      0.5,
    );
  });

  test("is 0 when nothing has been measured", () => {
    assert.equal(
      containedFraction({ width: 0, height: 0 }, { width: 10, height: 10 }),
      0,
    );
    assert.equal(
      containedFraction({ width: 10, height: 10 }, { width: 0, height: 0 }),
      0,
    );
  });
});
