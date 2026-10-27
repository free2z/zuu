<script lang="ts">
  import { afterNavigate } from "$app/navigation";
  import { scrollTopbar } from "$lib/actions/scrollTopbar";
  import { page } from "$app/state";
  import { locale, tStore as t, loading } from "$lib/i18n";
  import AuthButton from "$lib/components/auth/AuthButton.svelte";
  import AuthPendingPlaceholder from "$lib/components/auth/AuthPendingPlaceholder.svelte";
  import AuthUserDropdown from "$lib/components/auth/AuthUserDropdown.svelte";
  import { authStatus, isAuthenticated } from "$lib/stores/auth";
  import { Button } from "$lib/components/ui/button";
  import { MessagesSquare, Search, SquarePen } from "@lucide/svelte";
  import LiveIndicator from "$lib/components/stream/LiveIndicator.svelte";
  import { currentUser } from "$lib/stores/auth";
  import SearchCommand from "$lib/components/layout/SearchCommand.svelte";
  import MobileNavMenu from "$lib/components/layout/MobileNavMenu.svelte";
  import NotificationBell from "$lib/components/layout/NotificationBell.svelte";

  // Icon buttons recolor on hover only — no background/ring chrome around them.
  const iconButtonClass =
    "text-(--f2z-text-secondary) hover:bg-transparent dark:hover:bg-transparent hover:text-(--f2z-accent-primary) focus-visible:text-(--f2z-accent-primary)";

  // Auth is three-state here, not two. `!$isAuthenticated` is also
  // true for the ~200ms before `/api/auth/user/` answers, and rendering
  // "Sign In" in that window tells a signed-in creator the site logged them
  // out. Only `anonymous` may render a signed-out affordance.
  //
  // The store always reads `unknown` during SSR — it is module-scoped and
  // shared by every concurrent request, so nothing writes to it on the server
  //. `page.data.hasSession` is the per-request server signal that
  // resolves the anonymous case without a client round-trip: no `sessionid`
  // cookie means Django cannot authenticate this request, full stop. It is
  // only ever consulted as a fallback, so a client-side login (which leaves
  // the already-loaded `page.data` stale) can never demote a signed-in user.
  const resolvedAuthStatus = $derived(
    $authStatus !== "unknown"
      ? $authStatus
      : page.data.hasSession === false
        ? "anonymous"
        : "unknown",
  );
  const isAuthUnresolved = $derived(resolvedAuthStatus === "unknown");
  let searchOpen = $state(false);
  let shortcutLabel = $state("");
  const isConverseRoute = $derived(page.url.pathname.startsWith("/converse"));
  const isSearchPage = $derived(page.url.pathname === "/search");
  // Below md the homepage is the vertical feed, which carries its own search
  // field at the top — so the icon here would be a second, redundant control
  // for the same thing. Desktop keeps its search trigger: the magazine layout
  // has no search field of its own.
  const isHomePage = $derived(page.url.pathname === "/");
  const isEditorRoute = $derived(page.url.pathname === "/edit");

  $effect(() => {
    const updateShortcutLabel = () => {
      shortcutLabel = getSearchShortcutLabel();
    };

    // `resize` never fires for a pointer change (docking a tablet, plugging in
    // a mouse), so listen to the media queries themselves rather than to the
    // window: both inputs to the label are media queries.
    const queries = [
      window.matchMedia("(max-width: 767px)"),
      window.matchMedia("(pointer: coarse)"),
    ];

    updateShortcutLabel();
    for (const query of queries)
      query.addEventListener("change", updateShortcutLabel);
    return () => {
      for (const query of queries)
        query.removeEventListener("change", updateShortcutLabel);
    };
  });

  function getSearchShortcutLabel() {
    const nav = navigator as Navigator & {
      userAgentData?: { mobile?: boolean; platform?: string };
    };
    const userAgent = nav.userAgent || "";
    const platform = nav.userAgentData?.platform || nav.platform || "";
    const isNarrowViewport = window.matchMedia("(max-width: 767px)").matches;
    // A coarse primary pointer means touch/stylus: there is no physical ⌘/Ctrl
    // key to press, so the hint is noise.
    const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
    const isMobile =
      Boolean(nav.userAgentData?.mobile) ||
      /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i.test(
        userAgent,
      ) ||
      (/macintosh/i.test(userAgent) && nav.maxTouchPoints > 1);

    if (isNarrowViewport || isCoarsePointer || isMobile) return "";

    return /mac/i.test(platform) || /macintosh/i.test(userAgent)
      ? "⌘K"
      : "Ctrl K";
  }

  // Global shortcuts: ⌘K / Ctrl+K toggles search anywhere; "/" opens it
  // unless the user is typing in a field.
  function handleGlobalKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      searchOpen = !searchOpen;
      return;
    }

    if (event.key === "/" && !searchOpen) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable)
        return;
      event.preventDefault();
      searchOpen = true;
    }
  }

  let navigationRevision = $state(0);
  afterNavigate(() => {
    navigationRevision += 1;
  });

  let profileOpen = $state(false);
  let mobileMenuOpen = $state(false);
</script>

<svelte:window on:keydown={handleGlobalKeydown} />

<!-- `lang` on the chrome, because `<html lang>` now names the language of the
     PAGE's content — an article variant's own language on a zPage.
     The navbar's text comes from the UI catalogs, so it says which language it
     is in rather than inheriting the article's. -->
<nav
  lang={$locale}
  use:scrollTopbar={{
    pinned: searchOpen || profileOpen || mobileMenuOpen,
    resetKey: navigationRevision,
  }}
  class="scroll-topbar sticky top-0 z-50 border-b-0 border-(--f2z-border-primary)/70 bg-(--f2z-bg-primary)/96 shadow-[0_4px_12px_rgba(0,0,0,0.12)] md:border-b md:shadow-sm"
>
  <div
    class="relative mx-auto flex h-[3.25rem] items-center gap-2 px-3 md:h-14 md:gap-3 md:px-6"
  >
    <!-- Left: menu + brand -->
    <div
      class="flex min-w-0 flex-1 items-center justify-start md:flex-initial md:gap-1 lg:flex-1"
    >
      <!-- Mobile only: the feed makes the footer unreachable, so these links
           need a home in the header. -->
      <MobileNavMenu
        bind:open={mobileMenuOpen}
        triggerClass="md:hidden size-10 rounded-none border-0 p-0 {iconButtonClass} focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--f2z-accent-primary)"
      />
      <Button
        href="/"
        size="sm"
        variant="link"
        class="static ml-1 translate-x-0 px-0 text-xl font-bold tracking-tight text-(--f2z-accent-secondary) no-underline transition-colors hover:text-(--f2z-accent-primary) hover:no-underline sm:text-2xl md:ml-0 md:text-3xl"
        aria-label={$t("common.navigation.homeAria", "Go to homepage")}
        data-testid="navbar-brand"
      >
        {!$loading ? $t("common.navigation.logo") : "Free2Z"}
      </Button>
    </div>

    <!-- Center: search trigger (desktop) -->
    {#if !isSearchPage}
      <button
        type="button"
        onclick={() => (searchOpen = true)}
        class="group hidden h-9 max-w-md min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border border-(--f2z-border-primary) bg-(--f2z-bg-secondary) pr-2 pl-3 text-sm text-(--f2z-text-muted) shadow-xs transition-colors hover:border-(--f2z-accent-primary) focus-visible:border-(--f2z-accent-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none md:flex"
        aria-label={$t("common.search.title", "Search")}
      >
        <Search
          class="size-4 shrink-0 transition-colors group-hover:text-(--f2z-accent-primary)"
        />
        <span class="flex-1 truncate text-left"
          >{$t(
            "common.navigation.searchPlaceholder",
            "Search creators and pages…",
          )}</span
        >
        {#if shortcutLabel}
          <!-- pointer-coarse belt-and-braces: the label is already blanked in
               JS on touch devices, this keeps it hidden even if a UA
               reports a desktop-width viewport with a touch-only pointer. -->
          <kbd
            class="hidden h-5 items-center gap-0.5 rounded border border-(--f2z-border-primary) bg-(--f2z-bg-primary) px-1.5 font-sans text-[11px] font-medium text-(--f2z-text-muted) md:inline-flex pointer-coarse:hidden!"
          >
            {shortcutLabel}
          </kbd>
        {/if}
      </button>
    {/if}

    <!-- Right: actions -->
    <div
      class="flex shrink-0 items-center justify-end gap-0 min-[360px]:gap-1 md:gap-2 lg:flex-1"
    >
      <!-- Search trigger (mobile). Hidden on the homepage, where the feed
           below md already shows a search field. -->
      {#if !isSearchPage && !isHomePage}
        <Button
          variant="ghost"
          size="icon-sm"
          class="md:hidden {iconButtonClass}"
          aria-label={$t("common.search.title", "Search")}
          data-testid="navbar-mobile-search"
          onclick={() => (searchOpen = true)}
        >
          <Search class="size-[1.125rem]" />
        </Button>
      {/if}

      <!-- Primary create affordance: one click to the editor from anywhere
           . Icon-only on small screens, labelled from lg up. -->
      {#if $isAuthenticated}
        <Button
          href="/edit"
          variant="ghost"
          size="sm"
          data-testid="nav-create"
          class="size-8 p-0 md:h-8 md:w-auto md:px-2.5 {iconButtonClass} {isEditorRoute
            ? 'text-(--f2z-accent-primary)'
            : ''}"
          aria-label={$t("common.navigation.create", "Create")}
          aria-current={isEditorRoute ? "page" : undefined}
          title={$t("common.navigation.create", "Create")}
        >
          <SquarePen class="size-4" />
          <span class="hidden lg:inline"
            >{$t("common.navigation.create", "Create")}</span
          >
        </Button>
      {/if}

      <!-- Labeled, not a bare glyph. An icon-only entrance was the ONLY way
           into the microblog stream, at any breakpoint, which is most of why
           nobody found it. Same `hidden lg:inline` treatment as Create, so the
           narrow navbar still gets an icon and desktop gets a word. -->
      <Button
        href="/converse"
        variant="ghost"
        size="sm"
        class="inline-flex size-8 p-0 md:h-8 md:w-auto md:px-2.5 {iconButtonClass} {isConverseRoute
          ? 'text-(--f2z-accent-primary)'
          : ''}"
        aria-label={$t("converse.title", "Converse")}
        aria-current={isConverseRoute ? "page" : undefined}
        title={$t("converse.title", "Converse")}
        data-testid="navbar-converse"
      >
        <MessagesSquare class="size-[0.9375rem] sm:size-4" />
        <span class="hidden lg:inline">{$t("converse.title", "Converse")}</span>
      </Button>

      {#if $isAuthenticated}
        <!-- Carries its own "live notifications are offline" state.
             It lives inside the bell rather than beside it because a second
             control overflows a 320px navbar on any non-home route. -->
        <NotificationBell class={iconButtonClass} />
      {/if}

      {#if $isAuthenticated && $currentUser?.username}
        <div class="ml-1 hidden sm:block">
          <LiveIndicator
            username={$currentUser.username}
            size="sm"
            showCount={false}
          />
        </div>
      {/if}

      <div class="ml-3 flex shrink-0 items-center">
        {#if $isAuthenticated}
          <AuthUserDropdown bind:open={profileOpen} />
        {:else if isAuthUnresolved}
          <AuthPendingPlaceholder />
        {:else}
          <AuthButton />
        {/if}
      </div>
    </div>
  </div>
</nav>

<SearchCommand bind:open={searchOpen} />
