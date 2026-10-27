/**
 * The text arithmetic behind the markdown textarea's menus and shortcuts,
 * shared by the zPage body and the Converse composer.
 *
 * Pure functions over `(value, caret)`: no DOM, no Svelte, no aliased
 * imports, so `tests/textarea-commands.test.mjs` exercises them directly in
 * node. The component-facing wiring lives in `markdownTextarea.svelte.ts`.
 */

/** The fields of a `SlashCommand` this module reads. */
export interface SlashCommandShape {
  id: string;
  name: string;
  description: string;
  keywords?: string[];
  insert?: string;
  action?: "open-image-picker" | "open-video-picker";
  selectionStartOffset?: number;
  selectionEndOffset?: number;
}

// ---------------------------------------------------------------------------
// Slash menu
// ---------------------------------------------------------------------------

/** The text of the caret's line up to the caret. */
export function lineBeforeCaret(value: string, caret: number) {
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  return value.slice(lineStart, caret);
}

/**
 * The search term when the caret sits on a "/..." line, or null.
 *
 * Only a slash at the START of the line opens the menu: a URL or a fraction
 * mid-sentence must not.
 */
export function getSlashQuery(value: string, caret: number): string | null {
  const line = lineBeforeCaret(value, caret);
  return line.startsWith("/") ? line.slice(1).toLowerCase() : null;
}

export function filterSlashCommands<T extends SlashCommandShape>(
  commands: readonly T[],
  term: string,
): T[] {
  const needle = term.toLowerCase();
  return commands.filter((command) =>
    [command.name, command.description, ...(command.keywords ?? [])].some(
      (text) => text.toLowerCase().includes(needle),
    ),
  );
}

export interface SlashCommandResult {
  nextValue: string;
  selectionStart: number;
  selectionEnd: number;
  /** The command is "insert an image": the host opens its picker. */
  openImagePicker: boolean;
  openVideoPicker?: boolean;
}

/**
 * Apply a command chosen from the menu.
 *
 * `fromPalette` is the "+" button's palette, which inserts at the caret. The
 * typed "/..." menu instead REPLACES the "/query" it was opened with — and
 * when the caret has since left that line (a click elsewhere while the menu
 * was open) it returns null, because replacing would eat the current line.
 */
export function applySlashCommand(
  value: string,
  caret: number,
  command: SlashCommandShape,
  fromPalette: boolean,
): SlashCommandResult | null {
  const textBeforeCursor = value.substring(0, caret);
  const textAfterCursor = value.substring(caret);
  const lastLine = lineBeforeCaret(value, caret);
  const slashIndex =
    !fromPalette && lastLine.startsWith("/")
      ? textBeforeCursor.length - lastLine.length
      : -1;

  if (slashIndex === -1 && !fromPalette) {
    return null;
  }

  const newTextBefore =
    slashIndex === -1
      ? textBeforeCursor
      : textBeforeCursor.slice(0, slashIndex);

  if (
    command.action === "open-image-picker" ||
    command.action === "open-video-picker"
  ) {
    const insertionPoint = newTextBefore.length;
    return {
      nextValue: newTextBefore + textAfterCursor,
      selectionStart: insertionPoint,
      selectionEnd: insertionPoint,
      openImagePicker: command.action === "open-image-picker",
      ...(command.action === "open-video-picker"
        ? { openVideoPicker: true }
        : {}),
    };
  }

  const insertText = command.insert ?? "";
  return {
    nextValue: newTextBefore + insertText + textAfterCursor,
    selectionStart:
      newTextBefore.length +
      (command.selectionStartOffset ?? insertText.length),
    selectionEnd:
      newTextBefore.length + (command.selectionEndOffset ?? insertText.length),
    openImagePicker: false,
  };
}

/**
 * The commands a short Converse post is offered, in menu order.
 *
 * Image and link first: they are what a short post reaches for. Headings,
 * tables, footnotes, diagrams and dividers are long-form structure — a
 * 1,000-character post has no sections to head — so they stay in the zPage
 * editor only.
 */
export const CONVERSE_SLASH_COMMAND_IDS = [
  "image",
  "link",
  "bold",
  "italic",
  "strikethrough",
  "inlineCode",
  "quote",
  "bulletList",
  "numberedList",
  "codeBlock",
  "embed",
  "inlineMath",
] as const;

/** `commands` narrowed to `ids`, in the order `ids` lists them. */
export function pickSlashCommands<T extends { id: string }>(
  commands: readonly T[],
  ids: readonly string[],
): T[] {
  const byId = new Map(commands.map((command) => [command.id, command]));
  return ids
    .map((id) => byId.get(id))
    .filter((command): command is T => command !== undefined);
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

/**
 * Replace the "@query" that starts at `start` (and runs to the caret) with a
 * link to the creator's profile.
 */
export function applyMention(
  value: string,
  caret: number,
  start: number,
  username: string,
  origin: string,
) {
  const mentionLink = `[${username}](${origin}/${username})`;
  return {
    nextValue: value.substring(0, start) + mentionLink + value.substring(caret),
    caret: start + mentionLink.length,
  };
}

// ---------------------------------------------------------------------------
// Formatting shortcuts
// ---------------------------------------------------------------------------

export type FormattingShortcut =
  | { kind: "inline"; marker: string }
  | { kind: "link" }
  | { kind: "line"; format: "quote" | "bullet" | "ordered" }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 };

export interface ShortcutKeyEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const HEADING_CODES: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
  Digit4: 4,
  Digit5: 5,
  Digit6: 6,
};

/**
 * The formatting a keystroke asks for, or null. Mirrors `editorShortcuts`
 * in `shortcuts.ts`, which is what the menus and toolbar advertise.
 *
 * `headings: false` drops Cmd/Ctrl+Alt+1..6 — a host without headings in its
 * menu (Converse) must not produce them from the keyboard either.
 */
export function resolveFormattingShortcut(
  event: ShortcutKeyEvent,
  options: { headings?: boolean } = {},
): FormattingShortcut | null {
  const isModifierShortcut = event.metaKey || event.ctrlKey;

  if (!isModifierShortcut) {
    return null;
  }

  if (event.altKey) {
    const level = HEADING_CODES[event.code];
    if (!event.shiftKey && level && options.headings !== false) {
      return { kind: "heading", level };
    }
    return null;
  }

  const key = event.key.toLowerCase();

  if (!event.shiftKey) {
    if (key === "b") return { kind: "inline", marker: "**" };
    if (key === "i") return { kind: "inline", marker: "*" };
    if (key === "e") return { kind: "inline", marker: "`" };
    if (key === "k") return { kind: "link" };
    return null;
  }

  if (key === "x") return { kind: "inline", marker: "~~" };
  if (event.code === "Digit7") return { kind: "line", format: "ordered" };
  if (event.code === "Digit8") return { kind: "line", format: "bullet" };
  if (event.code === "Period") return { kind: "line", format: "quote" };
  return null;
}
