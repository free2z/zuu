import { getCaretCoordinates } from "./utils";

export type MenuPosition = {
  left: number;
  top?: number;
  bottom?: number;
  availableHeight?: number;
};

export const VIEWPORT_MARGIN = 8;

const MENU_GAP = 8;

export function getMenuPositionStyle(position: MenuPosition) {
  const heightStyle =
    position.availableHeight === undefined
      ? ""
      : ` --editor-menu-space: ${position.availableHeight}px;`;
  if (position.bottom !== undefined) {
    return `bottom: ${position.bottom}px; left: ${position.left}px;${heightStyle}`;
  }

  return `top: ${position.top ?? VIEWPORT_MARGIN}px; left: ${position.left}px;${heightStyle}`;
}

export function clampMenuPosition(
  coords: { top: number; left: number; bottom?: number; lineHeight?: number },
  width: number,
  maxHeight: number,
): MenuPosition {
  let left = coords.left;
  const caretTop = coords.top;
  const caretBottom = coords.bottom ?? coords.top + (coords.lineHeight ?? 0);
  const belowTop = caretBottom + MENU_GAP;

  if (typeof window === "undefined") {
    return { top: belowTop, left };
  }

  left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN),
  );

  const viewport = window.visualViewport;
  const visibleTop = (viewport?.offsetTop ?? 0) + VIEWPORT_MARGIN;
  const visibleBottom = Math.max(
    visibleTop,
    (viewport?.offsetTop ?? 0) +
      (viewport?.height ?? window.innerHeight) -
      VIEWPORT_MARGIN,
  );
  const top = Math.max(visibleTop, Math.min(belowTop, visibleBottom));
  const aboveBottom = Math.max(
    visibleTop,
    Math.min(caretTop - MENU_GAP, visibleBottom),
  );
  const spaceBelow = visibleBottom - top;
  const spaceAbove = aboveBottom - visibleTop;

  if (maxHeight > spaceBelow && spaceAbove > spaceBelow) {
    // Fixed-position bottom remains relative to the layout viewport, even
    // when the keyboard pans the visual viewport.
    return {
      bottom: window.innerHeight - aboveBottom,
      left,
      availableHeight: spaceAbove,
    };
  }

  return { top, left, availableHeight: spaceBelow };
}

export function getTextareaMenuPosition(
  textarea: HTMLTextAreaElement,
  width: number,
  maxHeight: number,
) {
  return clampMenuPosition(
    getCaretCoordinates(textarea, textarea.selectionStart),
    width,
    maxHeight,
  );
}
