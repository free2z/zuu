/** Reading progress for the static zPage hero layout. */
export { IMAGE_FIT as HERO_FIT } from "./image-fit";
export type { ImageFit as HeroFit } from "./image-fit";
export { chooseImageFit as chooseHeroFit } from "./image-fit";

export function clamp01(value: number): number {
  // NaN first, and only NaN: `Number.isFinite` would also send +Infinity to 0,
  // which is the wrong end of the range for something that means "scrolled
  // impossibly far".
  if (Number.isNaN(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export type SceneMetrics = {
  articleBottom: number;
  viewportHeight: number;
};

export function readingProgress(
  scrollTop: number,
  metrics: SceneMetrics,
): number {
  const span = metrics.articleBottom - metrics.viewportHeight;
  if (!(span > 0)) return 1;
  return clamp01(scrollTop / span);
}

export function quantize(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export type ScrollSceneTargets = {
  article?: HTMLElement | null;
  progress?: HTMLElement | null;
};

/**
 * Measure on resize, then write only the progress bar's transform on scroll.
 * An inherited custom property on <main> invalidates the entire article's
 * styles on every frame, even when it is only consumed by a transform.
 * The hero is static: no spring, per-frame filters, or promoted hero textures.
 */
export function scrollScene(
  node: HTMLElement,
  targets: ScrollSceneTargets = {},
) {
  if (
    typeof window === "undefined" ||
    typeof requestAnimationFrame !== "function"
  ) {
    return { update(_next: ScrollSceneTargets) {}, destroy() {} };
  }
  let current = targets;
  let frameId: number | null = null;
  let destroyed = false;
  let scrollTop = window.scrollY || 0;
  let published = Number.NaN;
  let observedArticle: HTMLElement | null = null;
  const metrics: SceneMetrics = { articleBottom: 0, viewportHeight: 0 };

  function measure() {
    scrollTop = window.scrollY || 0;
    metrics.viewportHeight = window.innerHeight || 0;
    metrics.articleBottom = current.article
      ? current.article.getBoundingClientRect().bottom + scrollTop
      : 0;
  }

  function frame() {
    frameId = null;
    if (destroyed) return;
    const value = quantize(readingProgress(scrollTop, metrics));
    if (current.progress && value !== published) {
      current.progress.style.transform = `scaleX(${value})`;
      published = value;
    }
  }

  function schedule() {
    if (!destroyed && frameId === null) frameId = requestAnimationFrame(frame);
  }

  function handleScroll() {
    scrollTop = window.scrollY || 0;
    schedule();
  }

  function handleResize() {
    measure();
    schedule();
  }

  const observer =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(handleResize)
      : null;

  function syncArticle() {
    const next = current.article ?? null;
    if (next === observedArticle) return;
    if (observedArticle) observer?.unobserve(observedArticle);
    observedArticle = next;
    if (next) observer?.observe(next);
  }

  // The container catches position-only changes, including opening the TOC
  // above an article whose own height does not change.
  observer?.observe(node);
  syncArticle();
  handleResize();
  node.dataset.scrollScene = "";
  window.addEventListener("scroll", handleScroll, { passive: true });
  window.addEventListener("resize", handleResize);
  window.addEventListener("orientationchange", handleResize);

  return {
    update(next: ScrollSceneTargets) {
      if (next.progress !== current.progress) {
        current.progress?.style.removeProperty("transform");
        published = Number.NaN;
      }
      current = next;
      syncArticle();
      handleResize();
    },
    destroy() {
      destroyed = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
      observer?.disconnect();
      current.progress?.style.removeProperty("transform");
      delete node.dataset.scrollScene;
    },
  };
}
