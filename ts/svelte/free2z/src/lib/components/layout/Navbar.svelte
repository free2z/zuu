<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { tStore as t, loading } from "$lib/i18n";
  import AuthButton from "$lib/components/auth/AuthButton.svelte";
  import AuthUserDropdown from "$lib/components/auth/AuthUserDropdown.svelte";
  import { isAuthenticated } from "$lib/stores/auth";
  import { eventNotifications } from "$lib/stores/eventNotifications";
  import { Button } from "$lib/components/ui/button";
  import { Bell, MessagesSquare, Search } from "@lucide/svelte";
  import LiveIndicator from "$lib/components/stream/LiveIndicator.svelte";
  import { currentUser } from "$lib/stores/auth";
  import SearchCommand from "$lib/components/layout/SearchCommand.svelte";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import { CLASSIC_UI_PATH, classicUiAvailable } from "$lib/utils/classic-ui";

  // Icon buttons recolor on hover only — no background/ring chrome around them.
  const iconButtonClass =
    "text-(--f2z-text-secondary) hover:bg-transparent dark:hover:bg-transparent hover:text-(--f2z-accent-primary) focus-visible:text-(--f2z-accent-primary)";

  let searchOpen = $state(false);
  let shortcutLabel = $state("");
  const isConverseRoute = $derived(page.url.pathname.startsWith("/converse"));
  const showClassicLink = classicUiAvailable();

  $effect(() => {
    const updateShortcutLabel = () => {
      shortcutLabel = getSearchShortcutLabel();
    };

    updateShortcutLabel();
    window.addEventListener("resize", updateShortcutLabel);
    return () => window.removeEventListener("resize", updateShortcutLabel);
  });

  function getSearchShortcutLabel() {
    const nav = navigator as Navigator & {
      userAgentData?: { mobile?: boolean; platform?: string };
    };
    const userAgent = nav.userAgent || "";
    const platform = nav.userAgentData?.platform || nav.platform || "";
    const isNarrowViewport = window.matchMedia("(max-width: 767px)").matches;
    const isMobile =
      Boolean(nav.userAgentData?.mobile) ||
      /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i.test(
        userAgent,
      ) ||
      (/macintosh/i.test(userAgent) && nav.maxTouchPoints > 1);

    if (isNarrowViewport || isMobile) return "";

    return /mac/i.test(platform) || /macintosh/i.test(userAgent)
      ? "⌘K"
      : "Ctrl K";
  }

  function handleNotificationsClick() {
    if ($currentUser?.username) {
      goto(`/${$currentUser.username}/dashboard/notifications`);
      return;
    }
    goto("/?login=true");
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

  // Hide-on-scroll-down, reveal-on-scroll-up.
  let lastScrollY = $state(0);
  let visible = $state(true);
  // Transparent at the page top so the hero glow/grid flow up into the bar;
  // a translucent surface fades in only once scrolled, for legibility.
  let scrolled = $state(false);
  const threshold = 20;
  const upThreshold = 10;

  function handleScroll() {
    const currentScrollY = window.scrollY;
    scrolled = currentScrollY > 8;
    const delta = currentScrollY - lastScrollY;
    if (Math.abs(delta) < 5) return;

    if (delta > 0 && currentScrollY > threshold) {
      visible = false;
    } else if (delta < -upThreshold || currentScrollY < threshold) {
      visible = true;
    }
    lastScrollY = currentScrollY;
  }
</script>

<svelte:window on:scroll={handleScroll} on:keydown={handleGlobalKeydown} />

<nav
  class="sticky top-0 z-50 border-b transition-all duration-300 {visible
    ? 'translate-y-0'
    : '-translate-y-full'} {scrolled
    ? 'border-(--f2z-border-primary) bg-(--f2z-bg-primary)/80 backdrop-blur-md'
    : 'border-transparent bg-transparent'}"
>
  <div class="mx-auto flex h-14 items-center gap-3 px-4 md:px-6">
    <!-- Left: brand -->
    <div class="flex flex-1 items-center justify-start">
      <Button
        href="/"
        size="sm"
        variant="link"
        class="px-0 text-xl font-bold tracking-tight text-(--f2z-accent-secondary) no-underline transition-colors hover:text-(--f2z-accent-primary) hover:no-underline sm:text-2xl md:text-3xl"
        aria-label="Go to homepage"
      >
        {!$loading ? $t("common.navigation.logo") : "Free2Z"}
      </Button>
    </div>

    <!-- Center: search trigger (desktop) -->
    <button
      type="button"
      onclick={() => (searchOpen = true)}
      class="group hidden h-9 w-full max-w-md cursor-pointer items-center gap-2 rounded-md border border-(--f2z-border-primary) bg-(--f2z-bg-secondary) pr-2 pl-3 text-sm text-(--f2z-text-muted) shadow-xs transition-colors hover:border-(--f2z-accent-primary) focus-visible:border-(--f2z-accent-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none sm:flex"
      aria-label="Search"
    >
      <Search
        class="size-4 shrink-0 transition-colors group-hover:text-(--f2z-accent-primary)"
      />
      <span class="flex-1 truncate text-left">Search creators and pages…</span>
      {#if shortcutLabel}
        <kbd
          class="hidden h-5 items-center gap-0.5 rounded border border-(--f2z-border-primary) bg-(--f2z-bg-primary) px-1.5 font-sans text-[11px] font-medium text-(--f2z-text-muted) md:inline-flex"
        >
          {shortcutLabel}
        </kbd>
      {/if}
    </button>

    <!-- Right: actions -->
    <div class="flex flex-1 items-center justify-end gap-1">
      <!-- Search trigger (mobile) -->
      <Button
        variant="ghost"
        size="icon-sm"
        class="sm:hidden {iconButtonClass}"
        aria-label="Search"
        onclick={() => (searchOpen = true)}
      >
        <Search class="size-5" />
      </Button>

      <Button
        href="/converse"
        variant="ghost"
        size="icon-sm"
        class="{iconButtonClass} {isConverseRoute
          ? 'text-(--f2z-accent-primary)'
          : ''}"
        aria-label="Converse"
        aria-current={isConverseRoute ? "page" : undefined}
        title="Converse"
      >
        <MessagesSquare class="size-4" />
      </Button>

      {#if $isAuthenticated}
        <Button
          variant="ghost"
          size="icon-sm"
          class="relative {iconButtonClass}"
          aria-label="Notifications"
          title="Notifications"
          onclick={handleNotificationsClick}
        >
          <Bell class="size-4" />
          {#if $eventNotifications.unreadCount > 0}
            <span
              class="absolute -top-1 -right-1 h-5 min-w-5 rounded-full bg-primary px-1 text-center text-[10px] leading-5 font-bold text-primary-foreground"
            >
              {$eventNotifications.unreadCount > 99
                ? "99+"
                : $eventNotifications.unreadCount}
            </span>
          {/if}
        </Button>
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

      {#if showClassicLink && !$isAuthenticated}
        <Tooltip.Provider delayDuration={180}>
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  href={CLASSIC_UI_PATH}
                  data-sveltekit-reload
                  variant="ghost"
                  size="icon-sm"
                  class="group rounded-full bg-transparent hover:bg-transparent dark:hover:bg-transparent"
                  aria-label="Switch to the classic Free2Z site"
                >
                  <img
                    src="/favicon.ico"
                    alt=""
                    class="size-5 object-contain opacity-60 grayscale transition-all duration-200 group-hover:scale-110 group-hover:opacity-100 group-hover:grayscale-0 group-focus-visible:scale-110 group-focus-visible:opacity-100 group-focus-visible:grayscale-0"
                  />
                </Button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content side="bottom" sideOffset={8}>
              Switch back to classic site
            </Tooltip.Content>
          </Tooltip.Root>
        </Tooltip.Provider>
      {/if}

      <div class="ml-1">
        {#if $isAuthenticated}
          <AuthUserDropdown />
        {:else}
          <AuthButton />
        {/if}
      </div>
    </div>
  </div>
</nav>

<SearchCommand bind:open={searchOpen} />
