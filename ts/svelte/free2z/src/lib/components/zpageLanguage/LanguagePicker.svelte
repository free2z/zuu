<script lang="ts">
  /**
   * A searchable language picker ( Part 7, rebuilt for 50+ in ).
   *
   * At four locales a `<select>` was fine. At ~50 it is not, and the four-entry
   * assumption is why an API-created `ja` variant is invisible today.
   * The list is always driven by its `languages` prop — whatever the API says
   * this article has, plus the curated translatable set — never by a table
   * hardcoded in a component.
   *
   * It only ever emits a language tag. It never touches article content: this
   * is the control that used to be able to blank the editor, and it now cannot
   * even in principle.
   *
   * ### What  changed, and why each part is here
   *
   * - **This is a combobox, not a styled `<select>`.** `role="combobox"` on the
   *   input, `aria-activedescendant` pointing at the active row, arrow keys,
   *   Home/End, Enter, Escape, and focus returned to whatever opened it. A
   *   listbox of 50 rows that only a mouse can reach is not a picker.
   * - **Search folds case and diacritics** and matches the localized name, the
   *   autonym, the group name and the raw tag — so "francais", "français",
   *   "français" typed with a dead key, and `pt-PT` all work.
   * - **Autonyms are isolated per entry.** `<bdi dir=…>` is not decoration: an
   *   RTL autonym dropped unisolated into an LTR row drags the row's own
   *   punctuation across it.
   * - **Rows are grouped by primary subtag**, so Simplified and Traditional sit
   *   under one "Chinese" heading as two ways of writing one language, while
   *   Cantonese is its own line — which is the distinction  is about.
   *
   * The ordering, grouping and matching all live in `$lib/language-picker.js`
   * and are unit-tested there. This file is the rendering and the ARIA.
   */
  import { tStore as t } from "$lib/i18n";
  import {
    browserAcceptLanguages,
    buildLanguageSections,
    describeLanguageEntry,
    exactTagOptionId,
    flattenSections,
    nextActiveIndex,
    optionDomId,
    readRecentLanguages,
    rememberRecentLanguage,
  } from "$lib/language-picker.js";
  import { describeLanguage } from "$lib/language-catalog.js";
  import { normalizeContentLanguage } from "$lib/zpage-language.js";

  interface Props {
    open: boolean;
    languages: readonly string[];
    /**
     * What the catalog endpoint said about these tags: the server's
     * name and autonym, used wherever this engine cannot name a language
     * itself, plus its `text_direction`.
     *
     * Without the names, a language is visible here only if the browser's own
     * CLDR data knows it — which undoes the whole promise of a served catalog,
     * and on an engine with a trimmed ICU build silently empties most of the
     * list. The direction is the server's answer for the autonym's own script,
     * and it wins over the local table because the server is the side that can
     * be corrected without a frontend release.
     */
    names?: ReadonlyMap<
      string,
      {
        name?: string | null;
        autonym?: string | null;
        direction?: "ltr" | "rtl";
      }
    >;
    selected?: string | null;
    viewerLocale?: string;
    title: string;
    description?: string;
    emptyLabel?: string;
    /**
     * The viewer's Accept-Language, as a header string or an ordered list.
     * Injected by tests; in the browser it defaults to `navigator.languages`.
     */
    acceptLanguage?: string | readonly string[] | null;
    onselect: (language: string) => void;
    onclose: () => void;
  }

  let {
    open,
    languages,
    names = new Map(),
    selected = null,
    viewerLocale = "en",
    title,
    description = "",
    emptyLabel = "",
    acceptLanguage = null,
    onselect,
    onclose,
  }: Props = $props();

  let query = $state("");
  /**
   * The active row is tracked by its ID, never by its index.
   *
   * An index is a position in a list that reorders under it. Reading the
   * creator's recent languages happens in an effect, AFTER the picker mounts
   * and after the cursor has been placed on the current selection — which
   * inserts a suggestions section above everything and shifts every index down
   * by however many suggestions there turned out to be. The cursor then sits on
   * a different language than the one highlighted a frame earlier, and Enter
   * relabels the article to it. Found by the codex review on.
   */
  let activeOptionId = $state<string | null>(null);
  let recent = $state<readonly string[]>([]);
  let listbox = $state<HTMLElement | null>(null);
  let returnFocusTo: HTMLElement | null = null;

  const listboxId = "language-picker-listbox";

  const accepted = $derived(acceptLanguage ?? browserAcceptLanguages());

  const sections = $derived(
    buildLanguageSections({
      languages,
      viewerLocale,
      accepted,
      recent,
      query,
      served: names,
    }),
  );

  /**
   * Every offered tag, flat, in the order the arrow keys walk them. A tag may
   * appear twice — once as a suggestion, once in its language group — so the
   * row id carries its section.
   */
  const rows = $derived(flattenSections(sections));

  /** Every language on offer, unfiltered — what the typed-tag row checks. */
  const entries = $derived(
    languages
      .map((language) =>
        describeLanguageEntry(language, viewerLocale, names.get(language)),
      )
      .filter((entry) => entry !== null),
  );

  /**
   * A valid language typed as a tag that the seeded list does not carry.
   *
   * The list is seeded from the languages we *sell* translations into plus the
   * ones this article already has. The backend accepts far more than that, so
   * without an escape hatch an Icelandic creator simply cannot say their
   * article is Icelandic, and it stays labelled with whatever their UI locale
   * was. One typed tag is enough to fix that, and the row is only offered when
   * the tag is genuinely a nameable language.
   */
  const typedLanguage = $derived.by(() => {
    const tag = normalizeContentLanguage(query);
    if (!tag) return null;
    if (entries.some((entry) => entry.language === tag)) return null;
    const { name, autonym } = describeLanguage(
      tag,
      viewerLocale,
      names.get(tag),
    );
    return name ? { language: tag, name, autonym } : null;
  });

  const typedRowId = "lp-typed-row";

  /** The full navigable set: the grouped rows, then the typed escape hatch. */
  const options = $derived([
    ...rows.map((row) => ({
      id: row.id,
      language: row.entry.language,
    })),
    ...(typedLanguage
      ? [{ id: typedRowId, language: typedLanguage.language }]
      : []),
  ]);

  /**
   * The row the cursor is on: the one it was put on if that row is still in
   * the list, and otherwise the first — because filtering can delete the row
   * under the cursor, and an `aria-activedescendant` pointing at nothing is
   * worse than pointing at the top.
   */
  /**
   * How many LANGUAGES the list is offering, which is not how many rows it has.
   *
   * A suggestion repeats a row that also appears in its language group, so a
   * naive row count tells a screen-reader user there are two French options
   * when both select `fr` — announcing a choice that does not exist. Found by
   * the codex review on.
   */
  const resultCount = $derived(
    new Set(options.map((option) => option.language)).size,
  );

  /**
   * The row the cursor rests on when the creator has not moved it.
   *
   * Order, and each step is load-bearing:
   *
   * 1. an exactly-typed tag — `fr` must not sit on Afrikaans in a picker whose
   *    Enter key relabels an article;
   * 2. the article's OWN language;
   * 3. the first row — but **only** when there is no current language to miss,
   *    or the creator has narrowed the list themselves.
   *
   * Step 2 is resolved here, on every change, rather than once on mount: the
   * row may not exist yet. A language this browser cannot name has no row
   * until `/api/languages/` answers.
   *
   * Step 3 deliberately gives up rather than guessing. With an Abenaki article
   * and a pending — or failed — catalog, the current language has no row, and
   * resting on "the first one" put the cursor on English in the picker whose
   * Enter key writes the article's source language. No cursor means Enter does
   * nothing, which is the honest answer to "I cannot show you what you have".
   * Both were found by the codex review on.
   */
  const restingId = $derived.by(() => {
    const exact = exactTagOptionId(options, query);
    if (exact) return exact;
    const current = options.find((option) => option.language === selected);
    if (current) return current.id;
    if (selected && !query) return null;
    return options[0]?.id ?? null;
  });

  const activeId = $derived(
    options.some((option) => option.id === activeOptionId)
      ? activeOptionId
      : restingId,
  );

  const activeIndex = $derived(
    options.findIndex((option) => option.id === activeId),
  );

  // Opening: read the creator's recently-used languages so they can be floated
  // to the top.
  $effect(() => {
    if (!open) return;
    recent = readRecentLanguages();
  });

  $effect(() => {
    if (!open || !activeId || !listbox) return;
    listbox
      .querySelector(`#${CSS.escape(activeId)}`)
      ?.scrollIntoView({ block: "nearest" });
  });

  function focusOnMount(node: HTMLElement) {
    // Read BEFORE the focus call, and from here rather than from an `$effect`:
    // an effect runs after this action has already moved focus into the search
    // box, so it captures the search box itself — which is detached a moment
    // later, and Escape then drops focus to the document. A browser spec
    // caught exactly that.
    const opener = document.activeElement;
    returnFocusTo =
      opener instanceof HTMLElement && opener !== document.body ? opener : null;
    node.focus();
    // The cursor's resting place is DERIVED, not assigned here: see `activeId`.
    // Assigning it at mount is what made it wrong for a language whose row
    // arrives later.
    activeOptionId = null;
  }

  function choose(language: string) {
    query = "";
    activeOptionId = null;
    recent = rememberRecentLanguage(language);
    restoreFocus();
    onselect(language);
  }

  function close() {
    query = "";
    activeOptionId = null;
    restoreFocus();
    onclose();
  }

  function restoreFocus() {
    const target = returnFocusTo;
    returnFocusTo = null;
    // `setTimeout`, not `queueMicrotask`: Svelte flushes in a microtask, so a
    // microtask here can run before the picker has even unmounted — and, more
    // importantly, before anything the selection opened has mounted.
    setTimeout(() => {
      if (!target || !target.isConnected) return;
      // Something else has already claimed focus. Choosing a language with
      // unsaved edits opens a Save/Discard prompt whose own mount focuses
      // "Save and switch"; pulling focus back to the button BEHIND that dialog
      // leaves Enter reopening the picker instead of confirming the prompt the
      // creator is looking at. Found by the codex review on.
      const active = document.activeElement;
      if (active && active !== document.body) return;
      target.focus();
    }, 0);
  }

  function onSearchKeydown(event: KeyboardEvent) {
    // An IME is mid-composition. Enter there CONFIRMS a candidate — it is how
    // a Japanese or Chinese creator types at all — and treating it as "pick the
    // highlighted language" turns typing into a relabel of the article. Escape
    // cancels the candidate rather than the dialog, and the arrows move through
    // the candidate list. So the whole handler stands down. `keyCode === 229`
    // is the same check the markdown editor makes, for engines that do not set
    // `isComposing`. Found by the codex review on.
    if (event.isComposing || event.keyCode === 229) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        activeOptionId =
          options[
            nextActiveIndex(
              activeIndex,
              event.key === "ArrowDown" ? 1 : -1,
              options.length,
            )
          ]?.id ?? null;
        break;
      }
      case "Home": {
        if (options.length === 0) return;
        event.preventDefault();
        activeOptionId = options[0].id;
        break;
      }
      case "End": {
        if (options.length === 0) return;
        event.preventDefault();
        activeOptionId = options[options.length - 1].id;
        break;
      }
      case "Enter": {
        const option = options[activeIndex];
        if (!option) return;
        event.preventDefault();
        choose(option.language);
        break;
      }
      case "Escape": {
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
      }
      default:
        break;
    }
  }

  /**
   * What a row shows as its heading. Under a group heading that already names
   * the language, the row says only what distinguishes it ("Simplified");
   * everywhere else it says the whole name. Never the tag.
   */
  function rowLabel(
    entry: { name: string; qualifier: string | null },
    grouped: boolean,
  ) {
    return grouped && entry.qualifier ? entry.qualifier : entry.name;
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="language-picker-title"
      class="flex max-h-[70vh] w-full max-w-md flex-col rounded-lg border border-border bg-background p-4 shadow-lg"
    >
      <h2 id="language-picker-title" class="text-base font-semibold">
        {title}
      </h2>
      {#if description}
        <p class="mt-1 text-xs text-muted-foreground">{description}</p>
      {/if}

      <input
        use:focusOnMount
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeId ?? undefined}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        bind:value={query}
        onkeydown={onSearchKeydown}
        oninput={() => (activeOptionId = null)}
        placeholder={$t(
          "editor.languageSearchPlaceholder",
          "Search languages, or type a language code…",
        )}
        aria-label={$t(
          "editor.languageSearchPlaceholder",
          "Search languages, or type a language code…",
        )}
        class="mt-3 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
      />

      <!--
        The live region is how a screen-reader user learns that typing narrowed
        50 rows to 2. Without it, filtering is silent and the only feedback is
        arrowing into a list that has changed under you.
      -->
      <p class="sr-only" aria-live="polite">
        {$t("editor.languagePickerResultCount", "{count} languages").replace(
          "{count}",
          String(resultCount),
        )}
      </p>

      <div
        bind:this={listbox}
        id={listboxId}
        role="listbox"
        aria-label={title}
        class="mt-3 flex-1 overflow-y-auto"
      >
        {#each sections as section (section.id)}
          <div role="group" aria-label={section.label ?? undefined}>
            {#if section.kind === "suggested"}
              <p
                class="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
                aria-hidden="true"
              >
                {$t("editor.languagePickerSuggested", "Suggested")}
              </p>
            {:else if section.label}
              <p
                class="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
                aria-hidden="true"
              >
                {section.label}
              </p>
            {/if}

            {#each section.entries as entry (entry.language)}
              {@const id = optionDomId(section.id, entry.language)}
              {@const grouped = Boolean(section.label)}
              <!--
                The keyboard handling for this list lives on the combobox input, and
                `aria-activedescendant` is what moves through it. An option in that
                pattern must NOT be focusable and must NOT carry its own key
                handlers: a tabindex here would put one tab stop per language in the
                tab order and break the very pattern the warning points at.
              -->
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_interactive_supports_focus -->
              <div
                {id}
                role="option"
                aria-selected={entry.language === selected}
                aria-label={entry.name}
                onclick={() => choose(entry.language)}
                onmousemove={() => (activeOptionId = id)}
                class="flex w-full cursor-pointer items-baseline justify-between gap-3 rounded-md px-3 py-2 text-left text-sm {id ===
                activeId
                  ? 'bg-muted'
                  : ''} {entry.language === selected ? 'font-medium' : ''}"
              >
                <span>{rowLabel(entry, grouped)}</span>
                {#if entry.autonym && entry.autonym !== rowLabel(entry, grouped)}
                  <!--
                    `<bdi>` + an explicit `dir` is the isolation. `lang` is what
                    lets the browser pick a font that has the glyphs rather than
                    falling back to tofu.
                  -->
                  <bdi
                    dir={entry.direction}
                    lang={entry.language}
                    class="text-xs text-muted-foreground">{entry.autonym}</bdi
                  >
                {/if}
              </div>
            {/each}
          </div>
        {/each}

        {#if typedLanguage}
          <!--
            The keyboard handling for this list lives on the combobox input, and
            `aria-activedescendant` is what moves through it. An option in that
            pattern must NOT be focusable and must NOT carry its own key
            handlers: a tabindex here would put one tab stop per language in the
            tab order and break the very pattern the warning points at.
          -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_interactive_supports_focus -->
          <div
            id={typedRowId}
            role="option"
            aria-selected={typedLanguage.language === selected}
            aria-label={typedLanguage.name}
            onclick={() => choose(typedLanguage.language)}
            onmousemove={() => (activeOptionId = typedRowId)}
            class="flex w-full cursor-pointer items-baseline justify-between gap-3 rounded-md px-3 py-2 text-left text-sm {typedRowId ===
            activeId
              ? 'bg-muted'
              : ''}"
          >
            <span>{typedLanguage.name}</span>
            {#if typedLanguage.autonym && typedLanguage.autonym !== typedLanguage.name}
              <bdi
                lang={typedLanguage.language}
                class="text-xs text-muted-foreground"
                >{typedLanguage.autonym}</bdi
              >
            {/if}
          </div>
        {:else if options.length === 0}
          <p class="px-3 py-6 text-center text-sm text-muted-foreground">
            {emptyLabel ||
              $t("editor.languageSearchNoResults", "No languages match that.")}
          </p>
        {/if}
      </div>

      <div class="mt-3 flex justify-end">
        <button
          type="button"
          onclick={close}
          class="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          {$t("common.cancel", "Cancel")}
        </button>
      </div>
    </div>
  </div>
{/if}

<svelte:window
  onkeydown={(event) => {
    if (!open || event.key !== "Escape") return;
    // Same composition rule as the search box: Escape belongs to the IME.
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }}
/>
