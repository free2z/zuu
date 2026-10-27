<script lang="ts">
  import { getCurrentLocale, tStore as t } from "$lib/i18n";
  import { Button } from "$lib/components/ui/button";
  import { onMount } from "svelte";
  import { Plus } from "@lucide/svelte";
  import EditorFloatingToolbar from "./EditorFloatingToolbar.svelte";
  import EditorImagePicker from "./EditorImagePicker.svelte";
  import EditorMentionMenu from "./EditorMentionMenu.svelte";
  import EditorSlashMenu from "./EditorSlashMenu.svelte";
  import { detectMacPlatform } from "./shortcuts";
  import { MarkdownTextareaController } from "./markdownTextarea.svelte";
  import { createSlashCommands } from "./slashCommands";
  import { getCaretCoordinates } from "./utils";
  import { autoGrowTextarea } from "./autoGrow";

  /*
   * The zPage body. Everything that is about editing markdown in a textarea —
   * the "/" menu and "+" palette, mentions, the floating toolbar and its
   * shortcuts, list continuation, and the paste / drop / picker upload
   * pipeline — is `MarkdownTextareaController`, shared with the Converse
   * composer. What stays here is what makes this the LONG-FORM
   * writing surface: the full command set, the gutter "+" parked on the
   * caret's line, and a body that grows to at least 400px.
   */

  interface Props {
    value: string;
    onChange?: () => void;
    /**
     * `zPage.is_subscriber_only`, forwarded to the image picker so it knows
     * how reachable a body image has to be. See `mediaAccess.ts`.
     */
    subscriberOnly?: boolean;
    /**
     * The direction the BODY is written in — the article's language, never the
     * creator's UI locale. `"auto"` while the language is unknown.
     *
     * The `<textarea>` gets this verbatim, so the caret, selection, the
     * insertion point and soft-wrap all run the way the writer is writing. The
     * toolbar, slash menu and "/" palette do not: they are product UI and stay
     * in the chrome's direction.
     */
    direction?: "ltr" | "rtl" | "auto";
    /** The body's content language, or undefined for an unlabelled draft. */
    language?: string;
    /**
     * "The editor page itself is going away", from `/edit`'s own `onDestroy`.
     *
     * Deliberately NOT derived from this component's lifecycle. `/edit` mounts
     * the composer under `{#if mode === "write" || mode === "split"}`, so
     * switching to Preview destroys this component while the creator is still
     * on the page — and an inline upload in flight at that moment must still
     * land. The upload pipeline resolves into the bound value when the
     * textarea is unmounted (preview-only mode), which is the proof that
     * surviving a Preview switch is the intended behaviour and not an
     * accident.
     *
     * A thunk, not a boolean: it is read at the moment an awaited answer
     * arrives, long after this component last re-rendered.
     */
    isAbandoned?: () => boolean;
  }

  let {
    value = $bindable(),
    onChange,
    subscriberOnly = false,
    direction = "auto",
    language,
    isAbandoned,
  }: Props = $props();

  /**
   * What the textarea's `dir="auto"` actually resolved to, or null before the
   * first read. Only meaningful while `direction` is `"auto"`.
   */
  let detectedDirection = $state<"ltr" | "rtl" | null>(null);

  /**
   * The concrete side the gutter control parks on.
   *
   * A known language answers it outright, so the very first paint is already
   * right — no read can happen before the element exists. Only `"auto"` has to
   * be asked, and it is asked of the ELEMENT rather than of a second,
   * hand-rolled bidi guess that could disagree with what the writer sees.
   * `"ltr"` until the first read, matching the browser's own fallback for text
   * with no strong character in it yet.
   */
  const resolvedDirection = $derived(
    direction === "auto" ? (detectedDirection ?? "ltr") : direction,
  );

  /**
   * Read the element's resolved direction. `:dir()` is the only thing that
   * answers this for `dir="auto"` — `getComputedStyle().direction` reports the
   * INHERITED value there, because `auto` is specified as `unicode-bidi:
   * plaintext` and never touches the `direction` property. Guarded: an engine
   * without `:dir()` throws on `matches`, and the seeded value stands.
   */
  function readResolvedDirection(element: HTMLElement): "ltr" | "rtl" | null {
    try {
      return element.matches(":dir(rtl)") ? "rtl" : "ltr";
    } catch {
      return null;
    }
  }

  /** True only when the whole editor page is gone, never on a Preview switch. */
  const editorAbandoned = () => isAbandoned?.() === true;

  let textareaRef = $state<HTMLTextAreaElement | null>(null);
  let imagePickerRef = $state<{
    openPicker: (defaultTab?: "device" | "cloud") => void;
  } | null>(null);
  let isMac = $state(false);

  const slashCommands = $derived.by(() => createSlashCommands($t));

  const editor = new MarkdownTextareaController({
    getValue: () => value,
    setValue: (next) => {
      value = next;
    },
    getTextarea: () => textareaRef,
    onChange: () => onChange?.(),
    commands: () => slashCommands,
    t: () => $t,
    locale: getCurrentLocale,
    mediaSlot: () => ({ slot: "body", subscriberOnly }),
    isAbandoned: editorAbandoned,
    openImagePicker: () => imagePickerRef?.openPicker("device"),
    resize: resizeTextarea,
    onSelectionSettled: scheduleInsertControlUpdate,
  });

  // Gutter insert control. It hangs in the margin at the START of the writing
  // column -- left in English, right in Arabic  -- vertically parked on
  // the line the caret is on, so the affordance reads as part of the writing
  // flow instead of a standalone button on its own row. `top`/`height`
  // are in px relative to the textarea's border box; the inline axis is left to
  // logical CSS off `resolvedDirection`, so there is no second copy of it here.
  let insertControlTop = $state(0);
  let insertControlLineHeight = $state(0);
  // True when the caret's line has no content yet — the moment where inserting
  // a block is the likely next action, so the glyph is legible then and fades
  // back while there is text on the line.
  let insertControlReady = $state(true);
  let insertControlTimeout: ReturnType<typeof setTimeout> | null = null;
  // Inputs of the last measurement, so repeat schedules (the value effect and
  // the selection handler both fire on a keystroke) do no work.
  let insertControlMeasuredValue: string | null = null;
  let insertControlMeasuredCaret = -1;
  let insertControlMeasuredWidth = -1;
  let insertControlObserver: ResizeObserver | null = null;

  // Fallback used before the first measurement (and if the browser reports a
  // non-numeric line-height): 1.125rem text at `leading-relaxed` (1.625).
  const FALLBACK_LINE_HEIGHT = 29;
  // `getCaretCoordinates` lays out a hidden copy of everything before the
  // caret, so it is O(document length) — and a zPage body may be 100,000
  // characters. A trailing debounce keeps that off the typing path entirely:
  // the mark settles once the burst stops rather than once per input frame.
  const INSERT_CONTROL_DELAY = 100;

  function updateInsertControl() {
    const textarea = textareaRef;

    if (!textarea) {
      return;
    }

    const caret = textarea.selectionStart ?? 0;
    const width = textarea.clientWidth;

    // Before the early return below, and deliberately: with `dir="auto"` the
    // resolved direction is a function of the TEXT, and a paste that replaces
    // Arabic with English can leave the caret and the width exactly where they
    // were. Gating this on the same cache key would leave the "+" in the wrong
    // margin until something else happened to move.
    if (direction === "auto") {
      const resolved = readResolvedDirection(textarea);
      if (resolved) detectedDirection = resolved;
    }

    if (
      insertControlMeasuredValue === value &&
      insertControlMeasuredCaret === caret &&
      insertControlMeasuredWidth === width
    ) {
      return;
    }

    insertControlMeasuredValue = value;
    insertControlMeasuredCaret = caret;
    insertControlMeasuredWidth = width;

    const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
    const lineBreak = value.indexOf("\n", caret);
    const lineEnd = lineBreak === -1 ? value.length : lineBreak;
    insertControlReady = value.slice(lineStart, lineEnd).trim().length === 0;

    // Measuring the caret is the only way to survive soft wrapping — a line
    // index times the line height is wrong the moment a paragraph wraps, which
    // is most of them.
    const coords = getCaretCoordinates(textarea, caret);
    const lineHeight =
      Number.isFinite(coords.lineHeight) && coords.lineHeight > 0
        ? coords.lineHeight
        : FALLBACK_LINE_HEIGHT;
    const offset = coords.top - textarea.getBoundingClientRect().top;

    insertControlLineHeight = lineHeight;
    insertControlTop = Math.max(0, offset);
  }

  function scheduleInsertControlUpdate() {
    if (typeof window === "undefined") {
      return;
    }

    if (insertControlTimeout !== null) {
      clearTimeout(insertControlTimeout);
    }

    insertControlTimeout = setTimeout(() => {
      insertControlTimeout = null;
      updateInsertControl();
    }, INSERT_CONTROL_DELAY);
  }

  // The body is the document's height on `/edit` — there is no inner scroll
  // container — so a naive `height: auto` collapse here clamps the PAGE scroll
  // and the browser then re-reveals the caret flush against the bottom edge of
  // the window, on every keystroke. `autoGrowTextarea` is that dance
  // done without ever losing a scroll offset; the 400px floor is unchanged.
  function resizeTextarea() {
    autoGrowTextarea(textareaRef, { minHeight: 400 });
  }

  export function focusEditor() {
    textareaRef?.focus();
  }

  onMount(() => {
    isMac = detectMacPlatform();
    const detach = editor.attach();

    // A window resize is not the only thing that rewraps the body: switching
    // the editor to Split takes the textarea from full width to `lg:w-1/2`
    // without one, which moves every wrapped caret line. Watch the element,
    // and only react to WIDTH — the textarea auto-grows in height on every
    // keystroke, and re-measuring on that would put the O(n) caret
    // measurement straight back on the typing path.
    if (textareaRef && typeof ResizeObserver !== "undefined") {
      let observedWidth = -1;

      insertControlObserver = new ResizeObserver(([entry]) => {
        const nextWidth = entry?.contentRect.width ?? 0;

        if (nextWidth !== observedWidth) {
          observedWidth = nextWidth;
          scheduleInsertControlUpdate();
        }
      });

      insertControlObserver.observe(textareaRef);
    }

    scheduleInsertControlUpdate();

    return () => {
      // NOTHING about in-flight uploads belongs here. This cleanup also runs
      // on a Write -> Preview switch (`/edit` mounts the composer under
      // `{#if mode === "write" || mode === "split"}`), which is not the
      // creator leaving — `isAbandoned` is the signal for that.
      detach();
      insertControlObserver?.disconnect();
      insertControlObserver = null;

      if (insertControlTimeout !== null) {
        clearTimeout(insertControlTimeout);
      }
    };
  });

  $effect(() => {
    value;
    queueMicrotask(() => {
      resizeTextarea();
      // Programmatic writes (slash commands, uploads, drops) never go through
      // the selection handlers, so the gutter control is re-parked here too.
      scheduleInsertControlUpdate();
    });
  });
</script>

<EditorFloatingToolbar
  wrapSelection={editor.wrapSelection}
  insertAtCursor={editor.insertAtCursor}
  onApplyBold={() => editor.applyInlineShortcut("**")}
  onApplyItalic={() => editor.applyInlineShortcut("*")}
  onApplyLink={editor.applyLinkShortcut}
  onApplyCode={() => editor.applyInlineShortcut("`")}
  onApplyBulletList={() => editor.applyLineShortcut("bullet")}
  onApplyOrderedList={() => editor.applyLineShortcut("ordered")}
  onApplyQuote={() => editor.applyLineShortcut("quote")}
  {isMac}
  position={editor.floatingToolbarPosition}
  show={editor.showFloatingToolbar}
/>

<EditorImagePicker
  bind:this={imagePickerRef}
  onChooseCloudImage={editor.insertCloudImage}
  onUploadLocalImages={editor.insertLocalImages}
  {subscriberOnly}
/>

<!--
  `dir` on the wrapper, set to the direction the textarea RESOLVED to, is what
  puts the gutter control in the right margin in both senses of the phrase
  . Everything below is then expressed logically — `start-0`,
  `justify-end`, `me-1.5` — so one attribute flips the whole geometry and there
  is no second copy of the layout to keep in step.

  It is NOT `dir={direction}`: that value may be `"auto"`, and `auto` on an empty
  wrapper resolves from the wrapper's own (absent) text rather than the body's.
-->
<div class="relative" dir={resolvedDirection}>
  <!--
    The insert control hangs in the margin at the START of the writing column
    and is parked on the caret's line, so it costs the body no vertical space
    and reads as a margin mark rather than a primary action.

    `start` and not `left`: in an Arabic article the line begins on the RIGHT,
    and a "+" nailed to the left margin sits at the END of every line — past the
    text it is offering to insert before.

    `w-0` + `justify-end` places the button entirely outside the text column's
    content edge at every width, in whichever direction that is: flexbox's main
    axis follows `dir`, so the same declaration overflows leftwards in LTR and
    rightwards in RTL. It never overlaps a character, so it can never steal a
    tap meant for the start of a line. The margin it lives in is 24px at mobile
    (`px-6` on `.writing-area`) and 48px from `md` up, which is what sets the two
    button sizes below. The mobile button is 24px wide — the WCAG 2.2
    target-size minimum — so a `::before` stretches the touch area to 24x40
    without pushing it back over the text.
  -->
  <div
    class="pointer-events-none absolute start-0 z-10 flex w-0 items-center justify-end motion-safe:transition-[top] motion-safe:duration-150 motion-safe:ease-out"
    style="top: {insertControlTop}px; height: {insertControlLineHeight ||
      FALLBACK_LINE_HEIGHT}px;"
  >
    <!--
      The MARGIN this parks in follows the article; the CONTROL itself is product
      UI and does not. Both halves are needed and they are different
      questions: the wrapper above is right-to-left so the button lands before
      the start of the line rather than after its end, while `dir="ltr"` here
      keeps the button's own box — and anything textual it ever grows — in the
      creator's UI direction, the same rule the toolbar and slash menu follow.
    -->
    <Button
      variant="ghost"
      size="icon-sm"
      type="button"
      dir="ltr"
      data-testid="editor-insert-trigger"
      data-ready={insertControlReady ? "true" : "false"}
      title={$t("editor.insertMenu", "Insert content")}
      aria-label={$t("editor.insertMenu", "Insert content")}
      aria-haspopup="listbox"
      aria-expanded={editor.showCommandPalette}
      aria-controls="editor-command-menu"
      class={`group pointer-events-auto relative size-6 rounded-full before:absolute before:inset-x-0 before:-inset-y-2 before:content-[''] md:me-1.5 md:size-9 md:before:hidden ${
        insertControlReady
          ? "text-muted-foreground/80 hover:text-muted-foreground/80"
          : "text-muted-foreground/40 hover:text-muted-foreground/40"
      } aria-expanded:bg-accent`}
      onpointerdown={(event) => {
        if (event.pointerType === "mouse") {
          event.preventDefault();
        }
      }}
      onclick={editor.toggleCommandPalette}
    >
      <Plus
        class="size-3.5 transition-transform duration-150 group-aria-expanded:rotate-45 md:size-4"
      />
    </Button>
  </div>

  <textarea
    bind:this={textareaRef}
    bind:value
    dir={direction}
    lang={language}
    aria-controls="editor-command-menu"
    aria-owns={editor.showSlashMenu ? "editor-command-menu" : undefined}
    aria-haspopup="listbox"
    aria-expanded={editor.showSlashMenu}
    aria-activedescendant={editor.showSlashMenu &&
    editor.filteredCommands[editor.selectedSlashCommand]
      ? `editor-command-option-${editor.selectedSlashCommand}`
      : undefined}
    class={`writing-area-textarea min-h-[400px] w-full resize-none overflow-hidden rounded-md border-none bg-transparent font-sans text-[1.125rem] leading-relaxed text-foreground transition-shadow outline-none placeholder:text-muted-foreground placeholder:opacity-40 ${
      editor.dragActive ? "bg-primary/5 ring-2 ring-primary/40" : ""
    }`}
    placeholder={$t(
      "editor.contentPlaceholderWithMentions",
      "Start writing your story... (Type / for commands, @ to mention)",
    )}
    spellcheck="true"
    oninput={editor.handleInput}
    onkeydown={editor.handleKeyDown}
    onpaste={editor.handlePaste}
    ondragover={editor.handleDragOver}
    ondragenter={editor.handleDragOver}
    ondragleave={editor.handleDragLeave}
    ondrop={editor.handleDrop}
    onselect={editor.handleSelectionChange}
    onmouseup={editor.handleSelectionChange}
    onkeyup={editor.handleSelectionChange}
    onblur={editor.handleBlur}></textarea>
</div>

{#if editor.showSlashMenu}
  <EditorSlashMenu
    bind:slashMenuRef={editor.slashMenuRef}
    bind:selectedSlashCommand={editor.selectedSlashCommand}
    bind:selectedCommandRefs={editor.selectedCommandRefs}
    slashMenuPosition={editor.slashMenuPosition}
    filteredCommands={editor.filteredCommands}
    {isMac}
    menuTitle={editor.showCommandPalette
      ? $t("editor.insertMenu", "Insert content")
      : undefined}
    insertSlashCommand={editor.insertSlashCommand}
  />
{/if}

{#if editor.showMentionMenu}
  <EditorMentionMenu
    bind:mentionMenuRef={editor.mentionMenuRef}
    bind:selectedMention={editor.selectedMention}
    bind:selectedMentionRefs={editor.selectedMentionRefs}
    mentionMenuPosition={editor.mentionMenuPosition}
    mentionResults={editor.mentionResults}
    insertMention={editor.insertMention}
    isLoading={editor.mentionLoading}
  />
{/if}
