import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createServer } from "vite";

let vite;
let clamp01;
let readingProgress;
let chooseHeroFit;
let quantize;
let scrollScene;
let HERO_FIT;

before(async () => {
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  ({
    clamp01,
    readingProgress,
    chooseHeroFit,
    quantize,
    scrollScene,
    HERO_FIT,
  } = await vite.ssrLoadModule("/src/lib/utils/hero-parallax.ts"));
});

after(async () => {
  await vite?.close();
});

describe("clamp01", () => {
  test("clamps to the unit interval and refuses non-numbers", () => {
    assert.equal(clamp01(0.5), 0.5);
    assert.equal(clamp01(-3), 0);
    assert.equal(clamp01(9), 1);
    assert.equal(clamp01(Number.NaN), 0);
    // "Scrolled impossibly far" belongs at the far end of the range, not back
    // at rest — a `Number.isFinite` guard would have sent it to 0.
    assert.equal(clamp01(Number.POSITIVE_INFINITY), 1);
    assert.equal(clamp01(Number.NEGATIVE_INFINITY), 0);
  });
});

describe("readingProgress", () => {
  test("maps the scrollable remainder of the article to 0..1", () => {
    const metrics = {
      heroTop: 0,
      heroHeight: 400,
      articleBottom: 2800,
      viewportHeight: 800,
    };
    assert.equal(readingProgress(0, metrics), 0);
    assert.equal(readingProgress(1000, metrics), 0.5);
    assert.equal(readingProgress(2000, metrics), 1);
    assert.equal(readingProgress(9999, metrics), 1);
  });

  test("an article shorter than the viewport is fully read", () => {
    const metrics = {
      heroTop: 0,
      heroHeight: 400,
      articleBottom: 500,
      viewportHeight: 800,
    };
    assert.equal(readingProgress(0, metrics), 1);
  });
});

describe("chooseHeroFit", () => {
  // The hero delegates to the shared featured-image doctrine; the exhaustive
  // geometry cases live in `tests/image-fit.test.mjs`. What is asserted here is
  // that the *hero* is wired to it, at hero-shaped boxes.
  const wideBox = { width: 1440, height: 460 };
  const phoneBox = { width: 390, height: 340 };

  test("shows the whole of an ordinary landscape photograph", () => {
    // This is the doctrine change. It used to be `cover` on both boxes: a
    // full-bleed crop looks great on a photograph and destroys a title card,
    // and the product cannot tell the two apart. Covering a 16:9 image in a
    // 1440x460 hero throws away 41% of its height, top and bottom.
    for (const image of [
      { width: 1600, height: 900 }, // 16:9
      { width: 3000, height: 2000 }, // 3:2
      { width: 2048, height: 1536 }, // 4:3
    ]) {
      assert.equal(chooseHeroFit(image, wideBox), "contain");
      assert.equal(chooseHeroFit(image, phoneBox), "contain");
    }
  });

  test("shows the whole of the 1600x400 cover the editor actually stores", () => {
    // The only shape this product stores, on the only hero it has. Under the
    // thresholds this replaced, both of these were `cover`.
    assert.equal(
      chooseHeroFit({ width: 1600, height: 400 }, wideBox),
      "contain",
    );
    assert.equal(
      chooseHeroFit({ width: 1600, height: 400 }, phoneBox),
      "contain",
    );
  });

  test("letterboxes a panorama on a wide hero but crops it on a phone", () => {
    // 1440x460 leaves the panorama 21% of the hero's height — a deliberate
    // looking band. The same image on a 390x340 phone hero would be a 26px
    // ribbon floating in a blur, which is worse than a crop of the real thing.
    assert.equal(
      chooseHeroFit({ width: 6000, height: 400 }, wideBox),
      "contain",
    );
    assert.equal(
      chooseHeroFit({ width: 6000, height: 400 }, phoneBox),
      "cover",
    );
  });

  test("letterboxes a portrait on both", () => {
    assert.equal(
      chooseHeroFit({ width: 1200, height: 1600 }, wideBox),
      "contain",
    );
    assert.equal(
      chooseHeroFit({ width: 1200, height: 1600 }, phoneBox),
      "contain",
    );
  });

  test("letterboxes an image too small to enlarge to full bleed", () => {
    assert.equal(chooseHeroFit({ width: 96, height: 64 }, wideBox), "contain");
    assert.equal(chooseHeroFit({ width: 96, height: 64 }, phoneBox), "contain");
  });

  test("the letterbox floor never sends a too-small image back to cover", () => {
    // The floor exists for the panorama case, where cover still shows real
    // photographic detail at native resolution. An image that cannot be
    // enlarged has no such alternative, so it letterboxes however small the
    // result: 96x64 is 6.7% of a 1440px hero and still beats a 15x smear.
    assert.equal(chooseHeroFit({ width: 96, height: 64 }, wideBox), "contain");
    assert.equal(chooseHeroFit({ width: 24, height: 18 }, wideBox), "contain");
  });

  test("falls back to contain whenever a dimension is missing or absurd", () => {
    // Pre-decode, a hidden hero, and a broken image all land here. `contain`
    // is what the server rendered, so this branch never causes a visible swap
    // — and it is the branch that cannot destroy content.
    const cases = [
      [{ width: 0, height: 0 }, wideBox],
      [
        { width: 800, height: 600 },
        { width: 0, height: 0 },
      ],
      [{ width: Number.NaN, height: 600 }, wideBox],
      [{ width: 800, height: Number.POSITIVE_INFINITY }, wideBox],
      [{ width: -800, height: 600 }, wideBox],
    ];
    for (const [image, box] of cases) {
      assert.equal(chooseHeroFit(image, box), "contain");
    }
  });

  test("the thresholds are the documented ones", () => {
    assert.equal(HERO_FIT.maxUpscale, 3);
    assert.equal(HERO_FIT.snapToCoverFraction, 0.97);
    assert.equal(HERO_FIT.minContainFraction, 0.12);
  });
});

describe("quantize", () => {
  test("keeps three decimals so a settled scroll stops writing to the DOM", () => {
    assert.equal(quantize(0.123456), 0.123);
    assert.equal(quantize(0.1234), quantize(0.12344));
    assert.equal(quantize(1), 1);
    assert.equal(quantize(0), 0);
  });
});

describe("scrollScene", () => {
  test("is an inert no-op without a browser, rather than throwing", () => {
    // `ssrLoadModule` runs this in Node, where `window` does not exist. Svelte
    // never invokes actions during SSR, but importing the module must stay
    // safe: the page's <main> uses it unconditionally.
    assert.equal(typeof window, "undefined");
    const node = { style: {}, dataset: {} };
    const handle = scrollScene(node, {});
    assert.doesNotThrow(() => handle.update({}));
    assert.doesNotThrow(() => handle.destroy());
  });
});

test("progress target replacement and teardown release the old element and queued frame", () => {
  const frames = new Map();
  const listeners = new Map();
  let nextFrame = 0;
  const element = (bottom = 2000) => ({
    dataset: {},
    style: {
      transform: "",
      removeProperty(name) {
        this[name] = "";
      },
    },
    getBoundingClientRect: () => ({ bottom }),
  });
  const globals = ["window", "requestAnimationFrame", "cancelAnimationFrame"];
  const original = globals.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  try {
    globalThis.window = {
      scrollY: 500,
      innerHeight: 1000,
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name) => listeners.delete(name),
    };
    globalThis.requestAnimationFrame = (callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    };
    globalThis.cancelAnimationFrame = (id) => frames.delete(id);
    const flush = () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback());
    };
    const node = element();
    const first = element();
    const second = element();
    const action = scrollScene(node, { article: element(), progress: first });
    flush();
    assert.equal(first.style.transform, "scaleX(0.333)");
    action.update({ article: element(3000), progress: second });
    assert.equal(first.style.transform, "");
    flush();
    assert.equal(second.style.transform, "scaleX(0.2)");
    window.scrollY = 1000;
    listeners.get("scroll")();
    assert.equal(frames.size, 1);
    action.destroy();
    assert.equal(frames.size, 0);
    assert.equal(listeners.size, 0);
    assert.equal(second.style.transform, "");
    assert.equal(node.dataset.scrollScene, undefined);
  } finally {
    globals.forEach((name, index) => {
      if (original[index])
        Object.defineProperty(globalThis, name, original[index]);
      else delete globalThis[name];
    });
  }
});
