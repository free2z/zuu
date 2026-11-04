<script lang="ts">
  import { page } from "$app/state";
  import * as Sheet from "$lib/components/ui/sheet";
  import { Button } from "$lib/components/ui/button";
  import {
    Activity,
    Bell,
    BookOpen,
    FileText,
    Heart,
    LockKeyhole,
    MessageCircleQuestion,
    MessagesSquare,
    Menu,
    ShieldCheck,
    TrendingUp,
    Users,
  } from "@lucide/svelte";
  import GitHubBrandIcon from "$lib/components/GitHubBrandIcon.svelte";
  import { tStore as t } from "$lib/i18n";
  import { currentUser, isAuthenticated } from "$lib/stores/auth";
  import LanguageSelector from "$lib/components/layout/LanguageSelector.svelte";
  import ModeToggle from "$lib/components/layout/ModeToggle.svelte";
  import {
    EXPLORE_LINKS,
    LEGAL_LINKS,
    RESOURCE_LINKS,
    SOCIAL_LINKS,
  } from "$lib/nav-links.js";

  // Below md the homepage footer is hidden, so this menu is the mobile route
  // to Terms, Privacy and Help. It renders from $lib/nav-links.js, the same
  // list the footer uses, so the two cannot drift.
  export let triggerClass = "";

  export let open = false;
  const navLinkBase =
    "group relative flex min-h-10 items-center rounded-lg px-3 text-sm font-medium no-underline outline-none transition-[background-color,border-color,color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none";

  function isActivePath(href: string): boolean {
    const pathname = page.url.pathname;
    if (!href || href.startsWith("http")) return false;
    if (href === "/") return pathname === "/";
    const normalized = href.endsWith("/") ? href.slice(0, -1) : href;
    return pathname === normalized || pathname.startsWith(`${normalized}/`);
  }

  function navLinkClass(href: string): string {
    return `${navLinkBase} ${
      isActivePath(href)
        ? "text-(--f2z-accent-primary)"
        : "text-(--f2z-text-secondary) hover:bg-(--f2z-bg-secondary)/45 hover:text-(--f2z-text-primary)"
    }`;
  }

  function navIconClass(href: string): string {
    return `mr-2.5 size-4 transition-colors ${
      isActivePath(href)
        ? "text-(--f2z-accent-primary)"
        : "text-(--f2z-text-tertiary) group-hover:text-(--f2z-accent-primary)"
    }`;
  }

  const sections = [
    { key: "navigation.explore", fallback: "Explore", links: EXPLORE_LINKS },
    { key: "footer.resources", fallback: "Resources", links: RESOURCE_LINKS },
    { key: "footer.legal", fallback: "Legal", links: LEGAL_LINKS },
  ];
</script>

<Sheet.Root bind:open>
  <Sheet.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="icon-sm"
        class={triggerClass}
        aria-label={$t("navigation.menu", "Menu")}
        data-testid="navbar-mobile-menu"
      >
        <Menu class="size-[1.4rem]" strokeWidth={1.75} />
      </Button>
    {/snippet}
  </Sheet.Trigger>

  <Sheet.Content
    side="left"
    class="w-[min(22rem,calc(100vw-1rem))] gap-0 overflow-hidden border-(--f2z-border-primary) bg-(--f2z-bg-primary) p-0 text-(--f2z-text-primary) sm:max-w-sm"
  >
    <Sheet.Header class="px-5 pt-5 pb-3 text-start">
      <Sheet.Title>
        <a
          href="/"
          onclick={() => (open = false)}
          class="text-xl font-bold tracking-tight text-(--f2z-accent-secondary) no-underline transition-colors hover:text-(--f2z-accent-primary) hover:no-underline focus-visible:text-(--f2z-accent-primary) focus-visible:outline-none"
        >
          {$t("common.navigation.logo", "Free2Z")}
        </a>
      </Sheet.Title>
      <Sheet.Description class="sr-only">
        {$t("navigation.menuDescription", "Site navigation")}
      </Sheet.Description>
    </Sheet.Header>

    <nav
      class="flex min-h-0 flex-1 [scrollbar-width:none] flex-col gap-4 overflow-y-auto px-5 py-4 [&::-webkit-scrollbar]:hidden"
      data-testid="mobile-menu-scroll"
    >
      {#if $isAuthenticated && $currentUser?.username}
        <a
          href="/{$currentUser.username}/dashboard/notifications"
          onclick={() => (open = false)}
          class={navLinkClass(
            `/${$currentUser.username}/dashboard/notifications`,
          )}
          aria-current={isActivePath(
            `/${$currentUser.username}/dashboard/notifications`,
          )
            ? "page"
            : undefined}
          data-testid="mobile-menu-notifications"
        >
          <Bell
            class={navIconClass(
              `/${$currentUser.username}/dashboard/notifications`,
            )}
            aria-hidden="true"
          />
          {$t("common.navigation.notifications", "Notifications")}
        </a>
      {/if}

      {#each sections as section (section.key)}
        <div>
          <h3
            class="text-xs font-semibold tracking-[0.14em] text-(--f2z-text-secondary) uppercase"
          >
            {$t(section.key, section.fallback)}
          </h3>
          <ul class="mt-3 flex list-none flex-col gap-1 p-0">
            {#each section.links as link (link.href)}
              <li>
                <a
                  href={link.href}
                  data-sveltekit-reload={link.reload ? true : undefined}
                  onclick={() => (open = false)}
                  class={navLinkClass(link.href)}
                  aria-current={isActivePath(link.href) ? "page" : undefined}
                >
                  {#if link.href === "/creators"}
                    <Users class={navIconClass(link.href)} aria-hidden="true" />
                  {:else if link.href === "/trending"}
                    <TrendingUp
                      class={navIconClass(link.href)}
                      aria-hidden="true"
                    />
                  {:else if link.href === "/converse"}
                    <MessagesSquare
                      class={navIconClass(link.href)}
                      aria-hidden="true"
                    />
                  {:else if link.href === "/free2z"}
                    <Activity
                      class={navIconClass(link.href)}
                      aria-hidden="true"
                    />
                  {:else if link.href === "/docs/"}
                    <BookOpen
                      class={navIconClass(link.href)}
                      aria-hidden="true"
                    />
                  {:else if link.href === "/docs/getting-started/"}
                    <MessageCircleQuestion
                      class={navIconClass(link.href)}
                      aria-hidden="true"
                    />
                  {:else if link.href === "/docs/privacy-and-security/"}
                    <ShieldCheck
                      class={navIconClass(link.href)}
                      aria-hidden="true"
                    />
                  {:else if link.href === "/docs/legal/"}
                    <FileText
                      class={navIconClass(link.href)}
                      aria-hidden="true"
                    />
                  {:else}
                    <LockKeyhole
                      class={navIconClass(link.href)}
                      aria-hidden="true"
                    />
                  {/if}
                  <span class="truncate">{$t(link.key, link.fallback)}</span>
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </nav>

    <div
      class="z-10 flex shrink-0 flex-col gap-4 border-t border-(--f2z-border-primary) bg-(--f2z-bg-primary) px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
      data-testid="mobile-menu-preferences"
    >
      <div class="grid grid-cols-2 gap-4">
        <div class="flex min-w-0 flex-col gap-2">
          <span
            class="text-[11px] font-semibold tracking-[0.12em] text-(--f2z-text-muted) uppercase"
          >
            {$t("language.label", "Language")}
          </span>
          <LanguageSelector />
        </div>
        <div class="flex min-w-0 flex-col gap-2">
          <span
            class="text-[11px] font-semibold tracking-[0.12em] text-(--f2z-text-muted) uppercase"
          >
            {$t("theme.label", "Theme")}
          </span>
          <ModeToggle />
        </div>
      </div>

      <div
        class="flex items-center gap-3 border-t border-(--f2z-border-primary) pt-4"
      >
        {#each SOCIAL_LINKS as link (link.href)}
          <a
            href={link.href}
            target={link.external ? "_blank" : undefined}
            rel={link.external ? "noreferrer" : undefined}
            onclick={() => (open = false)}
            class="group grid size-11 place-items-center rounded-full text-(--f2z-text-muted) no-underline transition-colors hover:text-(--f2z-text-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none"
            aria-label={$t(link.key, link.fallback)}
          >
            <span
              class="grid size-8 place-items-center rounded-full border border-(--f2z-border-primary) bg-(--f2z-bg-primary)/60 transition-all group-hover:-translate-y-0.5 group-hover:border-(--f2z-accent-primary)/45"
              aria-hidden="true"
            >
              {#if link.key === "footer.communityLabel"}
                <Heart class="size-3.5" />
              {:else if link.key === "footer.githubLabel"}
                <GitHubBrandIcon class="size-3.5" />
              {:else}
                <span class="text-xs font-semibold">X</span>
              {/if}
            </span>
          </a>
        {/each}
      </div>
    </div>
  </Sheet.Content>
</Sheet.Root>
