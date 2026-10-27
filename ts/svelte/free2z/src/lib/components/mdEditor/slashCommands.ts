import type { Component } from "svelte";
import type { TranslationFunction } from "$lib/i18n";
import {
  AudioLines,
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
  QrCode,
  Sigma,
  Strikethrough,
  Table,
  Video,
} from "@lucide/svelte";
import { editorShortcuts, type PlatformShortcut } from "./shortcuts";
import {
  CONVERSE_SLASH_COMMAND_IDS,
  pickSlashCommands,
} from "./textareaCommands";

export type SlashCommand = {
  /** Stable, untranslated identity — what a host's command subset names. */
  id: string;
  name: string;
  icon: Component;
  insert?: string;
  action?: "open-image-picker" | "open-video-picker";
  description: string;
  shortcut?: PlatformShortcut;
  keywords?: string[];
  selectionStartOffset?: number;
  selectionEndOffset?: number;
};

export function createSlashCommands(t: TranslationFunction): SlashCommand[] {
  const boldText = t("editor.insertTemplates.boldText", "bold text");
  const italicText = t("editor.insertTemplates.italicText", "italic text");
  const struckText = t("editor.insertTemplates.struckText", "struck text");
  const codeText = t("editor.insertTemplates.code", "code");
  const linkText = t("editor.insertTemplates.linkText", "link text");
  const mermaidStart = t("editor.insertTemplates.mermaidStart", "Start");
  const mermaidFinish = t("editor.insertTemplates.mermaidFinish", "Finish");
  const columnOne = t("editor.insertTemplates.columnOne", "Column 1");
  const columnTwo = t("editor.insertTemplates.columnTwo", "Column 2");
  const cellOne = t("editor.insertTemplates.cellOne", "Cell 1");
  const cellTwo = t("editor.insertTemplates.cellTwo", "Cell 2");
  const boldInsert = `**${boldText}**`;
  const italicInsert = `*${italicText}*`;
  const struckInsert = `~~${struckText}~~`;
  const inlineCodeInsert = `\`${codeText}\``;
  const codeBlockPrefix = "```txt\n";
  const codeBlockInsert = `${codeBlockPrefix}${codeText}\n\`\`\``;
  const mermaidPrefix = "```mermaid\n";
  const mermaidBody = `graph TD\n  A[${mermaidStart}] --> B[${mermaidFinish}]`;
  const mermaidInsert = `${mermaidPrefix}${mermaidBody}\n\`\`\``;
  const linkInsert = `[${linkText}](url)`;

  return [
    {
      id: "heading1",
      name: t("editor.commandNames.heading1", "Heading 1"),
      icon: Heading1,
      insert: "# ",
      description: t("editor.slashCommands.heading1", "Large heading"),
      shortcut: editorShortcuts.heading1,
      keywords: ["h1", "title"],
    },
    {
      id: "heading2",
      name: t("editor.commandNames.heading2", "Heading 2"),
      icon: Heading2,
      insert: "## ",
      description: t("editor.slashCommands.heading2", "Medium heading"),
      shortcut: editorShortcuts.heading2,
      keywords: ["h2", "subtitle"],
    },
    {
      id: "heading3",
      name: t("editor.commandNames.heading3", "Heading 3"),
      icon: Heading3,
      insert: "### ",
      description: t("editor.slashCommands.heading3", "Small heading"),
      shortcut: editorShortcuts.heading3,
      keywords: ["h3"],
    },
    {
      id: "heading4",
      name: t("editor.commandNames.heading4", "Heading 4"),
      icon: Heading3,
      insert: "#### ",
      description: t("editor.slashCommands.heading4", "Section heading"),
      shortcut: editorShortcuts.heading4,
      keywords: ["h4"],
    },
    {
      id: "heading5",
      name: t("editor.commandNames.heading5", "Heading 5"),
      icon: Heading3,
      insert: "##### ",
      description: t("editor.slashCommands.heading5", "Minor heading"),
      shortcut: editorShortcuts.heading5,
      keywords: ["h5"],
    },
    {
      id: "heading6",
      name: t("editor.commandNames.heading6", "Heading 6"),
      icon: Heading3,
      insert: "###### ",
      description: t("editor.slashCommands.heading6", "Smallest heading"),
      shortcut: editorShortcuts.heading6,
      keywords: ["h6"],
    },
    {
      id: "bold",
      name: t("editor.commandNames.bold", "Bold"),
      icon: Bold,
      insert: boldInsert,
      description: t("editor.slashCommands.bold", "Make text bold"),
      shortcut: editorShortcuts.bold,
      selectionStartOffset: 2,
      selectionEndOffset: 2 + boldText.length,
    },
    {
      id: "italic",
      name: t("editor.commandNames.italic", "Italic"),
      icon: Italic,
      insert: italicInsert,
      description: t("editor.slashCommands.italic", "Make text italic"),
      shortcut: editorShortcuts.italic,
      selectionStartOffset: 1,
      selectionEndOffset: 1 + italicText.length,
    },
    {
      id: "strikethrough",
      name: t("editor.commandNames.strikethrough", "Strikethrough"),
      icon: Strikethrough,
      insert: struckInsert,
      description: t(
        "editor.slashCommands.strikethrough",
        "Strike through text",
      ),
      shortcut: editorShortcuts.strikethrough,
      keywords: ["strike", "delete"],
      selectionStartOffset: 2,
      selectionEndOffset: 2 + struckText.length,
    },
    {
      id: "inlineCode",
      name: t("editor.commandNames.inlineCode", "Inline code"),
      icon: Code,
      insert: inlineCodeInsert,
      description: t("editor.slashCommands.inlineCode", "Insert inline code"),
      shortcut: editorShortcuts.code,
      keywords: ["code", "snippet"],
      selectionStartOffset: 1,
      selectionEndOffset: 1 + codeText.length,
    },
    {
      id: "inlineMath",
      name: t("editor.commandNames.inlineMath", "Inline math"),
      icon: Sigma,
      insert: "$$x^2$$",
      description: t("editor.slashCommands.inlineMath", "Insert inline LaTeX"),
      keywords: ["math", "latex", "equation", "katex"],
      selectionStartOffset: 2,
      selectionEndOffset: 5,
    },
    {
      id: "mathBlock",
      name: t("editor.commandNames.mathBlock", "Math block"),
      icon: Sigma,
      insert: "$$\n\\frac{a}{b}\n$$",
      description: t(
        "editor.slashCommands.mathBlock",
        "Insert display LaTeX block",
      ),
      keywords: ["math", "latex", "equation", "katex", "display"],
      selectionStartOffset: 3,
      selectionEndOffset: 14,
    },
    {
      id: "codeBlock",
      name: t("editor.commandNames.codeBlock", "Code block"),
      icon: Code,
      insert: codeBlockInsert,
      description: t("editor.slashCommands.code", "Insert code block"),
      keywords: ["fenced", "pre", "block"],
      selectionStartOffset: codeBlockPrefix.length,
      selectionEndOffset: codeBlockPrefix.length + codeText.length,
    },
    {
      id: "numberedCode",
      name: t("editor.commandNames.numberedCode", "Numbered code block"),
      icon: Code,
      insert:
        "```js {1,3} showLineNumbers\nconst example = true;\nconsole.log(example);\nreturn example;\n```",
      description: t(
        "editor.slashCommands.numberedCode",
        "Insert code with line numbers and highlighted lines",
      ),
      keywords: ["code", "line numbers", "highlight", "fenced", "prism"],
      selectionStartOffset: 6,
      selectionEndOffset: 11,
    },
    {
      id: "mermaid",
      name: t("editor.commandNames.mermaid", "Mermaid diagram"),
      icon: Code,
      insert: mermaidInsert,
      description: t(
        "editor.slashCommands.mermaid",
        "Insert Mermaid diagram block",
      ),
      keywords: ["mermaid", "diagram", "flowchart", "graph"],
      selectionStartOffset: mermaidPrefix.length,
      selectionEndOffset: mermaidPrefix.length + mermaidBody.length,
    },
    {
      id: "quote",
      name: t("editor.commandNames.quote", "Quote"),
      icon: Quote,
      insert: "> ",
      description: t("editor.slashCommands.quote", "Insert quote"),
      shortcut: editorShortcuts.quote,
      keywords: ["blockquote"],
    },
    {
      id: "bulletList",
      name: t("editor.commandNames.bulletList", "Bullet list"),
      icon: List,
      insert: "- ",
      description: t("editor.slashCommands.bulletList", "Create bullet list"),
      shortcut: editorShortcuts.bulletList,
      keywords: ["unordered", "ul"],
    },
    {
      id: "numberedList",
      name: t("editor.commandNames.numberedList", "Numbered list"),
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
      id: "taskList",
      name: t("editor.commandNames.taskList", "Task list"),
      icon: List,
      insert: "- [ ] ",
      description: t("editor.slashCommands.taskList", "Create task list"),
      keywords: ["todo", "checkbox", "checklist"],
    },
    {
      id: "link",
      name: t("editor.commandNames.link", "Link"),
      icon: Link2,
      insert: linkInsert,
      description: t("editor.slashCommands.link", "Insert link"),
      shortcut: editorShortcuts.link,
      keywords: ["url", "href"],
      selectionStartOffset: 1,
      selectionEndOffset: 1 + linkText.length,
    },
    {
      id: "image",
      name: t("editor.commandNames.image", "Image"),
      icon: ImageIcon,
      action: "open-image-picker",
      description: t("editor.slashCommands.image", "Insert image"),
      keywords: ["media", "photo", "upload", "cloud", "free2z"],
    },
    {
      id: "embed",
      name: t("editor.commandNames.embed", "Embed"),
      icon: Link2,
      insert: "::embed[https://example.com]",
      description: t("editor.slashCommands.embed", "Insert external embed"),
      keywords: ["video", "youtube", "iframe", "oembed"],
      selectionStartOffset: 8,
      selectionEndOffset: 27,
    },
    {
      id: "audioEmbed",
      name: t("editor.commandNames.audioEmbed", "Audio embed"),
      icon: AudioLines,
      insert: "::embed[/uploadz/path/to/audio.mp3]",
      description: t(
        "editor.slashCommands.audioEmbed",
        "Insert an uploaded audio player",
      ),
      keywords: ["audio", "music", "mp3", "wav", "upload"],
      selectionStartOffset: 8,
      selectionEndOffset: 34,
    },
    {
      id: "iframe",
      name: t("editor.commandNames.iframe", "Iframe"),
      icon: Link2,
      insert: "::iframe[https://example.com]",
      description: t("editor.slashCommands.iframe", "Insert an iframe embed"),
      keywords: ["iframe", "embed", "oembed", "iframely", "url"],
      selectionStartOffset: 9,
      selectionEndOffset: 28,
    },
    {
      id: "qrCode",
      name: t("editor.commandNames.qrCode", "QR code"),
      icon: QrCode,
      insert: "::qrcode[zcash address or content]",
      description: t(
        "editor.slashCommands.qrcode",
        "Insert a scannable QR code",
      ),
      keywords: ["qr", "qrcode", "zcash", "address", "donation"],
      selectionStartOffset: 9,
      selectionEndOffset: 33,
    },
    {
      id: "footnote",
      name: t("editor.commandNames.footnote", "Footnote"),
      icon: ListOrdered,
      insert: "Text with a footnote[^1].\n\n[^1]: Footnote content",
      description: t(
        "editor.slashCommands.footnote",
        "Insert a footnote reference and definition",
      ),
      keywords: ["footnote", "reference", "citation", "note", "gfm"],
      selectionStartOffset: 33,
      selectionEndOffset: 49,
    },
    {
      id: "table",
      name: t("editor.commandNames.table", "Table"),
      icon: Table,
      insert: `| ${columnOne} | ${columnTwo} |\n|----------|----------|\n| ${cellOne} | ${cellTwo} |`,
      description: t("editor.slashCommands.table", "Insert table"),
      keywords: ["gfm", "columns", "grid"],
    },
    {
      id: "divider",
      name: t("editor.commandNames.divider", "Divider"),
      icon: Minus,
      insert: "\n---\n",
      description: t("editor.slashCommands.divider", "Insert horizontal line"),
      keywords: ["hr", "rule", "separator"],
    },
  ];
}

/**
 * The short-post subset Converse offers. Same command objects as the
 * zPage editor — the subset is chosen by id, never re-declared.
 */
export function createConverseSlashCommands(
  t: TranslationFunction,
): SlashCommand[] {
  const commands = pickSlashCommands(
    createSlashCommands(t),
    CONVERSE_SLASH_COMMAND_IDS,
  );
  commands.splice(1, 0, {
    id: "video",
    name: t("editor.videoPicker.addImage", "Add Video"),
    icon: Video,
    action: "open-video-picker",
    description: t("editor.insertVideo", "Insert video"),
    keywords: ["video", "upload", "movie"],
  });
  return commands;
}
