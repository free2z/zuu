import { getCaretCoordinates } from "./utils";

export type MenuPosition = { left: number; top?: number; bottom?: number };

export const VIEWPORT_MARGIN = 8;

const MENU_GAP = 8;

export function getMenuPositionStyle(position: MenuPosition) {
  if (position.bottom !== undefined) {
    return `bottom: ${position.bottom}px; left: ${position.left}px;`;
  }

  return `top: ${position.top ?? VIEWPORT_MARGIN}px; left: ${position.left}px;`;
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

  const spaceBelow = window.innerHeight - belowTop - VIEWPORT_MARGIN;
  const spaceAbove = caretTop - MENU_GAP - VIEWPORT_MARGIN;

  if (maxHeight > spaceBelow && spaceAbove > spaceBelow) {
    const bottom = window.innerHeight - (caretTop - MENU_GAP);
    return { bottom: Math.max(VIEWPORT_MARGIN, bottom), left };
  }

  return { top: Math.max(VIEWPORT_MARGIN, belowTop), left };
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
