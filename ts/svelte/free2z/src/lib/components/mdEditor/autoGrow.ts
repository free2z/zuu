/**
 * Auto-growing a textarea WITHOUT moving the page underneath the writer.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO PREVENT ( — P0, the editor was unusable)
 * ---------------------------------------------------------------------------
 *
 * The classic auto-grow dance is three lines:
 *
 *     el.style.height = "auto";                       // collapse
 *     el.style.height = `${el.scrollHeight}px`;       // regrow to fit
 *
 * On a page with an inner scroll container that is harmless. `/edit` has no
 * inner scroll container — the DOCUMENT scrolls — and the body textarea is the
 * document's height. So on a long zPage, every keystroke did this:
 *
 *   1. `height: auto` collapses a ~5,000px textarea to its `min-height`
 *      (400px). The document's scroll height collapses with it.
 *   2. The browser CLAMPS `document.scrollingElement.scrollTop` to the new,
 *      tiny maximum. **The old offset is now gone** — it is not remembered
 *      anywhere, and step 3 does not bring it back.
 *   3. `height: <scrollHeight>px` restores the document height. `scrollTop`
 *      stays where the clamp left it.
 *   4. The caret is now far below the viewport, so the browser's native caret
 *      reveal scrolls the MINIMUM distance needed to expose it — which parks
 *      the caret's line flush against the BOTTOM edge of the window, with the
 *      whole document above it and nothing below.
 *
 * Every keystroke. That is the symptom the owner reported.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES ABOUT IT
 * ---------------------------------------------------------------------------
 *
 * 1. **The path that never collapses is the exceptional one, not the usual
 *    one.** When `scrollHeight > clientHeight` the content already overflows
 *    the box, and `scrollHeight` IS the full content extent — the target
 *    height is known without ever setting `height: auto`. That is the
 *    keystroke that actually adds a line (or the first mount), and it never
 *    clamps anything. But after ANY resize the applied height equals the
 *    content height, so `clientHeight === scrollHeight` again immediately
 *    afterward — which means a keystroke that does NOT add a line fails this
 *    test and falls straight through to the collapse/measure path in point 2.
 *    That path, not this one, is what runs on essentially every keystroke.
 *    So the synchronous restore in point 2 is load-bearing on the hot,
 *    ordinary-typing path — not a rare-path safety net for an edge case.
 *    Deferring it to a `requestAnimationFrame`, or dropping it on the theory
 *    that collapsing is uncommon, is exactly how  comes back.
 *
 * 2. **When it must collapse, it puts the scroll back — synchronously.**
 *    Content that FITS the current box cannot be measured without collapsing
 *    (see `measureShrunkHeight`), so for that path every scroll offset that
 *    the collapse could destroy is captured first and restored in the SAME
 *    task, immediately after the final height is applied. Not in a
 *    `requestAnimationFrame`: a frame boundary is a chance to paint, and a
 *    paint at the clamped offset is the bug. It also gives the browser a
 *    chance to run its caret reveal against the wrong offset, which is the
 *    part that actually moves the view.
 *
 *    The restore has to come AFTER the final height is written, never between
 *    the collapse and the regrow — while the element is collapsed the maximum
 *    scroll is still tiny, so a restore there would simply be clamped again.
 *
 * 3. **It writes nothing when the height would not change**, so the common
 *    keystroke (a character that does not add a line) costs no style
 *    invalidation.
 *
 * `field-sizing: content` would replace all of this with one CSS declaration,
 * and is deliberately NOT used: Safari does not support it as of this writing
 * and Safari is a first-class target for free2z.
 */

/** A scroll offset that the collapse could destroy, and where to put it back. */
interface ScrollSnapshot {
  target: Element;
  top: number;
  left: number;
}

export interface AutoGrowOptions {
  /**
   * Floor for the applied height, in CSS px. The zPage body keeps a 400px
   * floor so an empty draft still reads as a long-form writing surface; the
   * title has none and hugs its content.
   */
  minHeight?: number;
}

/**
 * Every scroll offset that collapsing `textarea` could clamp away.
 *
 * Only a NON-ZERO offset is at risk: clamping moves an offset toward zero and
 * can never move one away from zero, so an ancestor already at 0/0 will still
 * be at 0/0 afterwards. Skipping those keeps this to a couple of entries in
 * practice and means we never write a scroll offset we did not need to.
 *
 * The walk covers `document.scrollingElement` (the case that actually bit us)
 * AND every ancestor element, so this keeps working unchanged if `/edit` ever
 * gains an inner scroll container — the failure mode would otherwise come
 * straight back, silently, in a layout PR that never mentions the editor.
 */
function captureScrollPositions(
  textarea: HTMLTextAreaElement,
): ScrollSnapshot[] {
  const snapshots: ScrollSnapshot[] = [];
  const seen = new Set<Element>();

  const record = (target: Element | null | undefined) => {
    if (!target || seen.has(target)) {
      return;
    }

    seen.add(target);

    const { scrollTop, scrollLeft } = target;

    if (scrollTop === 0 && scrollLeft === 0) {
      return;
    }

    snapshots.push({ target, top: scrollTop, left: scrollLeft });
  };

  for (let node = textarea.parentElement; node; node = node.parentElement) {
    record(node);
  }

  record(textarea.ownerDocument?.scrollingElement);

  return snapshots;
}

/**
 * Put the captured offsets back. Called synchronously, after the final height.
 *
 * The `!==` guards matter for more than speed: assigning `scrollTop` fires a
 * `scroll` event even when the value is unchanged in some engines, and this
 * runs on the typing path.
 */
function restoreScrollPositions(snapshots: ScrollSnapshot[]): void {
  for (const { target, top, left } of snapshots) {
    if (target.scrollTop !== top) {
      target.scrollTop = top;
    }

    if (target.scrollLeft !== left) {
      target.scrollLeft = left;
    }
  }
}

/**
 * How many px to add to `scrollHeight` to get the value `style.height` wants.
 *
 * `scrollHeight` measures content + padding. `style.height` sets the BORDER
 * box under `box-sizing: border-box` (Tailwind's default here) and the CONTENT
 * box under `content-box`. Both editor textareas are `border-none`, so today
 * this is 0 either way — it is computed rather than assumed so that adding a
 * border or switching `box-sizing` cannot silently start truncating the last
 * line or growing the field by a few px per keystroke.
 */
function heightAdjustment(style: CSSStyleDeclaration): number {
  const adjustment =
    style.boxSizing === "border-box"
      ? parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
      : -(parseFloat(style.paddingTop) + parseFloat(style.paddingBottom));

  return Number.isFinite(adjustment) ? adjustment : 0;
}

/**
 * Resize `textarea` to fit its content without disturbing any scroll position.
 *
 * Safe to call on every keystroke, and safe to call when nothing changed.
 */
export function autoGrowTextarea(
  textarea: HTMLTextAreaElement | null | undefined,
  { minHeight = 0 }: AutoGrowOptions = {},
): void {
  if (!textarea) {
    return;
  }

  const view = textarea.ownerDocument?.defaultView;

  if (!view) {
    return;
  }

  const adjustment = heightAdjustment(view.getComputedStyle(textarea));
  const applied = textarea.style.height;

  const apply = (target: number): void => {
    const next = `${Math.max(target + adjustment, minHeight)}px`;

    if (next !== applied) {
      textarea.style.height = next;
    }
  };

  // THE GROW PATH — the EXCEPTIONAL case, reached only by a keystroke that
  // actually adds a line (or the first mount). The content overflows the
  // current box, so `scrollHeight` is already the full content extent and no
  // collapse is needed to learn it. Nothing here can clamp a scroll offset,
  // so nothing has to be restored. Most keystrokes do NOT land here: after
  // any resize `clientHeight === scrollHeight`, so a keystroke that doesn't
  // add a line fails this test and falls through to the measure path below —
  // that is the hot path, and its synchronous restore is load-bearing on it.
  if (textarea.scrollHeight > textarea.clientHeight) {
    apply(textarea.scrollHeight);
    return;
  }

  // THE MEASURE PATH. The content FITS the current box, which means it may
  // have shrunk — and `scrollHeight` cannot tell us by how much, because it is
  // defined as the scrolling area and is therefore clamped to at least the
  // padding box. Collapsing and re-measuring is the only way to recover the
  // intrinsic height, so this is the one path that can clamp a scroll offset.
  const snapshots = captureScrollPositions(textarea);

  textarea.style.height = "auto";

  const intrinsic = textarea.scrollHeight;

  // Unconditional: we set `auto` above, so the final height must be written
  // back even when it is identical to what was there before.
  textarea.style.height = `${Math.max(intrinsic + adjustment, minHeight)}px`;

  // SYNCHRONOUS, same task, after the height. See the header comment.
  restoreScrollPositions(snapshots);
}
