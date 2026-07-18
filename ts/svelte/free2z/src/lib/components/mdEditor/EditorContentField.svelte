<script lang="ts">
  import { tStore as t } from "$lib/i18n";
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { toast } from "svelte-sonner";
  import { authStore } from "$lib/stores/auth";
  import {
    formatByteLimit,
    maxUploadBytesFor,
    uploadPublicFile,
  } from "$lib/api/uploads";
  import EditorFloatingToolbar from "./EditorFloatingToolbar.svelte";
  import EditorImagePicker from "./EditorImagePicker.svelte";
  import EditorMentionMenu from "./EditorMentionMenu.svelte";
  import EditorSlashMenu from "./EditorSlashMenu.svelte";
  import { creatorList } from "$lib/api/creator/creator";
  import type { CreatorList, CreatorListParams } from "$lib/api/f2z.schemas";
  import type { CoverLibraryImage } from "./coverTypes";
  import { detectMacPlatform } from "./shortcuts";
  import { getMentionContext } from "./mentionContext";
  import {
    getTextareaMenuPosition,
    VIEWPORT_MARGIN,
    type MenuPosition,
  } from "./menuPosition";
  import { createSlashCommands, type SlashCommand } from "./slashCommands";
  import {
    buildImageMarkdown,
    buildUploadPlaceholder,
    createUploadToken,
    findUploadPlaceholder,
    getCaretCoordinates,
    getDropTextOffset,
    handleMarkdownListEnter,
    insertMarkdownLink,
    resolveMediaUrl,
    toggleInlineMarkdown,
    toggleMarkdownHeading,
    toggleMarkdownLineFormat,
    type EditorSelectionResult,
  } from "./utils";

  interface Props {
    value: string;
    onChange?: () => void;
  }

  let { value = $bindable(), onChange }: Props = $props();

  let textareaRef = $state<HTMLTextAreaElement | null>(null);
  let slashMenuRef = $state<HTMLDivElement | null>(null);
  let selectedCommandRefs = $state<HTMLButtonElement[]>([]);
  let showSlashMenu = $state(false);
  // Either `top` (menu opens below the caret) or `bottom` (flipped above the
  // caret line when there isn't room below) is set, never both.
  let slashMenuPosition = $state<MenuPosition>({ top: 0, left: 0 });
  let selectedSlashCommand = $state(0);
  let showFloatingToolbar = $state(false);
  let floatingToolbarPosition = $state({ top: 0, left: 0 });
  let imagePickerRef = $state<{
    openPicker: (defaultTab?: "device" | "cloud") => void;
  } | null>(null);
  let selectionTimeout = $state<ReturnType<typeof setTimeout> | null>(null);
  let pendingListExitLineStart = $state<number | null>(null);
  let isMac = $state(false);
  let dragActive = $state(false);
  // Set when the user closes the slash menu with Escape so it does not pop
  // straight back open on the next keystroke of the same "/..." line.
  let slashMenuDismissed = false;
  let mentionMenuRef = $state<HTMLDivElement | null>(null);
  let selectedMentionRefs = $state<HTMLButtonElement[]>([]);
  let showMentionMenu = $state(false);
  let mentionMenuPosition = $state<MenuPosition>({ top: 0, left: 0 });
  let selectedMention = $state(0);
  let mentionResults = $state<CreatorList[]>([]);
  let mentionLoading = $state(false);
  // Same Escape semantics as slashMenuDismissed, for the "@..." mention menu.
  let mentionMenuDismissed = false;
  let mentionSearchTimeout: ReturnType<typeof setTimeout> | null = null;
  // Monotonic counter so out-of-order search responses are dropped.
  let mentionRequestId = 0;

  const SLASH_MENU_WIDTH = 360;
  const SLASH_MENU_MAX_HEIGHT = 420;
  const MENTION_MENU_WIDTH = 320;
  const MENTION_MENU_MAX_HEIGHT = 320;
  const MENTION_SEARCH_DELAY = 250;

  function resizeTextarea() {
    if (!textareaRef) {
      return;
    }

    textareaRef.style.height = "auto";
    textareaRef.style.height = `${Math.max(textareaRef.scrollHeight, 400)}px`;
  }

  const slashCommands = createSlashCommands();
  let filteredCommands = $state<SlashCommand[]>(slashCommands);

  function notifyChange() {
    onChange?.();
  }

  let menuRepositionFrame: number | null = null;

  function getSlashMenuPosition(textarea: HTMLTextAreaElement) {
    return getTextareaMenuPosition(
      textarea,
      SLASH_MENU_WIDTH,
      SLASH_MENU_MAX_HEIGHT,
    );
  }

  function getMentionMenuPosition(textarea: HTMLTextAreaElement) {
    return getTextareaMenuPosition(
      textarea,
      MENTION_MENU_WIDTH,
      MENTION_MENU_MAX_HEIGHT,
    );
  }

  function repositionOpenMenus() {
    if (!textareaRef) {
      return;
    }

    if (showSlashMenu) {
      slashMenuPosition = getSlashMenuPosition(textareaRef);
    }

    if (showMentionMenu) {
      mentionMenuPosition = getMentionMenuPosition(textareaRef);
    }
  }

  function scheduleMenuReposition() {
    if (typeof window === "undefined") {
      return;
    }

    if (menuRepositionFrame !== null) {
      cancelAnimationFrame(menuRepositionFrame);
    }

    menuRepositionFrame = requestAnimationFrame(() => {
      menuRepositionFrame = null;
      repositionOpenMenus();
    });
  }

  function updateSlashMenu(textarea: HTMLTextAreaElement) {
    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = value.substring(0, cursorPos);
    const lastLine = textBeforeCursor.split("\n").pop() || "";

    if (!lastLine.startsWith("/")) {
      showSlashMenu = false;
      slashMenuDismissed = false;
      return;
    }

    if (slashMenuDismissed) {
      showSlashMenu = false;
      return;
    }

    showSlashMenu = true;
    slashMenuPosition = getSlashMenuPosition(textarea);

    const searchTerm = lastLine.substring(1).toLowerCase();
    filteredCommands = slashCommands.filter((command) =>
      [command.name, command.description, ...(command.keywords ?? [])].some(
        (value) => value.toLowerCase().includes(searchTerm),
      ),
    );
    selectedSlashCommand = 0;
  }

  function closeMentionMenu() {
    showMentionMenu = false;
    mentionLoading = false;

    if (mentionSearchTimeout) {
      clearTimeout(mentionSearchTimeout);
      mentionSearchTimeout = null;
    }

    // Invalidate any in-flight search so a late response can't reopen state.
    mentionRequestId += 1;
  }

  async function runMentionSearch(query: string) {
    const requestId = ++mentionRequestId;

    try {
      const params = (query ? { search: query } : {}) as CreatorListParams;
      const response = await creatorList(params);

      if (requestId !== mentionRequestId) {
        return;
      }

      mentionResults = response.results ?? [];
      selectedMention = 0;
      mentionLoading = false;
    } catch {
      if (requestId !== mentionRequestId) {
        return;
      }

      mentionResults = [];
      mentionLoading = false;
    }
  }

  function scheduleMentionSearch(query: string) {
    if (mentionSearchTimeout) {
      clearTimeout(mentionSearchTimeout);
    }

    mentionLoading = true;
    mentionSearchTimeout = setTimeout(() => {
      mentionSearchTimeout = null;
      void runMentionSearch(query);
    }, MENTION_SEARCH_DELAY);
  }

  function updateMentionMenu(textarea: HTMLTextAreaElement) {
    // The slash menu owns the keyboard while it is open — never show both.
    const context = showSlashMenu
      ? null
      : getMentionContext(value, textarea.selectionStart);

    if (!context) {
      closeMentionMenu();
      mentionMenuDismissed = false;
      return;
    }

    if (mentionMenuDismissed) {
      return;
    }

    // Don't carry results over from a previous "@..." session.
    if (!showMentionMenu) {
      mentionResults = [];
      selectedMention = 0;
    }

    showMentionMenu = true;
    mentionMenuPosition = getMentionMenuPosition(textarea);
    scheduleMentionSearch(context.query);
  }

  function insertMention(creator: CreatorList) {
    if (!textareaRef) {
      return;
    }

    const context = getMentionContext(value, textareaRef.selectionStart);

    // The caret may have left the "@..." context while the menu was open
    // (e.g. via a click) — inserting would otherwise mangle the current line.
    if (!context) {
      closeMentionMenu();
      return;
    }

    pendingListExitLineStart = null;
    const cursorPos = textareaRef.selectionStart;
    const mentionLink = `[${creator.username}](${window.location.origin}/${creator.username})`;
    const textBefore = value.substring(0, context.start);
    const textAfter = value.substring(cursorPos);

    value = textBefore + mentionLink + textAfter;
    closeMentionMenu();
    notifyChange();

    setTimeout(() => {
      const newPosition = context.start + mentionLink.length;
      textareaRef?.focus();
      textareaRef?.setSelectionRange(newPosition, newPosition);
      handleSelectionChange();
    }, 0);
  }

  function handleInput(event: Event) {
    const textarea = event.currentTarget as HTMLTextAreaElement;
    pendingListExitLineStart = null;
    value = textarea.value;
    resizeTextarea();
    updateSlashMenu(textarea);
    updateMentionMenu(textarea);
    scheduleMenuReposition();
    handleSelectionChange();
    notifyChange();
  }

  function scrollSelectedCommandIntoView() {
    setTimeout(() => {
      const selectedElement = selectedCommandRefs[selectedSlashCommand];

      if (selectedElement && slashMenuRef) {
        selectedElement.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      }
    }, 0);
  }

  function scrollSelectedMentionIntoView() {
    setTimeout(() => {
      const selectedElement = selectedMentionRefs[selectedMention];

      if (selectedElement && mentionMenuRef) {
        selectedElement.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      }
    }, 0);
  }

  function insertAtCursor(text: string) {
    if (!textareaRef) {
      return;
    }

    pendingListExitLineStart = null;
    const start = textareaRef.selectionStart;
    const end = textareaRef.selectionEnd;
    const textBefore = value.substring(0, start);
    const textAfter = value.substring(end);

    value = textBefore + text + textAfter;
    notifyChange();

    setTimeout(() => {
      textareaRef?.focus();
      const newPosition = start + text.length;
      textareaRef?.setSelectionRange(newPosition, newPosition);
      handleSelectionChange();
    }, 0);
  }

  function wrapSelection(before: string, after: string = before) {
    if (!textareaRef) {
      return;
    }

    pendingListExitLineStart = null;
    const start = textareaRef.selectionStart;
    const end = textareaRef.selectionEnd;
    const selectedText = value.substring(start, end);
    const textBefore = value.substring(0, start);
    const textAfter = value.substring(end);

    if (selectedText) {
      value = textBefore + before + selectedText + after + textAfter;
      notifyChange();

      setTimeout(() => {
        textareaRef?.focus();
        textareaRef?.setSelectionRange(
          start + before.length,
          end + before.length,
        );
        handleSelectionChange();
      }, 0);
      return;
    }

    insertAtCursor(before + after);
  }

  function insertSlashCommand(command: SlashCommand) {
    if (!textareaRef) {
      return;
    }

    pendingListExitLineStart = null;
    const cursorPos = textareaRef.selectionStart;
    const textBeforeCursor = value.substring(0, cursorPos);
    const textAfterCursor = value.substring(cursorPos);
    const lines = textBeforeCursor.split("\n");
    const lastLine = lines[lines.length - 1] || "";
    const slashIndex = lastLine.lastIndexOf("/");

    // The caret may have moved off the "/..." line while the menu was open
    // (e.g. via a click) — inserting would otherwise eat the current line.
    if (slashIndex === -1) {
      showSlashMenu = false;
      return;
    }

    lines[lines.length - 1] = lastLine.substring(0, slashIndex);

    const newTextBefore = lines.join("\n");

    if (command.action === "open-image-picker") {
      const insertionPoint = newTextBefore.length;
      value = newTextBefore + textAfterCursor;
      showSlashMenu = false;
      notifyChange();

      setTimeout(() => {
        textareaRef?.focus();
        textareaRef?.setSelectionRange(insertionPoint, insertionPoint);
        handleSelectionChange();
        imagePickerRef?.openPicker("device");
      }, 0);
      return;
    }

    const insertText = command.insert ?? "";
    value = newTextBefore + insertText + textAfterCursor;
    showSlashMenu = false;
    notifyChange();

    setTimeout(() => {
      const selectionStart =
        newTextBefore.length +
        (command.selectionStartOffset ?? insertText.length);
      const selectionEnd =
        newTextBefore.length +
        (command.selectionEndOffset ?? insertText.length);
      textareaRef?.focus();
      textareaRef?.setSelectionRange(selectionStart, selectionEnd);
      handleSelectionChange();
    }, 0);
  }

  function applyEditorSelectionResult(result: EditorSelectionResult) {
    pendingListExitLineStart = null;
    value = result.nextValue;
    notifyChange();

    setTimeout(() => {
      textareaRef?.focus();
      textareaRef?.setSelectionRange(
        result.nextSelectionStart,
        result.nextSelectionEnd,
      );
      resizeTextarea();
      handleSelectionChange();
    }, 0);
  }

  function applyInlineShortcut(marker: string) {
    if (!textareaRef) {
      return;
    }

    applyEditorSelectionResult(
      toggleInlineMarkdown(
        value,
        textareaRef.selectionStart,
        textareaRef.selectionEnd,
        marker,
      ),
    );
  }

  function applyLinkShortcut() {
    if (!textareaRef) {
      return;
    }

    applyEditorSelectionResult(
      insertMarkdownLink(
        value,
        textareaRef.selectionStart,
        textareaRef.selectionEnd,
      ),
    );
  }

  function applyLineShortcut(format: "quote" | "bullet" | "ordered") {
    if (!textareaRef) {
      return;
    }

    applyEditorSelectionResult(
      toggleMarkdownLineFormat(
        value,
        textareaRef.selectionStart,
        textareaRef.selectionEnd,
        format,
      ),
    );
  }

  function applyHeadingShortcut(level: 1 | 2 | 3 | 4 | 5 | 6) {
    if (!textareaRef) {
      return;
    }

    applyEditorSelectionResult(
      toggleMarkdownHeading(
        value,
        textareaRef.selectionStart,
        textareaRef.selectionEnd,
        level,
      ),
    );
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (showMentionMenu) {
      if (mentionResults.length > 0 && event.key === "ArrowDown") {
        event.preventDefault();
        selectedMention = Math.min(
          selectedMention + 1,
          mentionResults.length - 1,
        );
        scrollSelectedMentionIntoView();
        return;
      }

      if (mentionResults.length > 0 && event.key === "ArrowUp") {
        event.preventDefault();
        selectedMention = Math.max(selectedMention - 1, 0);
        scrollSelectedMentionIntoView();
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        const selectedCreator = mentionResults[selectedMention];

        if (selectedCreator) {
          event.preventDefault();
          insertMention(selectedCreator);
          return;
        }

        // No creator to insert — close the menu and let the key behave
        // normally (newline / indent) instead of being swallowed.
        closeMentionMenu();
      }

      if (event.key === "Escape") {
        event.preventDefault();
        closeMentionMenu();
        mentionMenuDismissed = true;
        return;
      }
    }

    if (showSlashMenu) {
      if (filteredCommands.length > 0 && event.key === "ArrowDown") {
        event.preventDefault();
        selectedSlashCommand = Math.min(
          selectedSlashCommand + 1,
          filteredCommands.length - 1,
        );
        scrollSelectedCommandIntoView();
        return;
      }

      if (filteredCommands.length > 0 && event.key === "ArrowUp") {
        event.preventDefault();
        selectedSlashCommand = Math.max(selectedSlashCommand - 1, 0);
        scrollSelectedCommandIntoView();
        return;
      }

      if (event.key === "Enter" || event.key === "Tab") {
        const selectedCommand = filteredCommands[selectedSlashCommand];

        if (selectedCommand) {
          event.preventDefault();
          insertSlashCommand(selectedCommand);
          return;
        }

        // No matching command — close the menu and let the key behave
        // normally (newline / indent) instead of being swallowed.
        showSlashMenu = false;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        showSlashMenu = false;
        slashMenuDismissed = true;
        return;
      }
    }

    const isModifierShortcut = event.metaKey || event.ctrlKey;

    if (isModifierShortcut && event.altKey && !event.shiftKey) {
      if (event.code === "Digit1") {
        event.preventDefault();
        applyHeadingShortcut(1);
        return;
      }

      if (event.code === "Digit2") {
        event.preventDefault();
        applyHeadingShortcut(2);
        return;
      }

      if (event.code === "Digit3") {
        event.preventDefault();
        applyHeadingShortcut(3);
        return;
      }

      if (event.code === "Digit4") {
        event.preventDefault();
        applyHeadingShortcut(4);
        return;
      }

      if (event.code === "Digit5") {
        event.preventDefault();
        applyHeadingShortcut(5);
        return;
      }

      if (event.code === "Digit6") {
        event.preventDefault();
        applyHeadingShortcut(6);
        return;
      }
    }

    if (isModifierShortcut && !event.altKey) {
      if (event.key.toLowerCase() === "b" && !event.shiftKey) {
        event.preventDefault();
        applyInlineShortcut("**");
        return;
      }

      if (event.key.toLowerCase() === "i" && !event.shiftKey) {
        event.preventDefault();
        applyInlineShortcut("*");
        return;
      }

      if (event.key.toLowerCase() === "x" && event.shiftKey) {
        event.preventDefault();
        applyInlineShortcut("~~");
        return;
      }

      if (event.key.toLowerCase() === "e" && !event.shiftKey) {
        event.preventDefault();
        applyInlineShortcut("`");
        return;
      }

      if (event.key.toLowerCase() === "k" && !event.shiftKey) {
        event.preventDefault();
        applyLinkShortcut();
        return;
      }

      if (event.shiftKey && event.code === "Digit7") {
        event.preventDefault();
        applyLineShortcut("ordered");
        return;
      }

      if (event.shiftKey && event.code === "Digit8") {
        event.preventDefault();
        applyLineShortcut("bullet");
        return;
      }

      if (event.shiftKey && event.code === "Period") {
        event.preventDefault();
        applyLineShortcut("quote");
        return;
      }
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const selectionStart = textareaRef?.selectionStart ?? 0;
      const selectionEnd = textareaRef?.selectionEnd ?? 0;
      const currentLineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
      const listEnterResult = handleMarkdownListEnter(
        value,
        selectionStart,
        selectionEnd,
        pendingListExitLineStart === currentLineStart,
      );

      if (listEnterResult) {
        event.preventDefault();
        pendingListExitLineStart =
          listEnterResult.pendingEmptyListItemLineStart;
        value = listEnterResult.nextValue;
        notifyChange();

        setTimeout(() => {
          textareaRef?.focus();
          textareaRef?.setSelectionRange(
            listEnterResult.nextSelectionStart,
            listEnterResult.nextSelectionEnd,
          );
          resizeTextarea();
          handleSelectionChange();
        }, 0);
        return;
      }
    }

    if (event.key === "Tab") {
      event.preventDefault();
      insertAtCursor("  ");
    }
  }

  function handleSelectionChange() {
    if (selectionTimeout) {
      clearTimeout(selectionTimeout);
    }

    selectionTimeout = setTimeout(() => {
      if (!textareaRef) {
        showFloatingToolbar = false;
        showSlashMenu = false;
        return;
      }

      const start = textareaRef.selectionStart;
      const end = textareaRef.selectionEnd;

      // Close the slash menu when the caret leaves the "/..." context (e.g.
      // the user clicked elsewhere) so its key handling stops hijacking input.
      if (showSlashMenu) {
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;

        if (!value.slice(lineStart, start).startsWith("/")) {
          showSlashMenu = false;
        }
      }

      // Same for the mention menu and its "@..." context.
      if (
        showMentionMenu &&
        !getMentionContext(value, textareaRef.selectionStart)
      ) {
        closeMentionMenu();
      }

      if (start !== end && value.substring(start, end).trim().length > 0) {
        const startCoords = getCaretCoordinates(textareaRef, start);
        const halfToolbarWidth = 170;
        floatingToolbarPosition = {
          top: Math.max(VIEWPORT_MARGIN, startCoords.top - 54),
          left: Math.max(
            halfToolbarWidth,
            Math.min(
              startCoords.left + 10,
              window.innerWidth - halfToolbarWidth,
            ),
          ),
        };
        showFloatingToolbar = true;
        return;
      }

      showFloatingToolbar = false;
    }, 50);
  }

  function spliceTextareaText(
    start: number,
    end: number,
    text: string,
    selectionMode: SelectionMode = "preserve",
  ) {
    if (!textareaRef) {
      return;
    }

    // Unlike a plain `value = ...` assignment, setRangeText keeps the
    // textarea's native undo stack intact for the insert.
    textareaRef.setRangeText(text, start, end, selectionMode);
    // Re-enter the normal input path so bind:value, resize, the slash menu
    // and notifyChange all stay in sync.
    textareaRef.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function insertImageMarkdownAtCursor(markdown: string) {
    pendingListExitLineStart = null;

    if (!textareaRef) {
      const needsLeadingBreak = value.length > 0 && !value.endsWith("\n");
      value = `${value}${needsLeadingBreak ? "\n" : ""}${markdown}\n`;
      notifyChange();
      return;
    }

    const start = textareaRef.selectionStart;
    const end = textareaRef.selectionEnd;
    const before = textareaRef.value.slice(0, start);
    const after = textareaRef.value.slice(end);
    const needsLeadingBreak = before.length > 0 && !before.endsWith("\n");
    const needsTrailingBreak = after.length > 0 && !after.startsWith("\n");
    const insertion = `${needsLeadingBreak ? "\n" : ""}${markdown}${
      needsTrailingBreak ? "\n" : ""
    }`;

    textareaRef.focus();
    spliceTextareaText(start, end, insertion, "end");
  }

  function resolveUploadToken(token: string, replacement: string) {
    // Search the live text by token, never stored offsets — the user may
    // have typed or deleted around the placeholder while uploading.
    if (textareaRef) {
      const found = findUploadPlaceholder(textareaRef.value, token);

      // The user deleted the placeholder — treat it as a cancel.
      if (!found) {
        return;
      }

      spliceTextareaText(found.start, found.end, replacement);
      return;
    }

    // The textarea is unmounted (preview-only mode); update the bound prop.
    const found = findUploadPlaceholder(value, token);

    if (!found) {
      return;
    }

    value = value.slice(0, found.start) + replacement + value.slice(found.end);
    notifyChange();
  }

  function checkUploadSize(file: File) {
    const tuzis = Number(get(authStore).creator?.tuzis ?? 0) || 0;
    const limit = maxUploadBytesFor(tuzis);

    if (file.size <= limit) {
      return null;
    }

    return `${file.name || "Image"} ${$t(
      "editor.imageTooLarge",
      "exceeds your upload limit of",
    )} ${formatByteLimit(limit)}.`;
  }

  async function startInlineUploads(files: File[], offset: number) {
    const jobs = files.map((file) => ({ file, token: createUploadToken() }));
    const label = $t("editor.uploadingImage", "Uploading image…");
    const placeholderBlock = jobs
      .map((job) => buildUploadPlaceholder(job.token, label))
      .join("\n");

    pendingListExitLineStart = null;
    spliceTextareaText(offset, offset, placeholderBlock);

    await Promise.all(
      jobs.map(async ({ file, token }) => {
        const sizeError = checkUploadSize(file);

        if (sizeError) {
          resolveUploadToken(token, "");
          toast.error(sizeError);
          return;
        }

        try {
          const uploaded = await uploadPublicFile(file, file.name || "image");
          // Keep the URL relative — the markdown renderer prefixes /uploadz/
          // paths with the API base in both preview and published pages.
          resolveUploadToken(
            token,
            buildImageMarkdown(file.name, uploaded.url),
          );
        } catch (error: any) {
          resolveUploadToken(token, "");
          // nginx closes the connection on bodies over the upload limit,
          // which surfaces as a fetch TypeError instead of an HTTP error.
          const message =
            error instanceof TypeError
              ? $t(
                  "editor.imageUploadRejected",
                  "Upload failed — the file may exceed your upload limit.",
                )
              : error?.message ||
                $t("editor.imageUploadFailed", "Image upload failed.");
          toast.error(message);
        }
      }),
    );
  }

  function insertLocalImages(files: File[]) {
    if (!files.length) {
      return;
    }

    textareaRef?.focus();
    void startInlineUploads(files, textareaRef?.selectionStart ?? value.length);
  }

  async function insertCloudImage(item: CoverLibraryImage) {
    const title = item.title || item.name || `image-${item.id}`;
    const sourcePath = item.url || item.thumbnail;

    if (!sourcePath) {
      throw new Error(
        $t("editor.cloudImageOpenFailed", "Unable to open that image."),
      );
    }

    if (item.access === "public" && item.url) {
      insertImageMarkdownAtCursor(buildImageMarkdown(title, item.url));
      return;
    }

    const sourceUrl = resolveMediaUrl(sourcePath);
    const response = await fetch(sourceUrl, { credentials: "include" });

    if (!response.ok) {
      throw new Error(
        $t("editor.cloudImageOpenFailed", "Unable to open that image."),
      );
    }

    const blob = await response.blob();
    const extension = item.mime_type?.split("/")[1] || "jpg";
    const safeName = title.replace(/[^\w.-]+/g, "-").toLowerCase();
    const file = new File(
      [blob],
      `${safeName || `image-${item.id}`}.${extension}`,
      {
        type: blob.type || item.mime_type || "image/jpeg",
      },
    );

    textareaRef?.focus();

    await startInlineUploads(
      [file],
      textareaRef?.selectionStart ?? value.length,
    );
  }

  function handlePaste(event: ClipboardEvent) {
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
    void startInlineUploads(
      images,
      textareaRef?.selectionStart ?? value.length,
    );
  }

  function handleDragOver(event: DragEvent) {
    if (!event.dataTransfer?.types.includes("Files")) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    dragActive = true;
  }

  function handleDragLeave() {
    dragActive = false;
  }

  function handleDrop(event: DragEvent) {
    dragActive = false;
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
        $t("editor.onlyImagesDrop", "Only image files can be dropped here."),
      );
      return;
    }

    if (!textareaRef) {
      return;
    }

    textareaRef.focus();
    void startInlineUploads(images, getDropTextOffset(textareaRef, event));
  }

  export function focusEditor() {
    textareaRef?.focus();
  }

  onMount(() => {
    isMac = detectMacPlatform();
    window.addEventListener("resize", scheduleMenuReposition);
    window.addEventListener("scroll", scheduleMenuReposition, true);

    return () => {
      window.removeEventListener("resize", scheduleMenuReposition);
      window.removeEventListener("scroll", scheduleMenuReposition, true);

      if (menuRepositionFrame !== null) {
        cancelAnimationFrame(menuRepositionFrame);
      }
    };
  });

  $effect(() => {
    value;
    queueMicrotask(resizeTextarea);
  });
</script>

<EditorFloatingToolbar
  {wrapSelection}
  {insertAtCursor}
  onApplyBold={() => applyInlineShortcut("**")}
  onApplyItalic={() => applyInlineShortcut("*")}
  onApplyLink={applyLinkShortcut}
  onApplyCode={() => applyInlineShortcut("`")}
  onApplyBulletList={() => applyLineShortcut("bullet")}
  onApplyOrderedList={() => applyLineShortcut("ordered")}
  onApplyQuote={() => applyLineShortcut("quote")}
  {isMac}
  position={floatingToolbarPosition}
  show={showFloatingToolbar}
/>

<EditorImagePicker
  bind:this={imagePickerRef}
  onChooseCloudImage={insertCloudImage}
  onUploadLocalImages={insertLocalImages}
/>

<textarea
  bind:this={textareaRef}
  bind:value
  class={`writing-area-textarea min-h-[400px] w-full resize-none overflow-hidden rounded-md border-none bg-transparent font-sans text-[1.125rem] leading-relaxed text-foreground transition-shadow outline-none placeholder:text-muted-foreground placeholder:opacity-40 ${
    dragActive ? "bg-primary/5 ring-2 ring-primary/40" : ""
  }`}
  placeholder={$t(
    "editor.contentPlaceholder",
    "Start writing your story... (Type / for commands, @ to mention)",
  )}
  spellcheck="true"
  oninput={handleInput}
  onkeydown={handleKeyDown}
  onpaste={handlePaste}
  ondragover={handleDragOver}
  ondragenter={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  onselect={handleSelectionChange}
  onmouseup={handleSelectionChange}
  onkeyup={handleSelectionChange}
  onblur={() =>
    setTimeout(() => {
      showFloatingToolbar = false;
      showSlashMenu = false;
      closeMentionMenu();
    }, 200)}
></textarea>

{#if showSlashMenu}
  <EditorSlashMenu
    bind:slashMenuRef
    bind:selectedSlashCommand
    bind:selectedCommandRefs
    {slashMenuPosition}
    {filteredCommands}
    {isMac}
    {insertSlashCommand}
  />
{/if}

{#if showMentionMenu}
  <EditorMentionMenu
    bind:mentionMenuRef
    bind:selectedMention
    bind:selectedMentionRefs
    {mentionMenuPosition}
    {mentionResults}
    {insertMention}
    isLoading={mentionLoading}
  />
{/if}
