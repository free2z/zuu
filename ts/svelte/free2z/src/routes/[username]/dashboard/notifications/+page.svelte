<script lang="ts">
  import type { PageData } from "./$types";
  import { goto } from "$app/navigation";
  import { onMount, onDestroy } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Select from "$lib/components/ui/select";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import {
    eventNotifications,
    type EventReadFilter,
    type EventSortOrder,
  } from "$lib/stores/eventNotifications";
  import { currentUser } from "$lib/stores/auth";
  import { formatRelativeTime, toTimestamp } from "$lib/utils/date";
  import { formatEventNotification } from "$lib/utils/event-notifications";
  import { isSingularCount, locale, tStore as t } from "$lib/i18n";
  import { toast, captureAccountToast } from "$lib/toast.js";
  import { isApiTimeoutError } from "$lib/api/request-timeout.js";
  import {
    ArrowUpDown,
    Bell,
    CheckCheck,
    Clock3,
    Coins,
    Loader2,
    RefreshCcw,
  } from "@lucide/svelte";

  export let data: PageData;

  /**
   * "Mark all as read" used to fail silently and snap the list back.
   * The store now undoes only its own optimistic flip, re-reads the server and
   * re-throws; this says so, with the server's reason when it gave one.
   */
  async function markAllRead() {
    const operationNotice = captureAccountToast();
    try {
      await eventNotifications.markAllRead();
    } catch (error: any) {
      operationNotice.error(
        error?.serverMessage ||
          (isApiTimeoutError(error) ? error.message : "") ||
          $t(
            "dashboard.notifications.markAllReadFailed",
            "Could not mark your notifications as read. Try again.",
          ),
      );
    }
  }

  let mounted = false;
  let sentinel: HTMLDivElement | null = null;
  let observer: IntersectionObserver | null = null;
  let view: ReturnType<
    typeof eventNotifications.enterNotificationsView
  > | null = null;

  $: state = $eventNotifications;
  $: showAllEvents = state.filter === "all";
  $: unreadCount = Math.max(
    state.unreadCount,
    state.events.filter((event) => !event.read).length,
  );
  $: visibleEvents = state.events
    .filter((event) => {
      if (state.readFilter === "unread") return !event.read;
      if (state.readFilter === "read") return event.read;
      return true;
    })
    .sort((a, b) => {
      const difference = toTimestamp(a.created_at) - toTimestamp(b.created_at);
      return state.sortOrder === "oldest" ? difference : -difference;
    });

  const SENT_OR_SPEND_TYPES = [
    "DONATION_SENT",
    "SUBSCRIPTION_SENT",
    "PAY_PER_VIEW_SPEND",
  ];

  // key suffix under dashboard.notifications.eventTypes.* -> English fallback
  const EVENT_TYPE_LABELS: Record<string, [string, string]> = {
    AISCORE_COMMENT: ["aiScoreComment", "AI Score"],
    MADE_COMMENT: ["comment", "Comment"],
    VOTE_COMMENT_RECEIVED: ["commentVoteReceived", "Comment Vote In"],
    VOTE_COMMENT_SENT: ["commentVoteSent", "Comment Vote Out"],
    NEW_REPLY: ["reply", "Reply"],
    PAGE_UPDATE: ["pageUpdate", "Page Update"],
    PAGE_VOTE: ["pageVote", "Page Vote"],
    PAGE_MENTION: ["pageMention", "Page Mention"],
    DONATION_RECEIVED: ["donationReceived", "Donation In"],
    DONATION_SENT: ["donationSent", "Donation Out"],
    SUBSCRIPTION_RECEIVED: ["subscriptionReceived", "Subscription In"],
    SUBSCRIPTION_SENT: ["subscriptionSent", "Subscription Out"],
    BOUGHT_TUZI: ["bought2Z", "Bought 2Z"],
    ZEC_PENDING: ["zecPending", "Payment Seen"],
    PLATFORM_FEE: ["platformFee", "Platform Fee"],
    PAY_PER_VIEW_REVENUE: ["ppvRevenue", "PPV credits received"],
    PAY_PER_VIEW_SPEND: ["ppvSpend", "PPV Spend"],
    ENCRYPTED_CHAT_REQUEST: ["encryptedChatRequest", "Encrypted Chat"],
  };

  function isSentOrSpendType(type: string | undefined): boolean {
    return Boolean(type && SENT_OR_SPEND_TYPES.includes(type));
  }

  function eventTypeLabel(type: string | undefined): string {
    if (!type) return $t("dashboard.notifications.eventTypes.event", "Event");
    // Brand name, deliberately not translated.
    if (type === "CHAT2Z") return "Chat2Z";
    const entry = EVENT_TYPE_LABELS[type];
    if (!entry) return type.replaceAll("_", " ");
    return $t(`dashboard.notifications.eventTypes.${entry[0]}`, entry[1]);
  }

  function contributorAvatar(event: any): string | null {
    return (
      event?.contributor?.avatar_image?.thumbnail ||
      event?.contributor?.avatar_image?.url ||
      null
    );
  }

  function contributorInitial(event: any): string {
    return (
      event?.contributor?.username?.trim()?.charAt(0)?.toUpperCase() || "?"
    );
  }

  function counterparty(event: any): string {
    if (isSentOrSpendType(event?.type) && event?.payee?.username) {
      return $t("dashboard.notifications.toUser", "To: {username}", {
        username: event.payee.username,
      });
    }
    if (event?.contributor?.username) {
      return $t("dashboard.notifications.fromUser", "From: {username}", {
        username: event.contributor.username,
      });
    }
    return "";
  }

  function amountLabel(amount: number): string {
    const formatted = amount.toLocaleString($locale);
    return isSingularCount(amount, $locale)
      ? $t("dashboard.notifications.amount2ZOne", "{amount} 2Z", {
          amount: formatted,
        })
      : $t("dashboard.notifications.amount2Z", "{amount} 2Z", {
          amount: formatted,
        });
  }

  async function openEvent(event: any) {
    if (!event) return;

    if (!event.read) {
      await eventNotifications.markRead(event.id);
    }

    if (!event.content_url) {
      return;
    }

    if (event.content_url.startsWith("/")) {
      goto(event.content_url);
      return;
    }

    window.location.href = event.content_url;
  }

  async function onFilterChange(nextShowAll: boolean) {
    const nextFilter = nextShowAll ? "all" : "social";
    if (nextFilter === state.filter) {
      return;
    }
    await eventNotifications.setFilter(nextFilter);
  }

  async function onReadFilterChange(value: string | undefined) {
    if (!value || value === state.readFilter) return;
    await eventNotifications.setReadFilter(value as EventReadFilter);
  }

  async function onSortChange(value: string | undefined) {
    if (!value || value === state.sortOrder) return;
    await eventNotifications.setSortOrder(value as EventSortOrder);
  }

  // Initial authentication may reset the shared feed after this page mounts.
  // Reacquire only for this mounted recipient; logout never revives its lease.
  $: if (
    mounted &&
    state &&
    $currentUser?.username === data.username &&
    !view?.isCurrent()
  ) {
    void activateView();
  }

  async function activateView() {
    observer?.disconnect();
    observer = null;
    const lease = eventNotifications.enterNotificationsView(data.username);
    view = lease;
    await eventNotifications.refreshMeta(data.username);
    if (!lease.isCurrent()) return;
    await eventNotifications.loadInitial();
    if (!lease.isCurrent()) return;
    // Install scrolling once the head is ready; oldest traversal must not
    // hold the page's controls/observer behind a slow older-page response.
    void lease.resume().catch(() => {});

    observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!lease.isCurrent() || !entry?.isIntersecting) {
          return;
        }
        if (state.sortOrder === "oldest") void lease.resume();
        else void eventNotifications.loadMore();
      },
      { rootMargin: "200px 0px 200px 0px" },
    );

    if (sentinel) {
      observer.observe(sentinel);
    }
  }

  onMount(() => {
    mounted = true;
  });

  onDestroy(() => {
    mounted = false;
    view?.release();
    if (observer && sentinel) {
      observer.unobserve(sentinel);
    }
    observer?.disconnect();
    observer = null;
  });
</script>

<svelte:head>
  <title
    >{$t("dashboard.notifications.metaTitle", "Notifications • {username}", {
      username: data.username,
    })}</title
  >
  <meta
    name="description"
    content={$t(
      "dashboard.notifications.metaDescription",
      "Review and manage your Free2Z notifications.",
    )}
  />
</svelte:head>

<main class="flex-1 bg-background pb-20 text-foreground">
  <div class="container mx-auto max-w-4xl space-y-6 px-4 py-10">
    <header>
      <div class="space-y-1">
        <h1 class="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <Bell class="size-7 text-primary" />
          {$t("navigation.notifications", "Notifications")}
        </h1>
        <p class="text-sm text-muted-foreground">
          {#if unreadCount === 0}
            {$t("dashboard.notifications.allCaughtUp", "You’re all caught up.")}
          {:else if isSingularCount(unreadCount, $locale)}
            {$t(
              "dashboard.notifications.unreadCountOne",
              "{count} unread notification",
              { count: unreadCount.toLocaleString($locale) },
            )}
          {:else}
            {$t(
              "dashboard.notifications.unreadCountMany",
              "{count} unread notifications",
              { count: unreadCount.toLocaleString($locale) },
            )}
          {/if}
        </p>
      </div>
    </header>

    <div class="flex flex-wrap items-center gap-3">
      <div class="inline-flex self-start rounded-lg bg-muted/60 p-1">
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors {showAllEvents
            ? 'text-muted-foreground hover:text-foreground'
            : 'bg-background text-foreground shadow-xs'}"
          aria-pressed={!showAllEvents}
          onclick={() => onFilterChange(false)}
          >{$t("dashboard.notifications.social", "Social")}</button
        >
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors {showAllEvents
            ? 'bg-background text-foreground shadow-xs'
            : 'text-muted-foreground hover:text-foreground'}"
          aria-pressed={showAllEvents}
          onclick={() => onFilterChange(true)}
          >{$t("dashboard.notifications.all", "All")}</button
        >
      </div>

      <div class="ml-auto flex items-center gap-1 sm:ml-0">
        <Button
          variant="outline"
          size="sm"
          class="size-8 bg-transparent p-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground sm:w-auto sm:px-3"
          onclick={() => eventNotifications.loadInitial({ force: true })}
          disabled={state.loadingInitial}
          aria-label={$t(
            "dashboard.notifications.refreshLabel",
            "Refresh notifications",
          )}
        >
          <RefreshCcw
            class="size-4 {state.loadingInitial ? 'animate-spin' : ''}"
          />
          <span class="hidden sm:inline"
            >{$t("dashboard.notifications.refresh", "Refresh")}</span
          >
        </Button>

        {#if unreadCount > 0 || state.markingAllRead}
          <Button
            variant="outline"
            size="sm"
            class="bg-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            onclick={markAllRead}
            disabled={state.markingAllRead}
          >
            {#if state.markingAllRead}
              <Loader2 class="size-4 animate-spin" />
              {$t("dashboard.notifications.marking", "Marking…")}
            {:else}
              <CheckCheck class="size-4" />
              <span class="sm:hidden"
                >{$t("dashboard.notifications.markAllShort", "Mark all")}</span
              >
              <span class="hidden sm:inline"
                >{$t(
                  "dashboard.notifications.markAllRead",
                  "Mark all as read",
                )}</span
              >
            {/if}
          </Button>
        {/if}
      </div>

      <div
        class="order-last grid w-full grid-cols-2 gap-2 sm:order-none sm:ml-auto sm:flex sm:w-auto"
      >
        <Select.Root
          type="single"
          value={state.readFilter}
          onValueChange={onReadFilterChange}
        >
          <Select.Trigger
            class="w-full bg-background sm:w-40"
            aria-label={$t(
              "dashboard.notifications.readFilterLabel",
              "Filter notifications by read status",
            )}
            disabled={state.loadingInitial}
          >
            <CheckCheck class="size-3.5" />
            {state.readFilter === "all"
              ? $t("dashboard.notifications.allStatuses", "All statuses")
              : state.readFilter === "unread"
                ? $t("dashboard.notifications.unread", "Unread")
                : $t("dashboard.notifications.read", "Read")}
          </Select.Trigger>
          <Select.Content>
            <Select.Item
              value="all"
              label={$t("dashboard.notifications.allStatuses", "All statuses")}
              >{$t(
                "dashboard.notifications.allStatuses",
                "All statuses",
              )}</Select.Item
            >
            <Select.Item
              value="unread"
              label={$t("dashboard.notifications.unread", "Unread")}
              >{$t("dashboard.notifications.unread", "Unread")}</Select.Item
            >
            <Select.Item
              value="read"
              label={$t("dashboard.notifications.read", "Read")}
              >{$t("dashboard.notifications.read", "Read")}</Select.Item
            >
          </Select.Content>
        </Select.Root>

        <Select.Root
          type="single"
          value={state.sortOrder}
          onValueChange={onSortChange}
        >
          <Select.Trigger
            class="w-full bg-background sm:w-40"
            aria-label={$t(
              "dashboard.notifications.sortLabel",
              "Sort notifications",
            )}
            disabled={state.loadingInitial}
          >
            <ArrowUpDown class="size-3.5" />
            {state.sortOrder === "newest"
              ? $t("profile.sort.newest", "Newest")
              : $t("profile.sort.oldest", "Oldest")}
          </Select.Trigger>
          <Select.Content>
            <Select.Item
              value="newest"
              label={$t("dashboard.notifications.newestFirst", "Newest first")}
              >{$t(
                "dashboard.notifications.newestFirst",
                "Newest first",
              )}</Select.Item
            >
            <Select.Item
              value="oldest"
              label={$t("dashboard.notifications.oldestFirst", "Oldest first")}
              >{$t(
                "dashboard.notifications.oldestFirst",
                "Oldest first",
              )}</Select.Item
            >
          </Select.Content>
        </Select.Root>
      </div>
    </div>

    {#if state.error}
      <div
        class="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        {state.error}
      </div>
    {/if}

    {#if state.loadingInitial && state.events.length === 0}
      <div class="space-y-3">
        {#each Array(6) as _}
          <article class="rounded-xl border border-border bg-card/40 p-4">
            <div class="flex items-start gap-3">
              <Skeleton class="size-10 shrink-0 rounded-full" />
              <div class="min-w-0 flex-1 space-y-2">
                <Skeleton class="h-4 w-24 rounded-md" />
                <Skeleton class="h-5 w-full max-w-[400px] rounded-md" />
                <Skeleton class="h-3 w-32 rounded-md" />
              </div>
              <Skeleton class="h-8 w-20 shrink-0" />
            </div>
          </article>
        {/each}
      </div>
    {:else if state.events.length === 0}
      <div class="space-y-2 py-14 text-center">
        <Bell class="mx-auto size-6 text-muted-foreground" />
        <h2 class="text-base font-semibold">
          {state.hasEvents
            ? $t(
                "dashboard.notifications.emptyFilteredTitle",
                "No matching notifications",
              )
            : $t("dashboard.notifications.emptyTitle", "No notifications yet")}
        </h2>
        <p class="text-sm text-muted-foreground">
          {state.hasEvents
            ? $t(
                "dashboard.notifications.emptyFilteredBody",
                "Try another activity or status filter.",
              )
            : $t(
                "dashboard.notifications.emptyBody",
                "New activity will appear here.",
              )}
        </p>
      </div>
    {:else}
      <div class="space-y-3">
        {#if visibleEvents.length === 0}
          <div class="px-5 py-10 text-center">
            <p class="font-medium">
              {$t(
                "dashboard.notifications.noStatusMatch",
                "No notifications match this status.",
              )}
            </p>
            <p class="mt-1 text-sm text-muted-foreground">
              {state.nextPageUrl
                ? $t(
                    "dashboard.notifications.noStatusMatchMore",
                    "Keep scrolling to load more, or choose another status.",
                  )
                : $t(
                    "dashboard.notifications.noStatusMatchEnd",
                    "Choose another status to see more notifications.",
                  )}
            </p>
          </div>
        {/if}

        {#each visibleEvents as event (event.id)}
          {@const avatar = contributorAvatar(event)}
          <article
            class="min-w-0 overflow-hidden rounded-xl border border-border bg-card/60 p-4 transition-colors hover:bg-card {event.read
              ? ''
              : 'bg-muted/20'}"
          >
            <div
              class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3 sm:gap-4"
            >
              {#if avatar}
                <img
                  src={avatar}
                  alt={event?.contributor?.username ||
                    $t(
                      "dashboard.notifications.contributorAvatarAlt",
                      "Contributor avatar",
                    )}
                  class="size-9 shrink-0 rounded-full border border-border object-cover sm:size-10"
                  loading="lazy"
                />
              {:else}
                <span
                  class="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-sm font-semibold text-muted-foreground sm:size-10"
                  aria-label={event?.contributor?.username
                    ? $t(
                        "dashboard.notifications.userAvatarLabel",
                        "{username} avatar",
                        { username: event.contributor.username },
                      )
                    : $t("dashboard.notifications.eventTypes.event", "Event")}
                >
                  {contributorInitial(event)}
                </span>
              {/if}
              <div class="min-w-0 space-y-2.5">
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    class="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    {eventTypeLabel(event?.type)}
                  </span>
                  {#if !event.read}
                    <span
                      class="inline-flex items-center gap-1.5 text-xs font-medium text-primary"
                    >
                      <span
                        class="size-1.5 rounded-full bg-primary"
                        aria-hidden="true"
                      ></span>
                      {$t("dashboard.notifications.new", "New")}
                    </span>
                  {/if}
                  <span class="min-w-2 flex-1"></span>
                  {#if !event.read}
                    <Button
                      variant="ghost"
                      size="sm"
                      class="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onclick={() => eventNotifications.markRead(event.id)}
                    >
                      <CheckCheck class="size-4" />
                      {$t("dashboard.notifications.markRead", "Mark read")}
                    </Button>
                  {:else}
                    <span
                      class="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground"
                    >
                      <CheckCheck class="size-4 text-primary" />
                      {$t("dashboard.notifications.read", "Read")}
                    </span>
                  {/if}
                </div>
                {#if event.content_url}
                  <button
                    type="button"
                    class="block w-full min-w-0 text-left text-sm leading-6 font-semibold [overflow-wrap:anywhere] break-words whitespace-normal text-foreground hover:text-primary sm:text-base"
                    onclick={() => openEvent(event)}
                  >
                    {formatEventNotification(event, $t, $locale)}
                  </button>
                {:else}
                  <p
                    class="min-w-0 text-sm leading-6 font-semibold [overflow-wrap:anywhere] break-words whitespace-normal sm:text-base"
                  >
                    {formatEventNotification(event, $t, $locale)}
                  </p>
                {/if}

                <div
                  class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground"
                >
                  {#if counterparty(event)}
                    <span
                      class="max-w-full min-w-0 truncate font-medium text-foreground/80"
                      title={counterparty(event)}
                    >
                      {counterparty(event)}
                    </span>
                  {/if}
                  {#if typeof event?.amount === "number"}
                    <span
                      class="inline-flex items-center gap-1 font-medium text-foreground/80"
                    >
                      <Coins class="size-3.5 text-primary" />
                      {amountLabel(event.amount)}
                    </span>
                  {/if}
                  {#if event?.created_at}
                    <time
                      class="inline-flex items-center gap-1"
                      datetime={event.created_at}
                      title={event.created_at}
                    >
                      <Clock3 class="size-3.5" />
                      {formatRelativeTime(event.created_at, $locale)}
                    </time>
                  {/if}
                </div>
              </div>
            </div>
          </article>
        {/each}

        <div bind:this={sentinel} class="h-6 w-full"></div>

        {#if state.loadingMore}
          <div class="space-y-3 pb-8">
            {#each Array(2) as _}
              <article class="rounded-xl border border-border bg-card/40 p-4">
                <div class="flex items-start gap-3">
                  <Skeleton class="size-10 shrink-0 rounded-full" />
                  <div class="min-w-0 flex-1 space-y-2">
                    <Skeleton class="h-4 w-24 rounded-md" />
                    <Skeleton class="h-5 w-full max-w-[400px] rounded-md" />
                    <Skeleton class="h-3 w-32 rounded-md" />
                  </div>
                  <Skeleton class="h-8 w-20 shrink-0" />
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</main>
