/**
 * Keep the reCAPTCHA challenge usable while a modal owns the page.
 *
 * Google does not render the "select all images with…" challenge into the
 * container handed to `grecaptcha.render()`. It appends a separate element
 * (a `position: fixed; z-index: 2000000000` bubble) as its own child of
 * `<body>`, holding a cross-origin `bframe` iframe.
 *
 * Every modal primitive we use — bits-ui `Dialog` and vaul `Drawer` both, via
 * their body scroll lock — sets `pointer-events: none` on `<body>` for as long
 * as the modal is open. `pointer-events` is an *inherited* property, so that
 * one declaration also disables hit testing for Google's bubble: the image
 * tiles, the verify button and the audio fallback all stop being click
 * targets, and the click lands on the dialog overlay underneath instead. That
 * is exactly the reported symptom — the challenge appears, and "they cannot
 * select the items".
 *
 * Focus is blocked by a second, independent mechanism. bits-ui installs a
 * capture-phase `focusin` listener on `document`: its focus scope pulls focus
 * back into the dialog whenever it lands anywhere else, and its dismissible
 * layer reports a focus-outside. Both treat the challenge iframe as "outside",
 * so even with pointer events restored the audio fallback could not be typed
 * into and the challenge could not be driven from the keyboard.
 *
 * Chrome normally issues a silent pass and never shows the visual challenge,
 * which is why this only reproduced on privacy-hardened browsers (Firefox,
 * Zen) where reCAPTCHA falls back to the puzzle.
 *
 * The remedies are deliberately narrow:
 *
 *  - `pointer-events: auto` on the element wrapping each reCAPTCHA iframe.
 *    Unlike `visibility`, `pointer-events` can be re-enabled by a descendant,
 *    so the challenge becomes hit-testable while the rest of the page stays
 *    locked exactly as the modal intends.
 *  - a capture-phase `focusin` listener on `window` — which runs before the
 *    `document` listeners bits-ui installs — that stops propagation for events
 *    targeting a reCAPTCHA frame, and only those.
 *
 * Google's wrappers carry no class, id or data attribute (only an inline
 * `style`), so they are located via the iframe inside them rather than by
 * matching a magic z-index string. The iframe in turn is verified by origin,
 * not just by a path substring: page content can embed arbitrary third-party
 * iframes, and a URL merely *containing* `/recaptcha/` must not be able to
 * talk this code into unlocking part of the page.
 */

/** Cheap prefilter; every match is still origin-checked by {@link isRecaptchaFrame}. */
export const RECAPTCHA_FRAME_SELECTOR = 'iframe[src*="/recaptcha/"]';

/**
 * Hosts Google serves reCAPTCHA from. `www.google.com` is what our loader uses;
 * `www.recaptcha.net` and `recaptcha.google.com` are the documented
 * alternatives for regions where google.com is unreachable.
 */
export const RECAPTCHA_HOSTS = new Set([
  "www.google.com",
  "google.com",
  "www.recaptcha.net",
  "recaptcha.net",
  "recaptcha.google.com",
]);

/** True only for a frame actually served by Google's reCAPTCHA. */
export function isRecaptchaFrame(frame: { src?: string | null }): boolean {
  const src = frame.src;
  if (!src) return false;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    RECAPTCHA_HOSTS.has(url.hostname) &&
    url.pathname.startsWith("/recaptcha/")
  );
}

function recaptchaFrames(doc: Document): HTMLIFrameElement[] {
  if (!doc.body) return [];
  return [
    ...doc.querySelectorAll<HTMLIFrameElement>(RECAPTCHA_FRAME_SELECTOR),
  ].filter(isRecaptchaFrame);
}

/**
 * The element to re-enable pointer events on: the frame's immediate wrapper,
 * which is Google's fixed-position bubble. Patching the wrapper rather than
 * walking up to the `<body>`-level ancestor keeps the blast radius to one
 * element that provably holds a Google frame — a walk to `<body>` would set
 * `pointer-events: auto` on the whole app root if a page ever embedded a frame
 * of its own that slipped past the checks.
 */
function overlayTargets(doc: Document): HTMLElement[] {
  const targets: HTMLElement[] = [];
  for (const frame of recaptchaFrames(doc)) {
    const parent = frame.parentElement;
    const target = parent && parent !== doc.body ? parent : frame;
    if (!targets.includes(target)) targets.push(target);
  }
  return targets;
}

/**
 * Re-enable pointer events on every reCAPTCHA overlay currently in `doc`.
 * Returns the number of elements changed, which is what the tests assert on.
 */
export function restoreRecaptchaOverlayPointerEvents(doc: Document): number {
  let patched = 0;
  for (const target of overlayTargets(doc)) {
    if (target.style.pointerEvents === "auto") continue;
    target.style.pointerEvents = "auto";
    patched += 1;
  }
  return patched;
}

/**
 * Apply both fixes and keep applying them. The overlay is created
 * asynchronously some time after `grecaptcha.render()` returns and Google
 * rewrites its inline style whenever the challenge is shown or dismissed, so
 * a one-shot pass is not enough. Returns a teardown function.
 */
export function watchRecaptchaOverlay(doc: Document): () => void {
  const observers: MutationObserver[] = [];
  const watched = new Set<HTMLElement>();
  const canObserve =
    typeof MutationObserver !== "undefined" && Boolean(doc.body);

  const apply = () => {
    restoreRecaptchaOverlayPointerEvents(doc);
    if (!canObserve) return;
    for (const target of overlayTargets(doc)) {
      if (watched.has(target)) continue;
      watched.add(target);
      // Writing `pointer-events: auto` is idempotent, so this observer cannot
      // feed itself: the re-run finds nothing to change and emits no mutation.
      const observer = new MutationObserver(apply);
      observer.observe(target, {
        attributes: true,
        attributeFilter: ["style"],
      });
      observers.push(observer);
    }
  };

  apply();

  if (canObserve) {
    const bodyObserver = new MutationObserver(apply);
    // `subtree: true` because Google may append an empty wrapper first and
    // insert the frame into it afterwards; a direct-children-only watch would
    // miss the second step and never patch anything.
    bodyObserver.observe(doc.body, { childList: true, subtree: true });
    observers.push(bodyObserver);
  }

  const view = doc.defaultView;
  const onFocusIn = (event: Event) => {
    const target = event.target as Node | null;
    if (!target) return;
    const inChallenge = recaptchaFrames(doc).some(
      (frame) => frame === target || frame.contains(target),
    );
    // Stop the event before bits-ui's document-level capture listeners see it:
    // its focus scope would yank focus straight back out of the challenge and
    // its dismissible layer would report a focus-outside.
    if (inChallenge) event.stopPropagation();
  };
  view?.addEventListener("focusin", onFocusIn, true);

  return () => {
    for (const observer of observers) observer.disconnect();
    observers.length = 0;
    watched.clear();
    view?.removeEventListener("focusin", onFocusIn, true);
  };
}
