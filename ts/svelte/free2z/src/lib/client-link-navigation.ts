/**
 * Knowing, INSIDE the click, that SvelteKit is about to route a link.
 *
 * SvelteKit's link handler (a `click` listener on `<html>`) claims a link
 * with `event.preventDefault()` and then deliberately yields before it
 * navigates: it waits for `requestAnimationFrame` + `setTimeout(0)` (or a
 * 100ms fallback), "to allow the browser to repaint before navigating", so the
 * click does not count against INP. Only after that does `navigate()` resolve
 * the route, run `beforeNavigate` and set `$navigating`. So nothing driven by
 * those — neither `$navigating` nor a `beforeNavigate` callback — can change
 * the frame painted right after the click; on a busy main thread that frame
 * can stay on screen for a long time.
 *
 * A page that wants its loading state in that first frame therefore has to
 * read the click itself. `clientRoutedLinkUrl` answers the only question it
 * can answer synchronously: which same-origin URL is this click about to be
 * client-routed to? It mirrors the checks SvelteKit makes before it calls
 * `preventDefault()`, and requires that `preventDefault()` has happened —
 * anything else is a native navigation (a new tab, a download, an external
 * or `data-sveltekit-reload` link), which unloads the page instead.
 *
 * `defaultPrevented` cannot say WHO prevented the default, though, and a
 * `beforeNavigate` callback can still cancel the navigation. So the answer is
 * a prediction, and `afterDeferredLinkNavigation` bounds how long it may be
 * trusted: it settles only after SvelteKit's deferred `navigate()` has had
 * its chance to run `beforeNavigate` and set `$navigating`.
 */

type AnchorLike = Element & {
  href: string | { baseVal: string };
  target: string | { baseVal: string };
};

function stringValue(value: string | { baseVal: string } | undefined) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : value.baseVal;
}

function findAnchor(event: MouseEvent): AnchorLike | null {
  let node = event.composedPath()[0] as Node | null | undefined;
  while (node) {
    if (
      node.nodeType === 1 &&
      node.nodeName.toUpperCase() === "A" &&
      (node as Element).hasAttribute("href")
    ) {
      return node as AnchorLike;
    }
    // Through shadow roots, as SvelteKit's own `parent_element` does.
    const parent: Node | null = node.parentNode;
    node =
      parent && parent.nodeType === 11
        ? ((parent as ShadowRoot).host ?? null)
        : parent;
  }
  return null;
}

/**
 * Whether the nearest `data-sveltekit-reload` asks for a full-page load, read
 * as SvelteKit's `get_router_options` reads it: `""` and `"true"` do; `"off"`,
 * `"false"` and anything unrecognised do not.
 */
function reloads(anchor: Element) {
  const holder = anchor.closest("[data-sveltekit-reload]");
  if (!holder) return false;
  const value = holder.getAttribute("data-sveltekit-reload");
  return value === "" || value === "true";
}

/**
 * The URL a click is about to be client-routed to, or `null` when SvelteKit
 * will not route it (or someone else already decided what the click does).
 */
export function clientRoutedLinkUrl(
  event: MouseEvent,
  pageUrl: string,
  baseURI: string = pageUrl,
): URL | null {
  if (!event.defaultPrevented) return null;
  if (event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return null;
  }

  const anchor = findAnchor(event);
  if (!anchor) return null;

  // Any target at all, `_self` included: SvelteKit treats the link as
  // external then and leaves it to the browser.
  if (stringValue(anchor.target)) return null;
  if (anchor.hasAttribute("download")) return null;
  const rel = (anchor.getAttribute("rel") ?? "").split(/\s+/);
  if (rel.includes("external")) return null;
  if (reloads(anchor)) return null;

  let url: URL;
  try {
    url = new URL(stringValue(anchor.href), baseURI);
  } catch {
    return null;
  }
  const current = new URL(pageUrl);
  if (url.origin !== current.origin) return null;
  return url;
}

/**
 * Resolves once SvelteKit's deferred link navigation, started by a click that
 * is being handled right now, has had its chance to begin.
 *
 * Call it from a `click` listener that runs AFTER SvelteKit's (a listener on
 * `window` in the bubble phase does: SvelteKit listens on `<html>`). The
 * timers below are then registered after SvelteKit's identical ones, so they
 * fire after them, and the extra `setTimeout(0)` lets the microtasks of
 * SvelteKit's `navigate()` — route resolution, `beforeNavigate`, setting
 * `$navigating` — finish first. This is ordering, not a guessed delay: it
 * holds however slow the main thread is.
 */
export function afterDeferredLinkNavigation(
  schedule: {
    requestAnimationFrame: (callback: () => void) => unknown;
    setTimeout: (callback: () => void, ms: number) => unknown;
  } = globalThis,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      schedule.setTimeout(resolve, 0);
    };
    schedule.requestAnimationFrame(() => schedule.setTimeout(settle, 0));
    // SvelteKit's fallback for a frame that never comes (a background tab).
    schedule.setTimeout(settle, 100);
  });
}

/**
 * Whether the bounded no-unload fallback can release a pending full-page
 * navigation. Browsers expose no response-settled event to the old document
 * when a navigation response becomes a download, so this only rules out an
 * observed unload, URL change, or superseding navigation; the caller must
 * wait its documented grace period before using this heuristic.
 */
export function canReleaseFullPageNavigationFallback(
  navigation: object,
  currentNavigation: object | null,
  hrefAtStart: string,
  currentHref: string,
  pageIsUnloading: boolean,
): boolean {
  return (
    !pageIsUnloading &&
    currentHref === hrefAtStart &&
    currentNavigation === navigation
  );
}
