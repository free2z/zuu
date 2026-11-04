<script lang="ts">
  /**
   * Series membership for the page open in `/edit`.
   *
   * Presentation is deliberately compact: one inline `Series: …` trigger in
   * the editor's metadata row (next to `Language: English · change`). The
   * picker, the page's position and the actions live in a Popover; creating,
   * renaming and reordering a series happen in a Dialog. Nothing here takes a
   * full-width row above the title — that band cost ~300px of chrome before
   * the author saw what they were writing.
   */
  import { tStore as t } from "$lib/i18n";
  import { apiFetch } from "$lib/api/config";
  import {
    BookOpen,
    ChevronDown,
    ChevronUp,
    CircleAlert,
    LoaderCircle,
    Plus,
    X,
  } from "@lucide/svelte";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { onDestroy } from "svelte";
  import type { ZPage } from "$lib/types/zpage";

  type PageRef = {
    free2zaddr: string;
    title?: string;
  };

  type PageOrder = {
    page: PageRef;
    order: number;
  };

  type Series = {
    id: string;
    name: string;
    pageorder_set: PageOrder[];
    created_at?: string;
  };

  type SeriesListPayload =
    | Series[]
    | {
        next?: string | null;
        results?: Series[];
      };

  const SERIES_PAGE_SIZE = 12;

  let { page }: { page: Pick<ZPage, "free2zaddr" | "title"> } = $props();

  let series = $state<Series[]>([]);
  let selectedSeriesId = $state("");
  let editingSeriesId = $state<string | null>(null);
  let editorOpen = $state(false);
  let draftName = $state("");
  let draftPages = $state<PageOrder[]>([]);
  let editingSnapshot: Series | null = null;
  let isLoading = $state(true);
  let isSaving = $state(false);
  let errorMessage = $state<string | null>(null);
  let loadedPageAddress = $state("");
  let requestNumber = 0;
  let mutationNumber = 0;
  let destroyed = false;
  let popoverOpen = $state(false);
  let triggerRef = $state<HTMLButtonElement | null>(null);
  // Set while the popover closes *because* the dialog is opening, so the
  // popover does not pull focus back to the trigger underneath the dialog.
  let handingOffToDialog = false;
  // True while the popover is open because a failure surfaced it, not
  // because the author asked (see surfaceError).
  let popoverOpensQuietly = $state(false);
  // The last attempt to list the author's series failed.
  let loadFailed = $state(false);

  const selectedSeries = $derived(
    series.find((item) => item.id === selectedSeriesId) ?? null,
  );
  const isUnsaved = $derived(!page.free2zaddr);
  const isBusy = $derived(!isUnsaved && (isLoading || isSaving));
  const selectedPosition = $derived.by(() => {
    if (!selectedSeries) return null;
    const index = selectedSeries.pageorder_set.findIndex(
      (entry) => entry.page.free2zaddr === page.free2zaddr,
    );
    if (index < 0) return null;
    return { position: index + 1, total: selectedSeries.pageorder_set.length };
  });

  function openEditorDialog() {
    if (popoverOpen) {
      handingOffToDialog = true;
      popoverOpen = false;
    }
    editorOpen = true;
  }

  // When the list could not be loaded we do not know the page's series, so
  // the trigger must not claim "None". This text is also the trigger's
  // accessible name, so the failure is announced, not just drawn as an icon.
  const showLoadFailed = $derived(!isUnsaved && !isLoading && loadFailed);
  const triggerValue = $derived(
    isUnsaved
      ? $t("seriesEditor.triggerNone", "None")
      : isLoading
        ? "…"
        : loadFailed
          ? $t("seriesEditor.triggerLoadFailed", "couldn't load")
          : (selectedSeries?.name ?? $t("seriesEditor.triggerNone", "None")),
  );

  // A failed mutation's message is rendered in the dialog when it is open and
  // in the popover otherwise. Both can be dismissed while a request is in
  // flight, so a failure that lands with neither open reopens the popover
  // rather than leaving only the trigger's alert icon.
  //
  // That opening is not the author's: they may be typing in the article. It
  // must not take or trap focus, or the next keystrokes land on the series
  // select, whose change event immediately moves or removes the page.
  function surfaceError(address: string) {
    if (!isCurrentPage(address) || editorOpen || popoverOpen) return;
    popoverOpensQuietly = true;
    popoverOpen = true;
  }

  function focusTrigger() {
    triggerRef?.focus();
  }

  function normalizeSeriesList(payload: SeriesListPayload): Series[] {
    const rows = Array.isArray(payload) ? payload : payload.results || [];
    return rows
      .filter((item): item is Series => Boolean(item?.id))
      .map((item) => ({
        ...item,
        pageorder_set: [...(item.pageorder_set || [])].sort(
          (left, right) => left.order - right.order,
        ),
      }));
  }

  function isCurrentPage(address: string): boolean {
    return !destroyed && page.free2zaddr === address;
  }

  function isCurrentMutation(address: string, operation: number): boolean {
    return isCurrentPage(address) && mutationNumber === operation;
  }

  function oldestFirst(left: Series, right: Series): number {
    const created = (left.created_at || "").localeCompare(
      right.created_at || "",
    );
    return created || left.id.localeCompare(right.id);
  }

  function seriesForPage(rows: Series[], address: string): Series | null {
    return (
      [...rows]
        .filter((item) =>
          item.pageorder_set.some((entry) => entry.page.free2zaddr === address),
        )
        .sort(oldestFirst)[0] ?? null
    );
  }

  function pageOrderForSeries(item: Series): PageOrder[] {
    return item.pageorder_set.map((entry) => ({
      page: { ...entry.page },
      order: entry.order,
    }));
  }

  function withCurrentPage(rows: PageOrder[]): PageOrder[] {
    const next = rows.map((entry) =>
      entry.page.free2zaddr === page.free2zaddr
        ? { ...entry, page: { ...entry.page, title: page.title } }
        : { ...entry },
    );
    if (!next.some((entry) => entry.page.free2zaddr === page.free2zaddr)) {
      next.push({
        page: { free2zaddr: page.free2zaddr, title: page.title },
        order: next.length,
      });
    }
    return next;
  }

  function payload(name: string, rows: PageOrder[]) {
    return {
      name: name.trim(),
      // The API accepts only the public page address on write. Re-number here
      // so moving a row never sends stale orders from a previous response.
      pageorder_set: rows.map((entry, index) => ({
        page: { free2zaddr: entry.page.free2zaddr },
        order: index,
      })),
    };
  }

  async function responseJson(response: Response) {
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        data && typeof data === "object" && "detail" in data
          ? String(data.detail)
          : $t("seriesEditor.requestFailed", "Request failed ({status})", {
              status: response.status,
            });
      throw Object.assign(new Error(detail), { status: response.status });
    }
    return data;
  }

  async function loadSeries() {
    const addressAtStart = page.free2zaddr;
    const currentRequest = ++requestNumber;
    isLoading = true;
    errorMessage = null;

    try {
      const rows: Series[] = [];
      let pageNumber = 1;
      while (true) {
        const response = await apiFetch(
          `/api/g12f/series/mine/?page=${pageNumber}`,
        );
        // The legacy bare-array API reports exhaustion with 404, not [].
        // Only a follow-on request after a full page can be exhaustion.
        if (currentRequest !== requestNumber || !isCurrentPage(addressAtStart))
          return;
        if (response.status === 404 && pageNumber > 1) break;
        const payload = (await responseJson(response)) as SeriesListPayload;
        const pageRows = normalizeSeriesList(payload);
        rows.push(...pageRows);

        if (
          currentRequest !== requestNumber ||
          !isCurrentPage(addressAtStart)
        ) {
          return;
        }

        const hasNext = Array.isArray(payload)
          ? pageRows.length === SERIES_PAGE_SIZE
          : Boolean(payload.next) || pageRows.length === SERIES_PAGE_SIZE;
        if (!hasNext) break;
        pageNumber += 1;
      }

      rows.sort(oldestFirst);

      series = rows;
      loadFailed = false;
      const current = seriesForPage(rows, addressAtStart);
      selectedSeriesId = current?.id || "";
      if (
        editingSeriesId &&
        !rows.some((item) => item.id === editingSeriesId)
      ) {
        editingSeriesId = null;
        editorOpen = false;
      }
      return true;
    } catch (error) {
      if (currentRequest !== requestNumber || !isCurrentPage(addressAtStart)) {
        return;
      }
      errorMessage =
        error instanceof Error
          ? error.message
          : $t("seriesEditor.loadFailed", "Unable to load your series.");
      loadFailed = true;
    } finally {
      if (currentRequest === requestNumber && isCurrentPage(addressAtStart)) {
        isLoading = false;
      }
    }
  }

  async function saveSeries(
    id: string | null,
    name: string,
    rows: PageOrder[],
    expected: Series | null = null,
  ): Promise<Series> {
    const response = await apiFetch(
      id
        ? `/api/g12f/series/mine/${encodeURIComponent(id)}/`
        : "/api/g12f/series/mine/",
      {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload(name, rows),
          ...(expected
            ? {
                expected_name: expected.name,
                expected_pageorder_set: expected.pageorder_set.map((entry) => ({
                  page: { free2zaddr: entry.page.free2zaddr },
                  order: entry.order,
                })),
              }
            : {}),
        }),
      },
    );
    return (await responseJson(response)) as Series;
  }

  async function assignSeries(
    id: string,
    confirmedSeriesId = selectedSeriesId,
  ) {
    if (isBusy) return;
    if (!id) {
      await removeFromSeries(confirmedSeriesId);
      return;
    }

    const target = series.find((item) => item.id === id);
    if (!target) return;

    const addressAtStart = page.free2zaddr;
    const operation = ++mutationNumber;
    isSaving = true;
    errorMessage = null;
    try {
      const saved = await saveSeries(
        target.id,
        target.name,
        withCurrentPage(pageOrderForSeries(target)),
        target,
      );
      if (!isCurrentMutation(addressAtStart, operation)) return;
      selectedSeriesId = saved.id || target.id;
      // Joining a series appends the page last; open the reading order so the
      // author can place it (this was the inline form before the dialog) —
      // unless they dismissed the picker while the request was pending, in
      // which case a modal would land on top of their writing uninvited, and
      // no draft is kept either. The trigger's "(n of m)" reports the result.
      if (popoverOpen) {
        editingSeriesId = saved.id || target.id;
        openEditorDialog();
        draftName = saved.name || target.name;
        draftPages = pageOrderForSeries(saved);
        editingSnapshot = saved;
      }
      await loadSeries();
    } catch (error) {
      if (!isCurrentMutation(addressAtStart, operation)) return;
      errorMessage =
        error instanceof Error
          ? error.message
          : $t(
              "seriesEditor.addFailed",
              "Unable to add this article to the series.",
            );
      selectedSeriesId = confirmedSeriesId;
      surfaceError(addressAtStart);
      await reconcileConflict(error, addressAtStart, operation);
    } finally {
      if (isCurrentMutation(addressAtStart, operation)) isSaving = false;
    }
  }

  function startCreate() {
    editingSeriesId = null;
    editingSnapshot = null;
    openEditorDialog();
    draftName = "";
    draftPages = [
      { page: { free2zaddr: page.free2zaddr, title: page.title }, order: 0 },
    ];
    errorMessage = null;
  }

  function editSelectedSeries() {
    if (!selectedSeries) return;
    editingSeriesId = selectedSeries.id;
    editingSnapshot = selectedSeries;
    openEditorDialog();
    draftName = selectedSeries.name;
    draftPages = pageOrderForSeries(selectedSeries);
    errorMessage = null;
  }

  function closeEditor() {
    editingSeriesId = null;
    editingSnapshot = null;
    editorOpen = false;
    errorMessage = null;
  }

  function movePage(index: number, delta: number) {
    const destination = index + delta;
    if (destination < 0 || destination >= draftPages.length || isSaving) return;
    const next = [...draftPages];
    [next[index], next[destination]] = [next[destination], next[index]];
    draftPages = next;
  }

  async function saveDraft() {
    const name = draftName.trim();
    if (!name) {
      errorMessage = $t(
        "seriesEditor.nameRequired",
        "Give this series a name.",
      );
      return;
    }
    if (name.length > 200) {
      errorMessage = $t(
        "seriesEditor.nameTooLong",
        "Series names must be 200 characters or fewer.",
      );
      return;
    }

    isSaving = true;
    errorMessage = null;
    const id = editingSeriesId;
    const addressAtStart = page.free2zaddr;
    const operation = ++mutationNumber;
    try {
      const saved = await saveSeries(
        id,
        name,
        withCurrentPage(draftPages),
        editingSnapshot,
      );
      if (!isCurrentMutation(addressAtStart, operation)) return;
      selectedSeriesId = saved.id || id || "";
      // The save is confirmed; the dialog has done its job. Reopening
      // "Manage series" rebuilds the draft from the reloaded series.
      closeEditor();
      await loadSeries();
    } catch (error) {
      if (!isCurrentMutation(addressAtStart, operation)) return;
      errorMessage =
        error instanceof Error
          ? error.message
          : $t("seriesEditor.saveFailed", "Unable to save this series.");
      // The author may have dismissed the dialog while the save was pending.
      surfaceError(addressAtStart);
      await reconcileConflict(error, addressAtStart, operation);
    } finally {
      if (isCurrentMutation(addressAtStart, operation)) isSaving = false;
    }
  }

  async function reconcileConflict(
    error: unknown,
    address: string,
    operation: number,
  ) {
    if (
      !(error instanceof Error) ||
      !("status" in error) ||
      error.status !== 409
    )
      return;
    // The draft is stale, so the dialog closes; the message below must still
    // be visible, so surface the popover instead.
    closeEditor();
    surfaceError(address);
    const reloaded = await loadSeries();
    if (isCurrentMutation(address, operation)) {
      errorMessage = reloaded
        ? $t(
            "seriesEditor.changedReloaded",
            "This series changed in another session. The latest series have been loaded; review them before trying again.",
          )
        : $t(
            "seriesEditor.changedReloadFailed",
            "This series changed in another session. Reload the series before trying again.",
          );
    }
  }

  async function removeFromSeries(confirmedSeriesId = selectedSeriesId) {
    if (isBusy || !page.free2zaddr) return;
    const addressAtStart = page.free2zaddr;
    const operation = ++mutationNumber;
    isSaving = true;
    errorMessage = null;
    try {
      const response = await apiFetch(
        `/api/g12f/series/clear-zpage/${encodeURIComponent(page.free2zaddr)}/`,
        { method: "DELETE" },
      );
      await responseJson(response);
      if (!isCurrentMutation(addressAtStart, operation)) return;
      selectedSeriesId = "";
      closeEditor();
      await loadSeries();
    } catch (error) {
      if (!isCurrentMutation(addressAtStart, operation)) return;
      errorMessage =
        error instanceof Error
          ? error.message
          : $t(
              "seriesEditor.removeFailed",
              "Unable to remove this article from its series.",
            );
      selectedSeriesId = confirmedSeriesId;
      surfaceError(addressAtStart);
    } finally {
      if (isCurrentMutation(addressAtStart, operation)) isSaving = false;
    }
  }

  $effect(() => {
    const address = page.free2zaddr;
    if (!address || address === loadedPageAddress) return;
    loadedPageAddress = address;
    void loadSeries();
  });

  onDestroy(() => {
    destroyed = true;
    requestNumber += 1;
    mutationNumber += 1;
  });
</script>

{#snippet errorBlock()}
  {#if errorMessage}
    <div class="flex flex-col items-start gap-2">
      <p class="text-xs text-destructive" role="alert">{errorMessage}</p>
      <button
        type="button"
        class="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        disabled={isBusy || isUnsaved}
        onclick={() => {
          closeEditor();
          void loadSeries();
        }}>{$t("seriesEditor.reload", "Reload series")}</button
      >
    </div>
  {/if}
{/snippet}

<!--
  One inline trigger in the editor's metadata row. It stays enabled for an
  unsaved draft so the popover can explain why its controls are disabled —
  a disabled trigger would hide the only explanation.

  Below `sm` it takes a line of its own (basis-full) so the metadata row has
  the same height while series load, when there are none, and when the name
  is long; the separator dot is only meaningful when it sits inline.
  The name is user-authored and capped per breakpoint so the trigger stays
  one line; the full name is in the popover's select.
-->
<div
  class="flex min-w-0 basis-full items-center gap-x-2 text-xs text-muted-foreground sm:basis-auto"
  data-testid="editor-series-trigger-row"
>
  <span class="hidden sm:inline" aria-hidden="true">·</span>
  <!--
    bits-ui calls onOpenChange only for its own state changes — the author
    pressing the trigger (click, Enter or Space; the trigger toggles on keydown
    and fires no click), Escape, or an outside click — never for our
    programmatic `popoverOpen = true` in surfaceError. So any opening the
    author asks for is a normal one: focused and trapped, reachable by
    keyboard.
  -->
  <Popover.Root
    bind:open={popoverOpen}
    onOpenChange={(open) => {
      if (open) popoverOpensQuietly = false;
    }}
  >
    <Popover.Trigger
      bind:ref={triggerRef}
      class={[
        "inline-flex min-w-0 items-center gap-1 rounded whitespace-nowrap hover:text-foreground",
        showLoadFailed && "text-destructive",
      ]}
    >
      {#if errorMessage && !editorOpen}
        <CircleAlert
          class="size-3.5 shrink-0 text-destructive"
          aria-hidden="true"
        />
      {/if}
      <span>{$t("seriesEditor.triggerLabel", "Series:")}</span>
      <span
        class="inline-block max-w-[9rem] truncate align-bottom underline decoration-dotted underline-offset-2 sm:max-w-[12rem] lg:max-w-[16rem]"
        >{triggerValue}</span
      >
      {#if selectedPosition && !isLoading && !loadFailed}
        <span class="tabular-nums"
          >{$t("seriesEditor.triggerPosition", "({position} of {total})", {
            position: selectedPosition.position,
            total: selectedPosition.total,
          })}</span
        >
      {/if}
    </Popover.Trigger>
    <Popover.Content
      align="start"
      collisionPadding={16}
      role="dialog"
      aria-labelledby="editor-series-title"
      aria-busy={isBusy}
      class="w-80 max-w-[calc(100vw-2rem)] p-3"
      trapFocus={!popoverOpensQuietly}
      onOpenAutoFocus={(event) => {
        if (popoverOpensQuietly) event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        // Leave focus where the author put it: in the dialog being opened,
        // or wherever they were working when a failure surfaced the popover.
        // popoverOpensQuietly is NOT reset here: bits-ui re-mounts the focus
        // scope when the content re-renders (unmount → this callback → open
        // autofocus), so clearing it here hands focus to the select anyway.
        // Only an opening the author asks for clears it (onOpenChange).
        if (handingOffToDialog || popoverOpensQuietly) event.preventDefault();
        handingOffToDialog = false;
      }}
    >
      <div class="flex flex-col gap-3">
        <div class="flex items-start gap-2">
          <BookOpen
            class="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div class="min-w-0">
            <h2 id="editor-series-title" class="text-sm font-medium">
              {$t("seriesEditor.title", "Series")}
            </h2>
            <p class="text-xs text-muted-foreground">
              {$t(
                "seriesEditor.description",
                "Group this article with your other pages and choose their reading order.",
              )}
            </p>
          </div>
        </div>

        {#if isUnsaved}
          <p
            class="rounded-md bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground"
            id="editor-series-save-hint"
          >
            {$t(
              "seriesEditor.saveFirst",
              "Add content and save this page to create a series or add it to an existing one.",
            )}
          </p>
        {/if}

        {#if isLoading && !isUnsaved}
          <p
            class="flex items-center gap-2 text-xs text-muted-foreground"
            role="status"
          >
            <LoaderCircle
              class="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {$t("seriesEditor.loading", "Loading your series…")}
          </p>
        {:else}
          <label
            class="flex min-w-0 flex-col gap-1 text-xs font-medium"
            for="editor-series-select"
          >
            {$t("seriesEditor.current", "Current series")}
            <select
              id="editor-series-select"
              class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
              value={selectedSeriesId}
              aria-describedby={isUnsaved
                ? "editor-series-save-hint"
                : undefined}
              onchange={(event) => {
                const nextSeriesId = event.currentTarget.value;
                const confirmed = selectedSeriesId;
                selectedSeriesId = nextSeriesId;
                void assignSeries(nextSeriesId, confirmed);
              }}
              disabled={isBusy || isUnsaved}
            >
              <option value=""
                >{$t("seriesEditor.none", "Not in a series")}</option
              >
              {#each series as item (item.id)}
                <option value={item.id}>{item.name}</option>
              {/each}
            </select>
          </label>

          {#if selectedSeries}
            {#if selectedPosition}
              <p class="text-xs text-muted-foreground tabular-nums">
                {$t(
                  "seriesEditor.position",
                  "This article is part {position} of {total}.",
                  {
                    position: selectedPosition.position,
                    total: selectedPosition.total,
                  },
                )}
              </p>
            {/if}
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="min-h-9 flex-1 rounded-md border border-border px-3 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                onclick={editSelectedSeries}
                disabled={isBusy || isUnsaved}
              >
                {$t("seriesEditor.manage", "Manage series")}
              </button>
              <button
                type="button"
                class="inline-flex min-h-9 items-center justify-center gap-1 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                onclick={() => void removeFromSeries()}
                disabled={isBusy || isUnsaved}
              >
                <X class="size-3.5" aria-hidden="true" />
                {$t("seriesEditor.remove", "Remove")}
              </button>
            </div>
          {/if}
        {/if}

        <button
          type="button"
          class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          onclick={startCreate}
          aria-describedby={isUnsaved ? "editor-series-save-hint" : undefined}
          disabled={isBusy || isUnsaved}
        >
          <Plus class="size-3.5" aria-hidden="true" />
          {$t("seriesEditor.new", "New series")}
        </button>

        {#if !editorOpen}
          {@render errorBlock()}
        {/if}
      </div>
    </Popover.Content>
  </Popover.Root>
</div>

<Dialog.Root
  bind:open={
    () => editorOpen,
    (next) => {
      // Always dismissible, even mid-request: apiFetch has no timeout, and a
      // modal that waits on the network would lock the author out of the
      // article. The request still settles; a failure reopens the popover
      // (surfaceError) and a success needs no dialog.
      if (!next) closeEditor();
    }
  }
>
  <Dialog.Content
    class="flex max-h-[90vh] flex-col gap-4 overflow-hidden sm:max-w-md"
    aria-busy={isSaving}
    onCloseAutoFocus={(event) => {
      // Opened programmatically (from the popover), so bits-ui has no trigger
      // to return focus to. Return it to the inline Series trigger.
      event.preventDefault();
      focusTrigger();
    }}
  >
    <Dialog.Header class="text-left">
      <Dialog.Title class="text-base">
        {editingSeriesId
          ? $t("seriesEditor.manage", "Manage series")
          : $t("seriesEditor.new", "New series")}
      </Dialog.Title>
      <Dialog.Description class="text-xs">
        {$t(
          "seriesEditor.description",
          "Group this article with your other pages and choose their reading order.",
        )}
      </Dialog.Description>
    </Dialog.Header>

    <form
      class="flex min-h-0 flex-col gap-3"
      onsubmit={(event) => {
        event.preventDefault();
        void saveDraft();
      }}
    >
      <label
        class="flex flex-col gap-1 text-xs font-medium"
        for="editor-series-name"
      >
        {$t("seriesEditor.name", "Series name")}
        <input
          id="editor-series-name"
          bind:value={draftName}
          maxlength="200"
          class="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          autocomplete="off"
          disabled={isSaving}
        />
      </label>

      <div class="flex min-h-0 flex-col">
        <p class="mb-1 text-xs font-medium">
          {$t("seriesEditor.order", "Reading order")}
        </p>
        <!--
          The list scrolls inside the dialog, so a long series never pushes
          the Save button off screen.
        -->
        <ol
          class="min-h-0 divide-y divide-border overflow-y-auto rounded-md border border-border"
          aria-label={$t("seriesEditor.readingOrder", "Series reading order")}
        >
          {#each draftPages as entry, index (entry.page.free2zaddr)}
            <li
              class="flex min-h-11 items-center gap-2 px-3 py-1.5"
              aria-current={entry.page.free2zaddr === page.free2zaddr
                ? "true"
                : undefined}
            >
              <span
                class="w-5 shrink-0 text-center text-xs text-muted-foreground tabular-nums"
                >{index + 1}</span
              >
              <span
                class={[
                  "min-w-0 flex-1 truncate text-sm",
                  entry.page.free2zaddr === page.free2zaddr && "font-medium",
                ]}>{entry.page.title || entry.page.free2zaddr}</span
              >
              <button
                type="button"
                class="rounded p-1.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                aria-label={$t(
                  "seriesEditor.moveEarlier",
                  "Move {title} earlier",
                  {
                    title:
                      entry.page.title || $t("seriesEditor.article", "article"),
                  },
                )}
                onclick={() => movePage(index, -1)}
                disabled={index === 0 || isSaving}
              >
                <ChevronUp class="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="rounded p-1.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                aria-label={$t("seriesEditor.moveLater", "Move {title} later", {
                  title:
                    entry.page.title || $t("seriesEditor.article", "article"),
                })}
                onclick={() => movePage(index, 1)}
                disabled={index === draftPages.length - 1 || isSaving}
              >
                <ChevronDown class="size-4" aria-hidden="true" />
              </button>
            </li>
          {/each}
        </ol>
      </div>

      {@render errorBlock()}

      <div class="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          class="min-h-9 rounded-md px-3 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          onclick={closeEditor}
        >
          {$t("seriesEditor.cancel", "Cancel")}
        </button>
        <button
          type="submit"
          class="min-h-9 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isSaving}
        >
          {isSaving
            ? $t("seriesEditor.saving", "Saving…")
            : editingSeriesId
              ? $t("seriesEditor.save", "Save series")
              : $t("seriesEditor.create", "Create series")}
        </button>
      </div>
    </form>
  </Dialog.Content>
</Dialog.Root>
