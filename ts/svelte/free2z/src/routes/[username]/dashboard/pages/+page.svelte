<script lang="ts">
  import type { PageData } from "./$types";
  import type { ZPageListItem } from "$lib/types/zpage";
  import { onMount, tick } from "svelte";
  import { goto, invalidateAll } from "$app/navigation";
  import { formatRelativeTime, formatScheduledTime } from "$lib/utils/date";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import {
    FileText,
    Plus,
    LayoutGrid,
    List,
    Search,
    Radio,
    Eye,
    Pencil,
    CalendarClock,
    Download,
    Trash2,
    Loader2,
  } from "@lucide/svelte";
  import { locale, tStore as t } from "$lib/i18n";
  import { toast, captureAccountToast } from "$lib/toast.js";
  import * as Dialog from "$lib/components/ui/dialog";
  import {
    deleteZPage,
    fetchZPageValidator,
    ZPageDeleteError,
  } from "$lib/api/zpage";
  import ZpageCard from "$lib/components/ZpageCard.svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { zpageCanonicalPath } from "$lib/zpage-path";
  import ExportPublicationDialog from "$lib/components/dashboard/ExportPublicationDialog.svelte";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let isHydrated = $state(false);
  onMount(() => {
    isHydrated = true;
  });

  let removedIdentifiers = $state(new Set<string>());
  let zpages = $derived(
    (data.zpages || []).filter(
      (zpage: ZPageListItem) => !removedIdentifiers.has(zpage.free2zaddr),
    ),
  );
  let username = $derived(data.username);
  let count = $derived(
    Math.max(0, (data.count || 0) - removedIdentifiers.size),
  );
  let currentPage = $derived(data.page || 1);
  let searchQuery = $state(data.search || "");

  let viewMode: "card" | "list" = $state("card"); // Default to card view for modern look
  let exportDialogOpen = $state(false);
  let deleteTarget = $state<ZPageListItem | null>(null);
  let deleteDialogOpen = $state(false);
  let deleteReturnFocus = $state<HTMLElement | null>(null);
  let deleteError = $state<string | null>(null);
  let deleteConflict = $state(false);
  let isDeleting = $state(false);
  // The version the creator is confirming against: read when the
  // dialog opens, sent as `If-Match` on the DELETE, so a save from another
  // tab while the dialog is open turns into a 412 instead of a silent loss.
  // Confirming is disabled until that read has ANSWERED: a validator read
  // after the click could describe a save made after the creator consented,
  // and would then authorize deleting it (codex review). Keyed by page so a
  // dialog reopened on another row never borrows it.
  let deleteValidator = $state<{
    identifier: string;
    status: "pending" | "ready" | "failed";
    etag: string | null;
  } | null>(null);
  let deleteValidatorSeq = 0;
  let deleteReady = $derived(
    deleteTarget !== null &&
      deleteValidator?.identifier === deleteTarget.free2zaddr &&
      deleteValidator.status === "ready",
  );
  let deleteValidatorFailed = $derived(
    deleteTarget !== null &&
      deleteValidator?.identifier === deleteTarget.free2zaddr &&
      deleteValidator.status === "failed",
  );

  function readDeleteValidator(identifier: string) {
    const seq = ++deleteValidatorSeq;
    deleteValidator = { identifier, status: "pending", etag: null };
    void fetchZPageValidator(identifier).then((result) => {
      if (seq !== deleteValidatorSeq) return; // closed, or another row opened
      deleteValidator = result.ok
        ? { identifier, status: "ready", etag: result.etag }
        : { identifier, status: "failed", etag: null };
    });
  }

  function forgetDeleteValidator() {
    deleteValidatorSeq += 1;
    deleteValidator = null;
  }

  let totalPages = $derived(Math.ceil(count / 12));
  let hasNextPage = $derived(currentPage < totalPages);
  let hasPrevPage = $derived(currentPage > 1);

  function handleCreateNew() {
    goto("/edit");
  }

  function toggleView(mode: "card" | "list") {
    viewMode = mode;
  }

  async function handleSearch() {
    const url = new URL(window.location.href);
    if (searchQuery.trim()) {
      url.searchParams.set("q", searchQuery.trim());
    } else {
      url.searchParams.delete("q");
    }
    url.searchParams.delete("page"); // Reset to page 1
    try {
      await goto(url.toString(), { replace: false });
      removedIdentifiers = new Set();
    } catch {
      // Keep optimistic removals if navigation failed; restoring a deleted row
      // is more misleading than leaving the current page filtered.
    }
  }

  function clearSearch() {
    searchQuery = "";
    handleSearch();
  }

  async function goToPage(page: number) {
    const url = new URL(window.location.href);
    url.searchParams.set("page", page.toString());
    try {
      await goto(url.toString(), { replace: false });
      removedIdentifiers = new Set();
    } catch {
      // Keep optimistic removals if navigation failed; restoring a deleted row
      // is more misleading than leaving the current page filtered.
    }
  }

  function pageUrl(page: any) {
    const canonicalPath = zpageCanonicalPath(page || {});
    if (canonicalPath) return canonicalPath;
    if (page?.get_url) return page.get_url;
    return `/article/${page.free2zaddr}`;
  }

  function editUrl(page: any) {
    return `/edit?id=${encodeURIComponent(page.free2zaddr)}`;
  }

  function isScheduled(page: any) {
    return !page?.is_published && Boolean(page?.publish_at);
  }

  function scheduledTime(page: any) {
    // formatScheduledTime names the viewer's zone itself ("... 2:00 PM EDT").
    return formatScheduledTime(page?.publish_at, $locale);
  }

  function openDeleteDialog(page: ZPageListItem, event?: MouseEvent) {
    if (isDeleting) return;
    deleteReturnFocus =
      event?.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    deleteError = null;
    deleteConflict = false;
    deleteTarget = page;
    readDeleteValidator(page.free2zaddr);
    deleteDialogOpen = true;
  }

  function handleDeleteOpenChange(open: boolean) {
    deleteDialogOpen = open;
    if (open || isDeleting) return;

    const returnFocus = deleteReturnFocus;
    deleteReturnFocus = null;
    deleteTarget = null;
    forgetDeleteValidator();
    deleteError = null;
    deleteConflict = false;
    void tick().then(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
    });
  }

  function closeDeleteDialog() {
    if (isDeleting) return;
    deleteDialogOpen = false;
  }

  async function confirmDelete() {
    const operationNotice = captureAccountToast();
    const page = deleteTarget;
    const validator = deleteValidator;
    if (!page || isDeleting || !deleteReady || !validator) return;

    const wasOnlyVisibleRowOnLaterPage = zpages.length === 1 && currentPage > 1;
    isDeleting = true;
    deleteError = null;
    try {
      await deleteZPage(page.free2zaddr, { etag: validator.etag });
      removedIdentifiers = new Set([...removedIdentifiers, page.free2zaddr]);
      deleteDialogOpen = false;
      operationNotice.success(
        $t("dashboard.pages.deleteSuccess", "{title} was deleted.", {
          title: page.title || $t("editor.untitled", "Untitled"),
        }),
      );

      // Avoid leaving the creator on an empty page 2 after deleting its last
      // row. The next load then supplies the correct page and totals.
      if (wasOnlyVisibleRowOnLaterPage) {
        await goToPage(currentPage - 1);
      } else {
        // Re-read this page's slice: the optimistic filter alone leaves it one
        // row short, and when the count drops to a page boundary it hides the
        // pagination that would reach the row pulled forward from the next
        // page. The refreshed data already excludes the deleted row, so the
        // optimistic set is cleared only once it has arrived.
        try {
          await invalidateAll();
          removedIdentifiers = new Set();
        } catch {
          // Keep the optimistic removal; a reload will reconcile.
        }
      }
    } catch (error: unknown) {
      const status =
        error instanceof ZPageDeleteError ? error.status : undefined;
      if (status === 409 && error instanceof Error && error.message) {
        // A permanent refusal (e.g. on-chain payment records protect the
        // page). The server's `detail` is the actionable message; retrying
        // cannot succeed, so do not suggest checking the connection.
        deleteConflict = false;
        deleteError = error.message;
      } else if (status === 412) {
        deleteConflict = true;
        deleteError = $t(
          "dashboard.pages.deleteConflict",
          "This page changed while the dialog was open, so nothing was deleted. Reload the page before trying again.",
        );
      } else if (status === 401 || status === 403) {
        deleteConflict = false;
        deleteError = $t(
          "dashboard.pages.deleteForbidden",
          "You are no longer allowed to delete this page. Reload My Pages and try again.",
        );
      } else {
        deleteConflict = false;
        deleteError = $t(
          "dashboard.pages.deleteFailed",
          "The page was not deleted. Check your connection and try again.",
        );
      }
    } finally {
      isDeleting = false;
    }
  }

  function reloadAfterDeleteConflict() {
    window.location.reload();
  }
</script>

<svelte:head>
  <title>{$t("dashboard.pages.title", "My Pages")} - {username}</title>
  <meta
    name="description"
    content={$t(
      "dashboard.pages.subtitle",
      "Manage all your published articles and drafts",
    )}
  />
</svelte:head>

<main
  data-dashboard-pages-hydrated={isHydrated ? "true" : "false"}
  class="relative flex-1 overflow-hidden bg-background font-sans text-foreground selection:bg-primary/30"
>
  <!-- Background Pattern -->
  <div
    class="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,#8080800d_1px,transparent_1px),linear-gradient(to_bottom,#8080800d_1px,transparent_1px)] mask-[radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] bg-size-[24px_24px] opacity-20"
  ></div>
  <div
    class="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-blue-500/5"
  ></div>

  <div class="relative z-10 mx-auto max-w-7xl px-4 py-8 lg:px-8 lg:py-16">
    <!-- Header -->
    <div
      class="mb-8 flex flex-col items-start justify-between gap-6 md:flex-row md:items-end lg:mb-12"
    >
      <div class="space-y-2">
        <h1
          class="text-3xl font-black tracking-tighter text-foreground md:text-5xl"
        >
          {$t("dashboard.pages.title", "My Pages")}
        </h1>
        <p class="max-w-xl text-lg leading-relaxed text-muted-foreground">
          {$t(
            "dashboard.pages.subtitle",
            "Manage all your published articles and drafts",
          )}
        </p>
      </div>
      <div class="flex w-full flex-wrap gap-3 md:w-auto">
        <Button
          onclick={() => (exportDialogOpen = true)}
          variant="outline"
          class="gap-2 border-primary/20 transition-colors hover:bg-primary/5 hover:text-primary"
        >
          <Download class="size-4" />
          {$t("dashboard.pages.exportArticles", "Export articles")}
        </Button>
        <Button
          href={`/${username}/dashboard/stream`}
          variant="outline"
          class="gap-2 border-primary/20 transition-colors hover:bg-primary/5 hover:text-primary"
        >
          <Radio class="size-4" />
          {$t("dashboard.pages.goLive", "Go live")}
        </Button>
        <Button
          onclick={handleCreateNew}
          class="gap-2 bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90"
        >
          <Plus class="size-4" />
          {$t("dashboard.pages.createNew", "Create New Page")}
        </Button>
      </div>
    </div>

    <!-- Search & Filter Bar -->
    {#if count > 0 || searchQuery}
      <div
        class="mb-8 flex flex-col items-center justify-between gap-4 p-1 md:flex-row"
      >
        <div class="group relative w-full max-w-md flex-1">
          <Search
            class="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary"
            size={18}
          />
          <Input
            type="text"
            placeholder={$t(
              "dashboard.pages.searchPlaceholder",
              "Search pages...",
            )}
            bind:value={searchQuery}
            onkeydown={(e) => e.key === "Enter" && handleSearch()}
            class="border-border bg-muted/40 pl-10 transition-all focus:border-primary/50 focus:ring-primary/20"
          />
        </div>

        <div class="flex gap-1 rounded-lg border border-border bg-muted/40 p-1">
          <Button
            variant="ghost"
            size="sm"
            onclick={() => toggleView("list")}
            class="h-8 px-3 {viewMode === 'list'
              ? 'bg-background text-primary shadow-sm'
              : 'text-muted-foreground hover:text-foreground'}"
            aria-label={$t("dashboard.pages.listView", "List view")}
          >
            <List size={16} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onclick={() => toggleView("card")}
            class="h-8 px-3 {viewMode === 'card'
              ? 'bg-background text-primary shadow-sm'
              : 'text-muted-foreground hover:text-foreground'}"
            aria-label={$t("dashboard.pages.cardView", "Card view")}
          >
            <LayoutGrid size={16} />
          </Button>
        </div>
      </div>

      {#if zpages.length > 0}
        {#if viewMode === "card"}
          <div
            class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 lg:gap-8"
          >
            {#each zpages as zpage (zpage.free2zaddr)}
              <div class="group relative">
                <div class="relative">
                  <ZpageCard
                    story={zpage}
                    privateHref={!zpage.is_published ? editUrl(zpage) : null}
                  />

                  <!-- Overlay Actions for Owner -->
                  <div
                    class="absolute top-3 right-3 z-20 flex gap-2 opacity-100 transition-opacity duration-300 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
                  >
                    <Button
                      href={`/edit?id=${encodeURIComponent(zpage.free2zaddr)}`}
                      size="icon"
                      variant="secondary"
                      class="h-8 w-8 rounded-full border border-border bg-background/80 text-foreground shadow-sm backdrop-blur hover:text-primary"
                      aria-label={$t("dashboard.pages.editPage", "Edit page")}
                      title={$t("dashboard.pages.editPage", "Edit page")}
                    >
                      <Pencil class="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="destructive"
                      class="h-8 w-8 rounded-full shadow-sm"
                      aria-label={$t(
                        "dashboard.pages.deletePage",
                        "Delete page",
                      )}
                      title={$t("dashboard.pages.deletePage", "Delete page")}
                      onclick={(event) => openDeleteDialog(zpage, event)}
                    >
                      <Trash2 class="size-3.5" />
                    </Button>
                  </div>

                  <!-- Status Badge Overlay (if draft) -->
                  {#if isScheduled(zpage)}
                    <div class="absolute top-3 left-3 z-20 space-y-1">
                      <Badge
                        variant="secondary"
                        class="flex items-center gap-1 border-none bg-amber-500/90 text-[10px] font-bold tracking-wider text-black shadow-sm backdrop-blur-sm"
                      >
                        <CalendarClock class="size-3" />
                        {$t("dashboard.pages.scheduled", "Scheduled")}
                      </Badge>
                      <p
                        class="rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-sm backdrop-blur-sm"
                      >
                        {scheduledTime(zpage)}
                      </p>
                    </div>
                  {:else if !zpage.is_published}
                    <div class="absolute top-3 left-3 z-20">
                      <Badge
                        variant="secondary"
                        class="border-none bg-yellow-500/90 text-[10px] font-bold tracking-wider text-black shadow-sm backdrop-blur-sm"
                        >{$t("dashboard.pages.draft", "Draft")}</Badge
                      >
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {:else}
          <!-- List View -->
          <div class="flex flex-col gap-3">
            {#each zpages as zpage (zpage.free2zaddr)}
              <div
                class="group flex items-center gap-4 rounded-xl border border-border bg-card/50 p-4 transition-all duration-200 hover:border-primary/30 hover:bg-card hover:shadow-sm"
              >
                <!-- Status Indicator Line -->
                <div
                  class="w-1 self-stretch rounded-full {zpage.is_published
                    ? 'bg-green-500/50'
                    : isScheduled(zpage)
                      ? 'bg-amber-500/70'
                      : 'bg-yellow-500/50'}"
                ></div>

                <div class="min-w-0 flex-1">
                  <div class="mb-1 flex items-center gap-3">
                    <h3
                      class="truncate text-lg font-semibold text-foreground transition-colors group-hover:text-primary"
                    >
                      {zpage.title || $t("editor.untitled", "Untitled")}
                    </h3>
                    {#if isScheduled(zpage)}
                      <Badge
                        variant="outline"
                        class="flex h-5 items-center gap-1 border-amber-500/30 bg-amber-500/5 py-0 text-[10px] text-amber-600 dark:text-amber-400"
                      >
                        <CalendarClock class="size-3" />
                        {$t("dashboard.pages.scheduled", "Scheduled")}
                      </Badge>
                    {:else if !zpage.is_published}
                      <Badge
                        variant="outline"
                        class="h-5 border-yellow-500/30 bg-yellow-500/5 py-0 text-[10px] text-yellow-500"
                        >{$t("dashboard.pages.draft", "Draft")}</Badge
                      >
                    {/if}
                  </div>

                  <div
                    class="flex items-center gap-4 text-xs text-muted-foreground"
                  >
                    {#if isScheduled(zpage)}
                      <span>
                        {$t("dashboard.pages.scheduledFor", "Scheduled for")}
                        {scheduledTime(zpage)}
                      </span>
                      <span class="text-border">|</span>
                    {/if}
                    <span
                      >{$t("dashboard.pages.lastUpdated", "Last updated")}
                      {formatRelativeTime(zpage.updated_at, $locale)}</span
                    >
                    {#if zpage.vanity}
                      <span class="text-border">|</span>
                      <span class="font-mono">/{zpage.vanity}</span>
                    {/if}
                  </div>
                </div>

                <div
                  class="flex items-center gap-2 opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
                >
                  <Button
                    href={zpage.is_published ? pageUrl(zpage) : editUrl(zpage)}
                    variant="ghost"
                    size="icon"
                    class="h-8 w-8 text-muted-foreground hover:text-foreground"
                    title={zpage.is_published
                      ? $t("dashboard.pages.view", "View")
                      : $t("dashboard.pages.edit", "Edit")}
                  >
                    <Eye class="size-4" />
                  </Button>
                  <Button
                    href={`/edit?id=${encodeURIComponent(zpage.free2zaddr)}`}
                    variant="secondary"
                    size="sm"
                    class="h-8 gap-2"
                  >
                    <Pencil class="size-3.5" />
                    <span class="hidden sm:inline"
                      >{$t("dashboard.pages.edit", "Edit")}</span
                    >
                  </Button>
                  <Button
                    variant="destructive"
                    size="icon"
                    class="h-8 w-8"
                    aria-label={$t("dashboard.pages.deletePage", "Delete page")}
                    title={$t("dashboard.pages.deletePage", "Delete page")}
                    onclick={(event) => openDeleteDialog(zpage, event)}
                  >
                    <Trash2 class="size-3.5" />
                  </Button>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        <!-- Pagination -->
        {#if totalPages > 1}
          <div class="mt-12 flex items-center justify-center gap-2 py-8">
            <Button
              variant="outline"
              size="sm"
              disabled={!hasPrevPage}
              onclick={() => goToPage(currentPage - 1)}
              class="gap-1"
            >
              ← {$t("common.search.previous", "Previous")}
            </Button>

            <div class="mx-2 flex gap-1">
              {#each Array(Math.min(5, totalPages)) as _, i}
                {@const pageNum =
                  Math.max(1, Math.min(totalPages - 4, currentPage - 2)) + i}
                {#if pageNum <= totalPages}
                  <Button
                    variant={pageNum === currentPage ? "default" : "outline"}
                    size="icon"
                    class="h-8 w-8"
                    onclick={() => goToPage(pageNum)}
                  >
                    {pageNum}
                  </Button>
                {/if}
              {/each}
            </div>

            <Button
              variant="outline"
              size="sm"
              disabled={!hasNextPage}
              onclick={() => goToPage(currentPage + 1)}
              class="gap-1"
            >
              {$t("common.search.next", "Next")} →
            </Button>
          </div>
        {/if}
      {:else}
        <div
          class="rounded-3xl border border-dashed border-border bg-muted/20 py-24 text-center"
        >
          <Search class="mx-auto mb-4 size-12 text-muted-foreground/30" />
          <p class="text-lg text-muted-foreground">
            {$t(
              "dashboard.pages.noSearchResults",
              'No pages match your search "{query}"',
              { query: searchQuery },
            )}
          </p>
          <Button variant="link" onclick={clearSearch} class="mt-2 text-primary"
            >{$t("dashboard.pages.clearSearch", "Clear search")}</Button
          >
        </div>
      {/if}
    {:else}
      <!-- Empty State -->
      <div
        class="flex flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-muted/10 py-24 text-center lg:py-32"
      >
        <div class="mb-8 animate-pulse rounded-full bg-primary/10 p-6">
          <FileText class="size-16 text-primary" strokeWidth={1.5} />
        </div>
        <h2 class="mb-4 text-3xl font-bold tracking-tight text-foreground">
          {$t("dashboard.pages.noPagesYet", "No pages yet")}
        </h2>
        <p class="mb-10 max-w-lg text-lg leading-relaxed text-muted-foreground">
          {$t(
            "dashboard.pages.noPagesDescription",
            "Get started by creating your first zPage. Share your thoughts, stories, and ideas with the world.",
          )}
        </p>
        <Button
          onclick={handleCreateNew}
          size="lg"
          class="gap-2 rounded-full bg-primary px-8 text-primary-foreground shadow-xl shadow-primary/20 hover:bg-primary/90"
        >
          <Plus class="size-5" />
          {$t("dashboard.pages.createFirst", "Create Your First Page")}
        </Button>
      </div>
    {/if}
  </div>

  <ExportPublicationDialog bind:open={exportDialogOpen} />
</main>

{#if deleteTarget}
  <Dialog.Root open={deleteDialogOpen} onOpenChange={handleDeleteOpenChange}>
    <Dialog.Content class="max-w-md">
      <Dialog.Header>
        <Dialog.Title>
          {$t("dashboard.pages.deleteTitle", "Delete {title}?", {
            title: deleteTarget.title || $t("editor.untitled", "Untitled"),
          })}
        </Dialog.Title>
        <Dialog.Description>
          {$t(
            "dashboard.pages.deleteBody",
            "This permanently deletes the canonical page and all of its translations.",
          )}
          {#if deleteTarget.is_published}
            {$t(
              "dashboard.pages.deletePublishedWarning",
              "Because this page is published, it will also be removed from public access.",
            )}
          {/if}
        </Dialog.Description>
      </Dialog.Header>
      {#if deleteError}
        <p role="alert" class="text-sm text-destructive">{deleteError}</p>
      {:else if deleteValidatorFailed}
        <p role="alert" class="text-sm text-destructive">
          {$t(
            "dashboard.pages.deleteVersionFailed",
            "Could not check this page's current version, so nothing can be deleted yet. Check your connection and try again.",
          )}
        </p>
      {/if}
      <Dialog.Footer class="gap-2">
        {#if deleteValidatorFailed && !deleteError}
          <Button
            variant="outline"
            onclick={() => {
              if (deleteTarget) readDeleteValidator(deleteTarget.free2zaddr);
            }}
          >
            {$t("dashboard.pages.deleteVersionRetry", "Try again")}
          </Button>
        {/if}
        {#if deleteConflict}
          <Button
            variant="outline"
            onclick={reloadAfterDeleteConflict}
            disabled={isDeleting}
          >
            {$t("dashboard.pages.reload", "Reload")}
          </Button>
        {/if}
        <Button
          variant="outline"
          onclick={closeDeleteDialog}
          disabled={isDeleting}
        >
          {$t("common.cancel", "Cancel")}
        </Button>
        <Button
          variant="destructive"
          onclick={() => void confirmDelete()}
          disabled={isDeleting || !deleteReady}
          aria-busy={isDeleting || deleteValidator?.status === "pending"}
        >
          {#if isDeleting}
            <Loader2 class="mr-2 size-4 animate-spin" />
            {$t("dashboard.pages.deleting", "Deleting…")}
          {:else if deleteValidator?.status === "pending"}
            <Loader2 class="mr-2 size-4 animate-spin" />
            {$t("dashboard.pages.deleteConfirm", "Delete permanently")}
          {:else}
            <Trash2 class="mr-2 size-4" />
            {$t("dashboard.pages.deleteConfirm", "Delete permanently")}
          {/if}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}
