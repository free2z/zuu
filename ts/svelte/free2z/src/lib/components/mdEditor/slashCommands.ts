import type { Component } from "svelte";
import { t } from "$lib/i18n";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Strikethrough,
  Table,
} from "@lucide/svelte";
import { editorShortcuts, type PlatformShortcut } from "./shortcuts";

export type SlashCommand = {
  name: string;
  icon: Component;
  insert?: string;
  action?: "open-image-picker";
  description: string;
  shortcut?: PlatformShortcut;
  keywords?: string[];
  selectionStartOffset?: number;
  selectionEndOffset?: number;
};

export function createSlashCommands(): SlashCommand[] {
  return [
    {
      name: "Heading 1",
      icon: Heading1,
      insert: "# ",
      description: t("editor.slashCommands.heading1", "Large heading"),
      shortcut: editorShortcuts.heading1,
      keywords: ["h1", "title"],
    },
    {
      name: "Heading 2",
      icon: Heading2,
      insert: "## ",
      description: t("editor.slashCommands.heading2", "Medium heading"),
      shortcut: editorShortcuts.heading2,
      keywords: ["h2", "subtitle"],
    },
    {
      name: "Heading 3",
      icon: Heading3,
      insert: "### ",
      description: t("editor.slashCommands.heading3", "Small heading"),
      shortcut: editorShortcuts.heading3,
      keywords: ["h3"],
    },
    {
      name: "Heading 4",
      icon: Heading3,
      insert: "#### ",
      description: t("editor.slashCommands.heading4", "Section heading"),
      shortcut: editorShortcuts.heading4,
      keywords: ["h4"],
    },
    {
      name: "Heading 5",
      icon: Heading3,
      insert: "##### ",
      description: t("editor.slashCommands.heading5", "Minor heading"),
      shortcut: editorShortcuts.heading5,
      keywords: ["h5"],
    },
    {
      name: "Heading 6",
      icon: Heading3,
      insert: "###### ",
      description: t("editor.slashCommands.heading6", "Smallest heading"),
      shortcut: editorShortcuts.heading6,
      keywords: ["h6"],
    },
    {
      name: "Bold",
      icon: Bold,
      insert: "**bold text**",
      description: t("editor.slashCommands.bold", "Make text bold"),
      shortcut: editorShortcuts.bold,
      selectionStartOffset: 2,
      selectionEndOffset: 11,
    },
    {
      name: "Italic",
      icon: Italic,
      insert: "*italic text*",
      description: t("editor.slashCommands.italic", "Make text italic"),
      shortcut: editorShortcuts.italic,
      selectionStartOffset: 1,
      selectionEndOffset: 12,
    },
    {
      name: "Strikethrough",
      icon: Strikethrough,
      insert: "~~struck text~~",
      description: t(
        "editor.slashCommands.strikethrough",
        "Strike through text",
      ),
      shortcut: editorShortcuts.strikethrough,
      keywords: ["strike", "delete"],
      selectionStartOffset: 2,
      selectionEndOffset: 13,
    },
    {
      name: "Inline Code",
      icon: Code,
      insert: "`code`",
      description: t("editor.slashCommands.inlineCode", "Insert inline code"),
      shortcut: editorShortcuts.code,
      keywords: ["code", "snippet"],
      selectionStartOffset: 1,
      selectionEndOffset: 5,
    },
    {
      name: "Inline Math",
      icon: Code,
      insert: "$x^2$",
      description: t("editor.slashCommands.inlineMath", "Insert inline LaTeX"),
      keywords: ["math", "latex", "equation", "katex"],
      selectionStartOffset: 1,
      selectionEndOffset: 4,
    },
    {
      name: "Math Block",
      icon: Code,
      insert: "$$\n\\frac{a}{b}\n$$",
      description: t(
        "editor.slashCommands.mathBlock",
        "Insert display LaTeX block",
      ),
      keywords: ["math", "latex", "equation", "katex", "display"],
      selectionStartOffset: 4,
      selectionEndOffset: 15,
    },
    {
      name: "Code Block",
      icon: Code,
      insert: "```txt\ncode\n```",
      description: t("editor.slashCommands.code", "Insert code block"),
      keywords: ["fenced", "pre", "block"],
      selectionStartOffset: 7,
      selectionEndOffset: 11,
    },
    {
      name: "Mermaid Diagram",
      icon: Code,
      insert: "```mermaid\ngraph TD\n  A[Start] --> B[Finish]\n```",
      description: t(
        "editor.slashCommands.mermaid",
        "Insert Mermaid diagram block",
      ),
      keywords: ["mermaid", "diagram", "flowchart", "graph"],
      selectionStartOffset: 11,
      selectionEndOffset: 44,
    },
    {
      name: "Quote",
      icon: Quote,
      insert: "> ",
      description: t("editor.slashCommands.quote", "Insert quote"),
      shortcut: editorShortcuts.quote,
      keywords: ["blockquote"],
    },
    {
      name: "Bullet List",
      icon: List,
      insert: "- ",
      description: t("editor.slashCommands.bulletList", "Create bullet list"),
      shortcut: editorShortcuts.bulletList,
      keywords: ["unordered", "ul"],
    },
    {
      name: "Numbered List",
      icon: ListOrdered,
      insert: "1. ",
      description: t(
        "editor.slashCommands.numberedList",
        "Create numbered list",
      ),
      shortcut: editorShortcuts.orderedList,
      keywords: ["ordered", "ol"],
    },
    {
      name: "Task List",
      icon: List,
      insert: "- [ ] ",
      description: t("editor.slashCommands.taskList", "Create task list"),
      keywords: ["todo", "checkbox", "checklist"],
    },
    {
      name: "Link",
      icon: Link2,
      insert: "[link text](url)",
      description: t("editor.slashCommands.link", "Insert link"),
      shortcut: editorShortcuts.link,
      keywords: ["url", "href"],
      selectionStartOffset: 1,
      selectionEndOffset: 10,
    },
    {
      name: "Image",
      icon: ImageIcon,
      action: "open-image-picker",
      description: t(
        "editor.slashCommands.image",
        "Upload from device or choose from your cloud",
      ),
      keywords: ["media", "photo", "upload", "cloud", "free2z"],
    },
    {
      name: "Embed",
      icon: Link2,
      insert: "::embed[https://example.com]",
      description: t("editor.slashCommands.embed", "Insert external embed"),
      keywords: ["video", "youtube", "iframe", "oembed"],
      selectionStartOffset: 8,
      selectionEndOffset: 27,
    },
    {
      name: "Table",
      icon: Table,
      insert:
        "| Column 1 | Column 2 |\n|----------|----------|\n| Cell 1   | Cell 2   |",
      description: t("editor.slashCommands.table", "Insert table"),
      keywords: ["gfm", "columns", "grid"],
    },
    {
      name: "Divider",
      icon: Minus,
      insert: "\n---\n",
      description: t("editor.slashCommands.divider", "Insert horizontal line"),
      keywords: ["hr", "rule", "separator"],
    },
  ];
}
