/**
 * The text arithmetic behind the markdown textarea's "/" menu, "+" palette,
 * mentions and formatting shortcuts — shared by the zPage body and the
 * Converse composer since.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyMention,
  applySlashCommand,
  CONVERSE_SLASH_COMMAND_IDS,
  filterSlashCommands,
  getSlashQuery,
  pickSlashCommands,
  resolveFormattingShortcut,
} from "../src/lib/components/mdEditor/textareaCommands.ts";
import { editorShortcuts } from "../src/lib/components/mdEditor/shortcuts.ts";

const slashCommandsSource = await readFile(
  new URL("../src/lib/components/mdEditor/slashCommands.ts", import.meta.url),
  "utf8",
);

const bold = {
  id: "bold",
  name: "Bold",
  description: "Make text bold",
  insert: "**bold text**",
  selectionStartOffset: 2,
  selectionEndOffset: 11,
};
const quote = {
  id: "quote",
  name: "Quote",
  description: "Insert quote",
  insert: "> ",
  keywords: ["blockquote"],
};
const image = {
  id: "image",
  name: "Image",
  description: "Insert image",
  action: "open-image-picker",
};

test("the slash query exists only on a line that starts with '/'", () => {
  assert.equal(getSlashQuery("/Bo", 3), "bo");
  assert.equal(getSlashQuery("first\n/q", 8), "q");
  assert.equal(getSlashQuery("first\n/", 7), "");
  assert.equal(getSlashQuery("1/2", 3), null);
  assert.equal(getSlashQuery("see https://x/y", 15), null);
  // The caret's line, not the document's last line.
  assert.equal(getSlashQuery("/a\nplain", 2), "a");
  assert.equal(getSlashQuery("/a\nplain", 8), null);
});

test("filtering matches name, description and keywords", () => {
  const all = [bold, quote, image];
  assert.deepEqual(filterSlashCommands(all, "BOLD"), [bold]);
  assert.deepEqual(filterSlashCommands(all, "blockq"), [quote]);
  assert.deepEqual(filterSlashCommands(all, "insert"), [quote, image]);
  assert.deepEqual(filterSlashCommands(all, ""), all);
  assert.deepEqual(filterSlashCommands(all, "zzz"), []);
});

test("a typed command replaces its '/query' and selects the template", () => {
  const result = applySlashCommand("hi\n/bo tail", 6, bold, false);
  assert.deepEqual(result, {
    nextValue: "hi\n**bold text** tail",
    selectionStart: 5,
    selectionEnd: 14,
    openImagePicker: false,
  });
});

test("a typed command refuses once the caret has left the '/' line", () => {
  assert.equal(applySlashCommand("/bo\nother", 8, bold, false), null);
});

test("the '+' palette inserts at the caret and never eats text", () => {
  const result = applySlashCommand("/not a command", 14, quote, true);
  assert.deepEqual(result, {
    nextValue: "/not a command> ",
    selectionStart: 16,
    selectionEnd: 16,
    openImagePicker: false,
  });
});

test("the image command clears its query and asks for the picker", () => {
  assert.deepEqual(applySlashCommand("a\n/ima", 6, image, false), {
    nextValue: "a\n",
    selectionStart: 2,
    selectionEnd: 2,
    openImagePicker: true,
  });
  assert.deepEqual(applySlashCommand("ab", 1, image, true), {
    nextValue: "ab",
    selectionStart: 1,
    selectionEnd: 1,
    openImagePicker: true,
  });
});

test("Converse offers a short-post subset, image first, no headings", () => {
  assert.equal(CONVERSE_SLASH_COMMAND_IDS[0], "image");
  assert.ok(CONVERSE_SLASH_COMMAND_IDS.includes("link"));
  for (const longForm of [
    "heading1",
    "heading2",
    "heading3",
    "table",
    "footnote",
    "mermaid",
    "divider",
  ]) {
    assert.equal(
      CONVERSE_SLASH_COMMAND_IDS.includes(longForm),
      false,
      `${longForm} is long-form structure, not a short-post tool`,
    );
  }
  // Every id names a command that actually exists — a typo would silently
  // drop it from the menu.
  const declared = new Set(
    [...slashCommandsSource.matchAll(/^\s+id: "([A-Za-z0-9]+)",$/gm)].map(
      (match) => match[1],
    ),
  );
  assert.ok(declared.size >= 20, "could not read the declared command ids");
  for (const id of CONVERSE_SLASH_COMMAND_IDS) {
    assert.ok(declared.has(id), `${id} is not a declared slash command`);
  }
  //...and the subset is built from those same objects, not re-declared.
  assert.match(
    slashCommandsSource,
    /pickSlashCommands\(\s*createSlashCommands\(t\),\s*CONVERSE_SLASH_COMMAND_IDS,?\s*\)/,
  );
});

test("picking commands follows the id order and skips unknown ids", () => {
  assert.deepEqual(
    pickSlashCommands([bold, quote, image], ["image", "x", "bold"]),
    [image, bold],
  );
});

test("a mention replaces its '@query' with a profile link", () => {
  const value = "hi @sk and more";
  assert.deepEqual(applyMention(value, 6, 3, "skyl", "https://f.test"), {
    nextValue: "hi [skyl](https://f.test/skyl) and more",
    caret: 30,
  });
});

const key = (overrides) => ({
  key: "",
  code: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

test("every advertised shortcut resolves to its action", () => {
  // Built from `editorShortcuts`, the table the toolbar and menus display, so
  // a shortcut that is shown but does nothing fails here.
  const expected = {
    bold: { kind: "inline", marker: "**" },
    italic: { kind: "inline", marker: "*" },
    strikethrough: { kind: "inline", marker: "~~" },
    code: { kind: "inline", marker: "`" },
    link: { kind: "link" },
    orderedList: { kind: "line", format: "ordered" },
    bulletList: { kind: "line", format: "bullet" },
    quote: { kind: "line", format: "quote" },
    heading1: { kind: "heading", level: 1 },
    heading2: { kind: "heading", level: 2 },
    heading3: { kind: "heading", level: 3 },
    heading4: { kind: "heading", level: 4 },
    heading5: { kind: "heading", level: 5 },
    heading6: { kind: "heading", level: 6 },
  };
  const codes = { 7: "Digit7", 8: "Digit8", ".": "Period" };
  assert.deepEqual(
    Object.keys(expected).sort(),
    Object.keys(editorShortcuts).sort(),
  );

  for (const [name, shortcut] of Object.entries(editorShortcuts)) {
    const parts = shortcut.windows.split("+");
    const last = parts.at(-1);
    const event = key({
      ctrlKey: true,
      altKey: parts.includes("Alt"),
      shiftKey: parts.includes("Shift"),
      key: last.toLowerCase(),
      code: codes[last] ?? (/^\d$/.test(last) ? `Digit${last}` : `Key${last}`),
    });
    assert.deepEqual(resolveFormattingShortcut(event), expected[name], name);
    // Cmd on a Mac is the same shortcut.
    assert.deepEqual(
      resolveFormattingShortcut({ ...event, ctrlKey: false, metaKey: true }),
      expected[name],
      `${name} (mac)`,
    );
  }
});

test("plain keys and near-misses are not shortcuts", () => {
  assert.equal(resolveFormattingShortcut(key({ key: "b" })), null);
  assert.equal(
    resolveFormattingShortcut(key({ key: "B", ctrlKey: true, shiftKey: true })),
    null,
  );
  assert.equal(
    resolveFormattingShortcut(key({ key: "x", ctrlKey: true })),
    null,
  );
  assert.equal(
    resolveFormattingShortcut(
      key({
        key: "1",
        code: "Digit1",
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      }),
    ),
    null,
  );
  assert.equal(
    resolveFormattingShortcut(key({ key: "Enter", ctrlKey: true })),
    null,
  );
});

test("a host without headings gets none from the keyboard either", () => {
  const h2 = key({ key: "2", code: "Digit2", ctrlKey: true, altKey: true });
  assert.deepEqual(resolveFormattingShortcut(h2), {
    kind: "heading",
    level: 2,
  });
  assert.equal(resolveFormattingShortcut(h2, { headings: false }), null);
  //...while everything else still works.
  assert.deepEqual(
    resolveFormattingShortcut(key({ key: "b", metaKey: true }), {
      headings: false,
    }),
    { kind: "inline", marker: "**" },
  );
});
