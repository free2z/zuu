/**
 * The behaviour of a markdown `<textarea>` with writing tools, as one object
 * that a host component composes.
 *
 * Two hosts, deliberately different:
 *
 * - `EditorContentField` — the zPage body. Full command set, a gutter "+"
 *   parked on the caret line, auto-grow to at least 400px.
 * - `ConverseComposer` — a short public post. A reduced command set, the "+"
 *   and an image button in its action row, headings off.
 *
 * What they share lives HERE, once: the "/" menu and the "+" palette, the
 * `@mention` menu, the floating formatting toolbar and its shortcuts, list
 * continuation on Enter, and the paste / drop / picker upload pipeline with
 * its placeholder tokens (`inlineUploads.ts`). The host keeps its own markup,
 * layout and anything that is about ITS experience rather than about editing
 * markdown.
 *
 * The pure text arithmetic is in `textareaCommands.ts` and `utils.ts`; this
 * file is the stateful wiring between that arithmetic and a live element.
 *
 * Must be constructed during component initialisation (it registers an
 * `$effect`), and `attach()` must be called from `onMount`.
 */
import { toast, captureAccountToast } from "$lib/toast.js";
import { apiFetch } from "$lib/api/config";
import { creatorList } from "$lib/api/creator/creator";
import type { CreatorList, CreatorListParams } from "$lib/api/f2z.schemas";
import { isUploadRejection, uploadPublicFile } from "$lib/api/uploads";
import {
  UploadRequestError,
  uploadErrorMessage,
} from "$lib/components/media/uploadRequest";
import {
  satisfiesSlot,
  type MediaSlotContext,
} from "$lib/components/media/mediaAccess";
import {
  checkUploadSize,
  confirmOversize,
  formatByteLimit,
  refreshUploadLimit,
} from "$lib/components/media/uploadLimit";
import type { TranslationFunction } from "$lib/i18n";
import type { CoverLibraryImage } from "./coverTypes";
import {
  buildImageMarkdown,
  buildVideoMarkdown,
  createInlineUploader,
} from "./inlineUploads";
import { getMentionContext } from "./mentionContext";
import {
  getTextareaMenuPosition,
  VIEWPORT_MARGIN,
  type MenuPosition,
} from "./menuPosition";
import type { SlashCommand } from "./slashCommands";
import {
  applyMention,
  applySlashCommand,
  filterSlashCommands,
  getSlashQuery,
  resolveFormattingShortcut,
} from "./textareaCommands";
import {
  getCaretCoordinates,
  getDropTextOffset,
  handleMarkdownListEnter,
  insertMarkdownLink,
  toggleInlineMarkdown,
  toggleMarkdownHeading,
  toggleMarkdownLineFormat,
  type EditorSelectionResult,
} from "./utils";

const SLASH_MENU_WIDTH = 360;
const SLASH_MENU_MAX_HEIGHT = 420;
const MENTION_MENU_WIDTH = 320;
const MENTION_MENU_MAX_HEIGHT = 320;
const MENTION_SEARCH_DELAY = 250;
// Half of `EditorFloatingToolbar`'s rendered width (377px measured in
// Chromium), rounded up.
const FLOATING_TOOLBAR_HALF_WIDTH = 190;
const FLOATING_TOOLBAR_HEIGHT = 42;
const FLOATING_TOOLBAR_GAP = 12;

export interface MarkdownTextareaOptions {
  getValue: () => string;
  setValue: (next: string) => void;
  getTextarea: () => HTMLTextAreaElement | null;
  onChange?: () => void;
  /** The commands this host offers. Read reactively. */
  commands: () => SlashCommand[];
  t: () => TranslationFunction;
  locale: () => string;
  /**
   * Who will be able to see what this textarea publishes. An inserted image
   * must be reachable by all of them — see `mediaAccess.ts`.
   *
   * `null` means "we cannot tell", and switches every image path off: paste
   * and drop do not upload, the picker callbacks refuse. An upload is PUBLIC
   * the moment it lands, so guessing wrong here publishes the file.
   */
  mediaSlot: () => MediaSlotContext | null;
  /** Refresh context that can change audience before any image is inserted. */
  beforeMediaInsert?: () => Promise<boolean>;
  /** Shown when an image arrives while `mediaSlot()` is null. */
  uploadsDisabledMessage?: () => string;
  /** "The page this document belongs to is gone." Read live. */
  isAbandoned: () => boolean;
  openImagePicker: (defaultTab?: "device" | "cloud") => void;
  openVideoPicker?: (defaultTab?: "device" | "cloud") => void;
  /** Re-measure the host's layout after a programmatic edit. */
  resize?: () => void;
  /** Runs on every settled selection change (e.g. the gutter "+" mark). */
  onSelectionSettled?: () => void;
  /** Cmd/Ctrl+Alt+1..6. Off for a host whose menu offers no headings. */
  headingShortcuts?: boolean;
  /**
   * Tab inserts two spaces. Right for a long-form body the writer lives in;
   * wrong for a field inside a short form, where Tab must move focus on to
   * the next control or the textarea is a keyboard trap. (A menu that is
   * open still takes Tab as "choose" either way.)
   */
  tabIndents?: boolean;
}

export class MarkdownTextareaController {
  // --- slash menu / "+" palette -------------------------------------------
  showSlashMenu = $state(false);
  // Either `top` (menu opens below the caret) or `bottom` (flipped above the
  // caret line when there isn't room below) is set, never both.
  slashMenuPosition = $state<MenuPosition>({ top: 0, left: 0 });
  selectedSlashCommand = $state(0);
  showCommandPalette = $state(false);
  filteredCommands = $state<SlashCommand[]>([]);
  slashMenuRef = $state<HTMLDivElement | null>(null);
  selectedCommandRefs = $state<HTMLButtonElement[]>([]);

  // --- floating toolbar ---------------------------------------------------
  showFloatingToolbar = $state(false);
  floatingToolbarPosition = $state({ top: 0, left: 0 });

  // --- mention menu -------------------------------------------------------
  showMentionMenu = $state(false);
  mentionMenuPosition = $state<MenuPosition>({ top: 0, left: 0 });
  selectedMention = $state(0);
  mentionResults = $state<CreatorList[]>([]);
  mentionLoading = $state(false);
  mentionMenuRef = $state<HTMLDivElement | null>(null);
  selectedMentionRefs = $state<HTMLButtonElement[]>([]);

  // --- uploads ------------------------------------------------------------
  dragActive = $state(false);
  /** Tokens of uploads whose request has not settled. */
  uploadTokensInFlight = $state<string[]>([]);
  /** Access checks that must settle before the composer can be submitted. */
  pendingMediaChecks = $state(0);
  pendingUploads = $derived(this.uploadTokensInFlight.length);

  #options: MarkdownTextareaOptions;
  #uploader;
  #selectionTimeout: ReturnType<typeof setTimeout> | null = null;
  #pendingListExitLineStart: number | null = null;
  // Set when the user closes the slash menu with Escape so it does not pop
  // straight back open on the next keystroke of the same "/..." line.
  #slashMenuDismissed = false;
  // Same Escape semantics, for the "@..." mention menu.
  #mentionMenuDismissed = false;
  #mentionSearchTimeout: ReturnType<typeof setTimeout> | null = null;
  // Monotonic counter so out-of-order search responses are dropped.
  #mentionRequestId = 0;
  #menuRepositionFrame: number | null = null;

  constructor(options: MarkdownTextareaOptions) {
    this.#options = options;

    $effect(() => {
      this.filteredCommands = options.commands();
    });

    this.#uploader = createInlineUploader(
      {
        insertAt: (offset, text) => {
          this.#pendingListExitLineStart = null;
          this.#splice(offset, offset, text);
        },
        read: () => this.#textarea?.value ?? this.#value,
        replace: (start, end, text) => this.#splice(start, end, text),
      },
      {
        t: options.t,
        locale: options.locale,
        editorAbandoned: options.isAbandoned,
        toast,
        request: apiFetch,
        // `limitChecked`: the pipeline already gated the whole batch on ONE
        // authoritative limit read; a per-file re-check would fan out.
        uploadPublicFile: (file, title) =>
          uploadPublicFile(file, title, { limitChecked: true }),
        isUploadRejection,
        confirmOversize,
        checkUploadSize,
        refreshUploadLimit,
        formatByteLimit,
        describeUploadError: (file, error) =>
          error instanceof UploadRequestError
            ? uploadErrorMessage(
                error,
                options.t(),
                options.locale(),
                file.name,
              )
            : null,
        onPendingChange: (inFlight) => {
          this.uploadTokensInFlight = [...inFlight];
        },
      },
    );
  }

  get #textarea() {
    return this.#options.getTextarea();
  }

  get #value() {
    return this.#options.getValue();
  }

  set #value(next: string) {
    this.#options.setValue(next);
  }

  get #t() {
    return this.#options.t();
  }

  /** May an image be added here at all? See `mediaSlot`. */
  get localUploadsAllowed() {
    const slot = this.#options.mediaSlot();
    return slot !== null && slot.localUploadsAllowed !== false;
  }

  /** Every upload token this textarea ever issued, settled or not. */
  issuedUploadTokens() {
    return this.#uploader.issued;
  }

  #refuseUpload() {
    toast.error(
      this.#options.uploadsDisabledMessage?.() ??
        this.#t(
          "editor.imageAccessUnreachable",
          "Readers of this page cannot open that image yet.",
        ),
    );
  }

  async #runMediaPreflight() {
    if (this.#options.isAbandoned()) return false;
    if (!this.#options.beforeMediaInsert) return true;

    this.pendingMediaChecks += 1;
    try {
      return (
        (await this.#options.beforeMediaInsert()) &&
        !this.#options.isAbandoned()
      );
    } catch {
      return false;
    } finally {
      this.pendingMediaChecks -= 1;
    }
  }

  /**
   * Carry a text offset taken before an async preflight across whatever the
   * writer typed meanwhile. The placeholder used to land synchronously; now
   * it lands after a network read, and a stale offset splits a word
   * (`PREFI![Uploading…](…)X`). Edits only after the offset keep it; edits
   * only before it shift it by the change in length; anything else falls
   * back to the caret.
   */
  #reanchorOffset(offset: number, before: string) {
    const now = this.#value;
    if (now === before) return offset;
    if (now.startsWith(before.slice(0, offset))) return offset;
    const tail = before.slice(offset);
    if (now.endsWith(tail)) return now.length - tail.length;
    return this.#textarea?.selectionStart ?? now.length;
  }

  async #prepareLocalUpload() {
    const operationNotice = captureAccountToast();
    if (!(await this.#runMediaPreflight())) {
      if (!this.#options.isAbandoned()) {
        operationNotice.error(
          this.#t(
            "editor.imageAccessCheckFailed",
            "Could not check who can open that image. Please try again.",
          ),
        );
      }
      return false;
    }

    if (!this.localUploadsAllowed) {
      this.#refuseUpload();
      return false;
    }

    return true;
  }

  #notifyChange() {
    this.#options.onChange?.();
  }

  /** Viewport listeners; call from `onMount` and return the cleanup. */
  attach() {
    const reposition = () => this.scheduleMenuReposition();
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", reposition);
    viewport?.addEventListener("scroll", reposition);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);

    return () => {
      // NOTHING about in-flight uploads belongs here: on `/edit` this also
      // runs on a Write -> Preview switch, which is not the creator leaving.
      // `isAbandoned` is the signal for that.
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      viewport?.removeEventListener("resize", reposition);
      viewport?.removeEventListener("scroll", reposition);

      if (this.#menuRepositionFrame !== null) {
        cancelAnimationFrame(this.#menuRepositionFrame);
      }

      if (this.#selectionTimeout) {
        clearTimeout(this.#selectionTimeout);
      }

      if (this.#mentionSearchTimeout) {
        clearTimeout(this.#mentionSearchTimeout);
      }
    };
  }

  // -------------------------------------------------------------------------
  // Menus
  // -------------------------------------------------------------------------

  #slashPosition(textarea: HTMLTextAreaElement) {
    return getTextareaMenuPosition(
      textarea,
      SLASH_MENU_WIDTH,
      SLASH_MENU_MAX_HEIGHT,
    );
  }

  #mentionPosition(textarea: HTMLTextAreaElement) {
    return getTextareaMenuPosition(
      textarea,
      MENTION_MENU_WIDTH,
      MENTION_MENU_MAX_HEIGHT,
    );
  }

  #floatingPosition(textarea: HTMLTextAreaElement) {
    const startCoords = getCaretCoordinates(textarea, textarea.selectionStart);
    // The bar is centred on `left` and capped to the layout viewport width.
    const halfToolbarWidth = Math.min(
      FLOATING_TOOLBAR_HALF_WIDTH,
      window.innerWidth / 2,
    );
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportBottom =
      viewportTop + (viewport?.height ?? window.innerHeight);
    const minTop = viewportTop + VIEWPORT_MARGIN;
    const maxTop = Math.max(
      minTop,
      viewportBottom - FLOATING_TOOLBAR_HEIGHT - VIEWPORT_MARGIN,
    );
    return {
      top: Math.max(
        minTop,
        Math.min(
          startCoords.top - FLOATING_TOOLBAR_HEIGHT - FLOATING_TOOLBAR_GAP,
          maxTop,
        ),
      ),
      left: Math.max(
        halfToolbarWidth,
        Math.min(startCoords.left + 10, window.innerWidth - halfToolbarWidth),
      ),
    };
  }

  #repositionOpenMenus() {
    const textarea = this.#textarea;
    if (!textarea) {
      return;
    }

    if (this.showSlashMenu) {
      this.slashMenuPosition = this.#slashPosition(textarea);
    }

    if (this.showMentionMenu) {
      this.mentionMenuPosition = this.#mentionPosition(textarea);
    }

    // Re-measure after the host reacts to viewport changes. Reposition only
    // an existing toolbar so scrolling never reopens dismissed writing tools.
    if (this.showFloatingToolbar) {
      this.floatingToolbarPosition = this.#floatingPosition(textarea);
    }
  }

  scheduleMenuReposition = () => {
    if (typeof window === "undefined") {
      return;
    }

    if (this.#menuRepositionFrame !== null) {
      cancelAnimationFrame(this.#menuRepositionFrame);
    }

    this.#menuRepositionFrame = requestAnimationFrame(() => {
      this.#menuRepositionFrame = null;
      this.#repositionOpenMenus();
    });
  };

  #updateSlashMenu(textarea: HTMLTextAreaElement) {
    const searchTerm = getSlashQuery(this.#value, textarea.selectionStart);

    if (searchTerm === null) {
      this.showSlashMenu = false;
      this.showCommandPalette = false;
      this.#slashMenuDismissed = false;
      return;
    }

    if (this.#slashMenuDismissed) {
      this.showSlashMenu = false;
      this.showCommandPalette = false;
      return;
    }

    this.showSlashMenu = true;
    this.slashMenuPosition = this.#slashPosition(textarea);
    this.filteredCommands = filterSlashCommands(
      this.#options.commands(),
      searchTerm,
    );
    this.selectedSlashCommand = 0;
  }

  openCommandPalette = () => {
    const textarea = this.#textarea;
    if (!textarea) {
      return;
    }

    this.closeMentionMenu();
    this.showFloatingToolbar = false;
    this.#slashMenuDismissed = false;
    textarea.focus();
    this.showCommandPalette = true;
    this.showSlashMenu = true;
    this.filteredCommands = this.#options.commands();
    this.selectedSlashCommand = 0;
    this.slashMenuPosition = this.#slashPosition(textarea);
  };

  // The glyph rotates into a close mark while the palette is open, so the
  // control has to actually close it — clicking an "x" that reopens what it
  // is pointing at is worse than never having shown one.
  toggleCommandPalette = () => {
    const textarea = this.#textarea;
    if (!textarea) {
      return;
    }

    if (this.showCommandPalette) {
      this.showCommandPalette = false;
      this.showSlashMenu = false;
      textarea.focus();
      return;
    }

    this.openCommandPalette();
  };

  closeMentionMenu = () => {
    this.showMentionMenu = false;
    this.mentionLoading = false;

    if (this.#mentionSearchTimeout) {
      clearTimeout(this.#mentionSearchTimeout);
      this.#mentionSearchTimeout = null;
    }

    // Invalidate any in-flight search so a late response can't reopen state.
    this.#mentionRequestId += 1;
  };

  async #runMentionSearch(query: string) {
    const requestId = ++this.#mentionRequestId;

    try {
      const params = (query ? { search: query } : {}) as CreatorListParams;
      const response = await creatorList(params);

      if (requestId !== this.#mentionRequestId) {
        return;
      }

      this.mentionResults = response.results ?? [];
      this.selectedMention = 0;
      this.mentionLoading = false;
    } catch {
      if (requestId !== this.#mentionRequestId) {
        return;
      }

      this.mentionResults = [];
      this.mentionLoading = false;
    }
  }

  #scheduleMentionSearch(query: string) {
    if (this.#mentionSearchTimeout) {
      clearTimeout(this.#mentionSearchTimeout);
    }

    this.mentionLoading = true;
    this.#mentionSearchTimeout = setTimeout(() => {
      this.#mentionSearchTimeout = null;
      void this.#runMentionSearch(query);
    }, MENTION_SEARCH_DELAY);
  }

  #updateMentionMenu(textarea: HTMLTextAreaElement) {
    // The slash menu owns the keyboard while it is open — never show both.
    const context = this.showSlashMenu
      ? null
      : getMentionContext(this.#value, textarea.selectionStart);

    if (!context) {
      this.closeMentionMenu();
      this.#mentionMenuDismissed = false;
      return;
    }

    if (this.#mentionMenuDismissed) {
      return;
    }

    // Don't carry results over from a previous "@..." session.
    if (!this.showMentionMenu) {
      this.mentionResults = [];
      this.selectedMention = 0;
    }

    this.showMentionMenu = true;
    this.mentionMenuPosition = this.#mentionPosition(textarea);
    this.#scheduleMentionSearch(context.query);
  }

  insertMention = (creator: CreatorList) => {
    const textarea = this.#textarea;
    if (!textarea) {
      return;
    }

    const context = getMentionContext(this.#value, textarea.selectionStart);

    // The caret may have left the "@..." context while the menu was open
    // (e.g. via a click) — inserting would otherwise mangle the current line.
    if (!context) {
      this.closeMentionMenu();
      return;
    }

    this.#pendingListExitLineStart = null;
    const result = applyMention(
      this.#value,
      textarea.selectionStart,
      context.start,
      creator.username,
      window.location.origin,
    );

    this.#value = result.nextValue;
    this.closeMentionMenu();
    this.#notifyChange();

    setTimeout(() => {
      this.#textarea?.focus();
      this.#textarea?.setSelectionRange(result.caret, result.caret);
      this.handleSelectionChange();
    }, 0);
  };

  #scrollIntoView(element: HTMLButtonElement | undefined, menu: unknown) {
    setTimeout(() => {
      if (element && menu) {
        element.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }, 0);
  }

  insertSlashCommand = (command: SlashCommand) => {
    const textarea = this.#textarea;
    if (!textarea) {
      return;
    }

    this.#pendingListExitLineStart = null;
    const result = applySlashCommand(
      this.#value,
      textarea.selectionStart,
      command,
      this.showCommandPalette,
    );

    // The caret moved off the "/..." line while the menu was open.
    if (!result) {
      this.showSlashMenu = false;
      return;
    }

    this.#value = result.nextValue;
    this.showSlashMenu = false;
    this.showCommandPalette = false;
    this.#notifyChange();

    setTimeout(() => {
      this.#textarea?.focus();
      this.#textarea?.setSelectionRange(
        result.selectionStart,
        result.selectionEnd,
      );
      this.handleSelectionChange();
      if (result.openImagePicker || result.openVideoPicker) {
        const slot = this.#options.mediaSlot();
        if (slot) {
          const openPicker = result.openVideoPicker
            ? this.#options.openVideoPicker
            : this.#options.openImagePicker;
          openPicker?.(slot.localUploadsAllowed === false ? "cloud" : "device");
        } else {
          this.#refuseUpload();
        }
      }
    }, 0);
  };

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  insertAtCursor = (text: string) => {
    const textarea = this.#textarea;
    if (!textarea) {
      return;
    }

    this.#pendingListExitLineStart = null;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = this.#value;

    this.#value = value.substring(0, start) + text + value.substring(end);
    this.#notifyChange();

    setTimeout(() => {
      this.#textarea?.focus();
      const newPosition = start + text.length;
      this.#textarea?.setSelectionRange(newPosition, newPosition);
      this.handleSelectionChange();
    }, 0);
  };

  wrapSelection = (before: string, after: string = before) => {
    const textarea = this.#textarea;
    if (!textarea) {
      return;
    }

    this.#pendingListExitLineStart = null;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = this.#value;
    const selectedText = value.substring(start, end);

    if (selectedText) {
      this.#value =
        value.substring(0, start) +
        before +
        selectedText +
        after +
        value.substring(end);
      this.#notifyChange();

      setTimeout(() => {
        this.#textarea?.focus();
        this.#textarea?.setSelectionRange(
          start + before.length,
          end + before.length,
        );
        this.handleSelectionChange();
      }, 0);
      return;
    }

    this.insertAtCursor(before + after);
  };

  #applySelectionResult(result: EditorSelectionResult) {
    this.#pendingListExitLineStart = null;
    this.#value = result.nextValue;
    this.#notifyChange();

    setTimeout(() => {
      this.#textarea?.focus();
      this.#textarea?.setSelectionRange(
        result.nextSelectionStart,
        result.nextSelectionEnd,
      );
      this.#options.resize?.();
      this.handleSelectionChange();
    }, 0);
  }

  applyInlineShortcut = (marker: string) => {
    const textarea = this.#textarea;
    if (!textarea) return;
    this.#applySelectionResult(
      toggleInlineMarkdown(
        this.#value,
        textarea.selectionStart,
        textarea.selectionEnd,
        marker,
      ),
    );
  };

  applyLinkShortcut = () => {
    const textarea = this.#textarea;
    if (!textarea) return;
    this.#applySelectionResult(
      insertMarkdownLink(
        this.#value,
        textarea.selectionStart,
        textarea.selectionEnd,
        this.#t,
      ),
    );
  };

  applyLineShortcut = (format: "quote" | "bullet" | "ordered") => {
    const textarea = this.#textarea;
    if (!textarea) return;
    this.#applySelectionResult(
      toggleMarkdownLineFormat(
        this.#value,
        textarea.selectionStart,
        textarea.selectionEnd,
        format,
      ),
    );
  };

  applyHeadingShortcut = (level: 1 | 2 | 3 | 4 | 5 | 6) => {
    const textarea = this.#textarea;
    if (!textarea) return;
    this.#applySelectionResult(
      toggleMarkdownHeading(
        this.#value,
        textarea.selectionStart,
        textarea.selectionEnd,
        level,
      ),
    );
  };

  // -------------------------------------------------------------------------
  // Event handlers — wire these straight onto the <textarea>
  // -------------------------------------------------------------------------

  handleInput = (event: Event) => {
    const textarea = event.currentTarget as HTMLTextAreaElement;
    this.#pendingListExitLineStart = null;
    this.#value = textarea.value;
    this.#options.resize?.();
    // Typing means the editor has left the explicit insert palette. If the
    // new line starts with "/", the contextual slash menu reopens and applies
    // its normal replacement behaviour.
    this.showCommandPalette = false;
    this.#updateSlashMenu(textarea);
    this.#updateMentionMenu(textarea);
    this.scheduleMenuReposition();
    this.handleSelectionChange();
    this.#notifyChange();
  };

  handleKeyDown = (event: KeyboardEvent) => {
    // While an IME is composing (Japanese, Chinese, Korean…) Enter confirms a
    // candidate and arrows move within it. Treating those as menu, shortcut
    // or list-continuation keys breaks the composition and edits the text.
    // `keyCode === 229` is the Safari/older-Chromium signal for the same
    // state (codex review of ).
    if (event.isComposing || event.keyCode === 229) {
      return;
    }

    if (this.showMentionMenu) {
      const results = this.mentionResults;

      if (results.length > 0 && event.key === "ArrowDown") {
        event.preventDefault();
        this.selectedMention = Math.min(
          this.selectedMention + 1,
          results.length - 1,
        );
        this.#scrollIntoView(
          this.selectedMentionRefs[this.selectedMention],
          this.mentionMenuRef,
        );
        return;
      }

      if (results.length > 0 && event.key === "ArrowUp") {
        event.preventDefault();
        this.selectedMention = Math.max(this.selectedMention - 1, 0);
        this.#scrollIntoView(
          this.selectedMentionRefs[this.selectedMention],
          this.mentionMenuRef,
        );
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        const selectedCreator = results[this.selectedMention];

        if (selectedCreator) {
          event.preventDefault();
          this.insertMention(selectedCreator);
          return;
        }

        // No creator to insert — close the menu and let the key behave
        // normally (newline / indent) instead of being swallowed.
        this.closeMentionMenu();
      }

      if (event.key === "Escape") {
        event.preventDefault();
        this.closeMentionMenu();
        this.#mentionMenuDismissed = true;
        return;
      }
    }

    if (this.showSlashMenu) {
      const commands = this.filteredCommands;

      if (commands.length > 0 && event.key === "ArrowDown") {
        event.preventDefault();
        this.selectedSlashCommand = Math.min(
          this.selectedSlashCommand + 1,
          commands.length - 1,
        );
        this.#scrollIntoView(
          this.selectedCommandRefs[this.selectedSlashCommand],
          this.slashMenuRef,
        );
        return;
      }

      if (commands.length > 0 && event.key === "ArrowUp") {
        event.preventDefault();
        this.selectedSlashCommand = Math.max(this.selectedSlashCommand - 1, 0);
        this.#scrollIntoView(
          this.selectedCommandRefs[this.selectedSlashCommand],
          this.slashMenuRef,
        );
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        const selectedCommand = commands[this.selectedSlashCommand];

        if (selectedCommand) {
          event.preventDefault();
          this.insertSlashCommand(selectedCommand);
          return;
        }

        // No matching command — close the menu and let the key behave
        // normally (newline / indent) instead of being swallowed.
        this.showSlashMenu = false;
        this.showCommandPalette = false;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        this.showSlashMenu = false;
        this.#slashMenuDismissed = !this.showCommandPalette;
        this.showCommandPalette = false;
        return;
      }
    }

    const shortcut = resolveFormattingShortcut(event, {
      headings: this.#options.headingShortcuts !== false,
    });

    if (shortcut) {
      event.preventDefault();
      switch (shortcut.kind) {
        case "heading":
          this.applyHeadingShortcut(shortcut.level);
          break;
        case "inline":
          this.applyInlineShortcut(shortcut.marker);
          break;
        case "link":
          this.applyLinkShortcut();
          break;
        case "line":
          this.applyLineShortcut(shortcut.format);
          break;
      }
      return;
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const textarea = this.#textarea;
      const value = this.#value;
      const selectionStart = textarea?.selectionStart ?? 0;
      const selectionEnd = textarea?.selectionEnd ?? 0;
      const currentLineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
      const listEnterResult = handleMarkdownListEnter(
        value,
        selectionStart,
        selectionEnd,
        this.#pendingListExitLineStart === currentLineStart,
      );

      if (listEnterResult) {
        event.preventDefault();
        this.#pendingListExitLineStart =
          listEnterResult.pendingEmptyListItemLineStart;
        this.#value = listEnterResult.nextValue;
        this.#notifyChange();

        setTimeout(() => {
          this.#textarea?.focus();
          this.#textarea?.setSelectionRange(
            listEnterResult.nextSelectionStart,
            listEnterResult.nextSelectionEnd,
          );
          this.#options.resize?.();
          this.handleSelectionChange();
        }, 0);
        return;
      }
    }

    if (event.key === "Tab" && this.#options.tabIndents !== false) {
      event.preventDefault();
      this.insertAtCursor("  ");
    }
  };

  handleSelectionChange = () => {
    if (this.#selectionTimeout) {
      clearTimeout(this.#selectionTimeout);
    }

    this.#selectionTimeout = setTimeout(() => {
      this.#selectionTimeout = null;
      const textarea = this.#textarea;

      if (!textarea) {
        this.showFloatingToolbar = false;
        this.showSlashMenu = false;
        this.showCommandPalette = false;
        return;
      }

      this.#options.onSelectionSettled?.();

      const value = this.#value;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;

      // Close the slash menu when the caret leaves the "/..." context (e.g.
      // the user clicked elsewhere) so its key handling stops hijacking input.
      if (this.showSlashMenu && !this.showCommandPalette) {
        if (getSlashQuery(value, start) === null) {
          this.showSlashMenu = false;
        }
      }

      // Same for the mention menu and its "@..." context.
      if (this.showMentionMenu && !getMentionContext(value, start)) {
        this.closeMentionMenu();
      }

      if (this.showCommandPalette) {
        this.slashMenuPosition = this.#slashPosition(textarea);
        this.showFloatingToolbar = false;
        return;
      }

      if (start !== end && value.substring(start, end).trim().length > 0) {
        this.floatingToolbarPosition = this.#floatingPosition(textarea);
        this.showFloatingToolbar = true;
        return;
      }

      this.showFloatingToolbar = false;
    }, 50);
  };

  handleBlur = () => {
    setTimeout(() => {
      // The user may have returned to editing before this blur settled.
      // Retire only the tools belonging to an editor that is still blurred.
      if (document.activeElement === this.#textarea) {
        return;
      }

      this.showFloatingToolbar = false;
      this.showSlashMenu = false;
      this.showCommandPalette = false;
      this.closeMentionMenu();
    }, 200);
  };

  handlePaste = (event: ClipboardEvent) => {
    const clipboard = event.clipboardData;
    const images = Array.from(clipboard?.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );

    if (!images.length) {
      return;
    }

    // Copies from Office/web pages carry a text rendition the user usually
    // wants — let the default text paste win over the attached image files.
    if (clipboard?.types.includes("text/plain")) {
      return;
    }

    event.preventDefault();

    const offset = this.#textarea?.selectionStart ?? this.#value.length;
    const before = this.#value;
    void this.#prepareLocalUpload().then((allowed) => {
      if (allowed) {
        void this.#uploader.startInlineUploads(
          images,
          this.#reanchorOffset(offset, before),
        );
      }
    });
  };

  handleDragOver = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    this.dragActive = true;
  };

  handleDragLeave = () => {
    this.dragActive = false;
  };

  handleDrop = (event: DragEvent) => {
    this.dragActive = false;
    const files = Array.from(event.dataTransfer?.files ?? []);

    if (!files.length) {
      return;
    }

    // Always claim file drops so the browser never navigates away from the
    // editor (and unsaved work) to open the dropped file.
    event.preventDefault();

    const images = files.filter((file) => file.type.startsWith("image/"));

    if (!images.length) {
      toast.error(
        this.#t(
          "editor.onlyImagesDrop",
          "Only image files can be dropped here.",
        ),
      );
      return;
    }

    const textarea = this.#textarea;
    if (!textarea) {
      return;
    }

    textarea.focus();
    const offset = getDropTextOffset(textarea, event);
    const before = this.#value;
    void this.#prepareLocalUpload().then((allowed) => {
      if (allowed) {
        void this.#uploader.startInlineUploads(
          images,
          this.#reanchorOffset(offset, before),
        );
      }
    });
  };

  // -------------------------------------------------------------------------
  // Image picker callbacks
  // -------------------------------------------------------------------------

  /**
   * `EditorImagePicker`'s `onUploadLocalImages`. Resolves `false` when the
   * upload was refused, so the picker keeps the writer's selection open for
   * a retry instead of closing and discarding it.
   */
  insertLocalImages = async (files: File[], mediaKind?: "video") => {
    if (!files.length) {
      return true;
    }

    if (!(await this.#prepareLocalUpload())) return false;

    this.#textarea?.focus();
    void this.#uploader.startInlineUploads(
      files,
      this.#textarea?.selectionStart ?? this.#value.length,
      mediaKind,
    );
    return true;
  };

  /**
   * `EditorImagePicker`'s `onChooseCloudImage`: insert a file the creator
   * already owns, BY REFERENCE.
   *
   * This used to download any non-public file and re-upload it as a brand new
   * PUBLIC copy, silently — publishing a private file's bytes with no consent
   * and duplicating storage on every insert. `EditorImagePicker` now
   * gates the choice and promotes the ORIGINAL when the creator agrees, so the
   * item's own `url` is the right one.
   *
   * The guard below is not redundant with that gate. It is what keeps a future
   * caller — or a picker regression — from re-introducing the broken (or, on
   * Converse, the unreadable) image quietly, and it costs a comparison.
   */
  insertCloudImage = async (item: CoverLibraryImage) => {
    const t = this.#t;
    const title =
      item.title ||
      item.name ||
      t("editor.imageFallback", "Image {id}", { id: item.id });

    if (!item.url) {
      throw new Error(
        t("editor.cloudImageOpenFailed", "Unable to open that image."),
      );
    }

    if (!(await this.#runMediaPreflight())) {
      if (this.#options.isAbandoned()) return;
      throw new Error(
        t(
          "editor.imageAccessCheckFailed",
          "Could not check who can open that image. Please try again.",
        ),
      );
    }

    const slot = this.#options.mediaSlot();

    if (!slot || !satisfiesSlot(item.access, slot)) {
      throw new Error(
        t(
          "editor.imageAccessUnreachable",
          "Readers of this page cannot open that image yet.",
        ),
      );
    }

    // Keep the URL relative — the markdown renderer prefixes /uploadz/ paths
    // with the API base in both preview and published pages.
    this.#insertImageMarkdownAtCursor(
      item.mime_type?.startsWith("video/")
        ? buildVideoMarkdown(item.url)
        : buildImageMarkdown(title, item.url, t),
    );
  };

  // -------------------------------------------------------------------------
  // Low-level splicing
  // -------------------------------------------------------------------------

  /**
   * Replace `[start, end)` in the live document.
   *
   * With a textarea, `setRangeText` keeps the native undo stack intact, and
   * the synthetic `input` re-enters the normal path so bindings, resize, the
   * menus and `onChange` all stay in sync. Without one (the host is showing a
   * preview) the bound model is spliced instead.
   */
  #splice(
    start: number,
    end: number,
    text: string,
    selectionMode: SelectionMode = "preserve",
  ) {
    const textarea = this.#textarea;

    if (textarea) {
      textarea.setRangeText(text, start, end, selectionMode);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    const value = this.#value;
    this.#value = value.slice(0, start) + text + value.slice(end);
    this.#notifyChange();
  }

  #insertImageMarkdownAtCursor(markdown: string) {
    this.#pendingListExitLineStart = null;
    const textarea = this.#textarea;

    if (!textarea) {
      const value = this.#value;
      const needsLeadingBreak = value.length > 0 && !value.endsWith("\n");
      this.#value = `${value}${needsLeadingBreak ? "\n" : ""}${markdown}\n`;
      this.#notifyChange();
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const needsLeadingBreak = before.length > 0 && !before.endsWith("\n");
    const needsTrailingBreak = after.length > 0 && !after.startsWith("\n");
    const insertion = `${needsLeadingBreak ? "\n" : ""}${markdown}${
      needsTrailingBreak ? "\n" : ""
    }`;

    textarea.focus();
    this.#splice(start, end, insertion, "end");
  }
}
