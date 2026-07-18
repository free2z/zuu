<script lang="ts">
  import type { PageData } from './$types';
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Skeleton } from '$lib/components/ui/skeleton';
  import { eventNotifications } from '$lib/stores/eventNotifications';
  import { formatRelativeTime } from '$lib/utils/date';
  import { Bell, CheckCheck, Loader2, RefreshCcw, UserRound } from '@lucide/svelte';

  export let data: PageData;

  let sentinel: HTMLDivElement | null = null;
  let observer: IntersectionObserver | null = null;

  $: state = $eventNotifications;
  $: showAllEvents = state.filter === 'all';

  const SENT_OR_SPEND_TYPES = ['DONATION_SENT', 'SUBSCRIPTION_SENT', 'PAY_PER_VIEW_SPEND'];

  const EVENT_TYPE_LABELS: Record<string, string> = {
    AISCORE_COMMENT: 'AI Score',
    MADE_COMMENT: 'Comment',
    VOTE_COMMENT_RECEIVED: 'Comment Vote In',
    VOTE_COMMENT_SENT: 'Comment Vote Out',
    NEW_REPLY: 'Reply',
    PAGE_UPDATE: 'Page Update',
    PAGE_VOTE: 'Page Vote',
    DONATION_RECEIVED: 'Donation In',
    DONATION_SENT: 'Donation Out',
    SUBSCRIPTION_RECEIVED: 'Subscription In',
    SUBSCRIPTION_SENT: 'Subscription Out',
    BOUGHT_TUZI: 'Bought Tuzi',
    CHAT2Z: 'Chat2Z',
    PLATFORM_FEE: 'Platform Fee',
    PAY_PER_VIEW_REVENUE: 'PPV Revenue',
    PAY_PER_VIEW_SPEND: 'PPV Spend'
  };

  function isSentOrSpendType(type: string | undefined): boolean {
    return Boolean(type && SENT_OR_SPEND_TYPES.includes(type));
  }

  function eventTypeLabel(type: string | undefined): string {
    if (!type) return 'Event';
    return EVENT_TYPE_LABELS[type] || type.replaceAll('_', ' ');
  }

  function contributorAvatar(event: any): string {
    return (
      event?.contributor?.avatar_image?.thumbnail ||
      event?.contributor?.avatar_image?.url ||
      'https://free2z.com/docs/img/tuzi.svg'
    );
  }

  function eventMeta(event: any): string {
    const parts: string[] = [];
    if (isSentOrSpendType(event?.type) && event?.payee?.username) {
      parts.push(`To: ${event.payee.username}`);
    }
    if (event?.contributor?.username) {
      parts.push(`From: ${event.contributor.username}`);
    }
    if (typeof event?.amount === 'number') {
      parts.push(`${event.amount} tuzis`);
    }
    if (event?.created_at) {
      parts.push(formatRelativeTime(event.created_at));
    }
    return parts.join(' · ');
  }

  async function openEvent(event: any) {
    if (!event) return;

    if (!event.read) {
      await eventNotifications.markRead(event.id);
    }

    if (!event.content_url) {
      return;
    }

    if (event.content_url.startsWith('/')) {
      goto(event.content_url);
      return;
    }

    window.location.href = event.content_url;
  }

  async function onFilterChange(nextShowAll: boolean) {
    const nextFilter = nextShowAll ? 'all' : 'social';
    if (nextFilter === state.filter) {
      return;
    }
    await eventNotifications.setFilter(nextFilter);
  }

  onMount(async () => {
    await eventNotifications.refreshMeta();
    await eventNotifications.loadInitial();

    observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting) {
          return;
        }
        eventNotifications.loadMore();
      },
      { rootMargin: '200px 0px 200px 0px' }
    );

    if (sentinel) {
      observer.observe(sentinel);
    }
  });

  onDestroy(() => {
    if (observer && sentinel) {
      observer.unobserve(sentinel);
    }
    observer?.disconnect();
    observer = null;
  });
</script>

<svelte:head>
  <title>Notifications • {data.username}</title>
  <meta name="description" content="Review and manage your Free2z notifications." />
</svelte:head>

<main class="flex-1 bg-background text-foreground pb-20">
  <div class="container max-w-4xl mx-auto px-4 py-10 space-y-6">
    <header class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div class="space-y-1">
        <h1 class="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Bell class="size-7 text-primary" /> Notifications
        </h1>
        <p class="text-sm text-muted-foreground">Stay up to date with your creator activity.</p>
      </div>

      <div class="flex items-center gap-2">
        <Button
          variant={showAllEvents ? 'outline' : 'default'}
          onclick={() => onFilterChange(false)}
          class="min-w-28"
        >
          Social only
        </Button>
        <Button
          variant={showAllEvents ? 'default' : 'outline'}
          onclick={() => onFilterChange(true)}
          class="min-w-20"
        >
          All
        </Button>
      </div>
    </header>

    <section class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/40 p-4">
      <div class="text-sm text-muted-foreground">
        Unread: <span class="font-semibold text-foreground">{state.unreadCount}</span>
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onclick={() => eventNotifications.loadInitial({ force: true })}
          disabled={state.loadingInitial}
        >
          <RefreshCcw class="size-4 mr-1 {state.loadingInitial ? 'animate-spin' : ''}" /> Refresh
        </Button>
        <Button
          size="sm"
          onclick={() => eventNotifications.markAllRead()}
          disabled={state.markingAllRead || state.events.length === 0}
        >
          {#if state.markingAllRead}
            <Loader2 class="size-4 mr-2 animate-spin" />
            Marking…
          {:else}
            <CheckCheck class="size-4 mr-1" />
            Mark all as read
          {/if}
        </Button>
      </div>
    </section>

    {#if state.error}
      <div class="rounded-xl border border-destructive/40 bg-destructive/10 text-destructive px-4 py-3 text-sm">
        {state.error}
      </div>
    {/if}

    {#if state.loadingInitial && state.events.length === 0}
      <div class="space-y-3">
        {#each Array(6) as _}
          <article class="rounded-xl border border-border p-4 bg-card/40">
            <div class="flex items-start gap-3">
              <Skeleton class="size-10 rounded-full shrink-0" />
              <div class="flex-1 min-w-0 space-y-2">
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
      <div class="rounded-2xl border border-dashed border-border bg-card/30 p-10 text-center space-y-3">
        <div class="mx-auto w-14 h-14 rounded-full bg-muted flex items-center justify-center">
          <Bell class="size-6 text-muted-foreground" />
        </div>
        <h2 class="text-lg font-semibold">No notifications yet</h2>
        <p class="text-sm text-muted-foreground">You’ll see activity here when people interact with your content.</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each state.events as event (event.id)}
          <article class="rounded-xl border border-border p-4 bg-card/50 transition-colors {event.read ? '' : 'bg-primary/5 border-primary/30'}">
            <div class="flex items-start gap-3">
              <img
                src={contributorAvatar(event)}
                alt={event?.contributor?.username || 'contributor avatar'}
                class="size-10 rounded-full object-cover border border-border"
                loading="lazy"
              />
              <div class="flex-1 min-w-0 space-y-1.5">
                <div>
                  <span class="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {eventTypeLabel(event?.type)}
                  </span>
                </div>
                {#if event.content_url}
                  <Button variant="link" class="text-left font-medium p-0 h-auto justify-start text-foreground" onclick={() => openEvent(event)}>
                    {event.message}
                  </Button>
                {:else}
                  <p class="font-medium">{event.message}</p>
                {/if}

                <p class="text-xs text-muted-foreground break-words">{eventMeta(event)}</p>
              </div>

              {#if !event.read}
                <Button variant="ghost" size="sm" onclick={() => eventNotifications.markRead(event.id)}>
                  Mark read
                </Button>
              {:else}
                <div class="text-xs text-muted-foreground inline-flex items-center gap-1"><UserRound class="size-3.5" /> Read</div>
              {/if}
            </div>
          </article>
        {/each}

        <div bind:this={sentinel} class="h-6 w-full"></div>

        {#if state.loadingMore}
          <div class="space-y-3 pb-8">
            {#each Array(2) as _}
              <article class="rounded-xl border border-border p-4 bg-card/40">
                <div class="flex items-start gap-3">
                  <Skeleton class="size-10 rounded-full shrink-0" />
                  <div class="flex-1 min-w-0 space-y-2">
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
