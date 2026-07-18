<script lang="ts">
  import "../styles/globals.css";
  import "katex/dist/katex.min.css";
  import "highlight.js/styles/github-dark-dimmed.css";
  import "$lib/i18n"; // Initialize i18n
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import Navbar from "$lib/components/layout/Navbar.svelte";
  import Footer from "$lib/components/layout/Footer.svelte";
  import ClassicUiBanner from "$lib/components/layout/ClassicUiBanner.svelte";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { browser } from "$app/environment";
  import { onDestroy, onMount } from "svelte";
  import { page } from "$app/state";
  import { page as pageStore } from "$app/stores";
  import { toast } from "svelte-sonner";
  import { ModeWatcher } from "mode-watcher";
  import { liveStreamStore } from "$lib/stores/liveStreamStore";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { eventNotifications } from "$lib/stores/eventNotifications";
  import type { Event } from "$lib/api/f2z.schemas";

  // Create a query client instance
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        enabled: browser, // Only enable queries in browser context
        staleTime: 1000 * 60 * 5, // 5 minutes
        gcTime: 1000 * 60 * 10, // 10 minutes (formerly cacheTime)
        retry: (failureCount, error) => {
          // Don't retry on 4xx errors except 408, 429
          if (error && typeof error === "object" && "status" in error) {
            const status = error.status as number;
            if (
              status >= 400 &&
              status < 500 &&
              status !== 408 &&
              status !== 429
            ) {
              return false;
            }
          }
          return failureCount < 3;
        },
      },
    },
  });

  let ws: WebSocket | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;
  let lastConnectedUsername = "";
  let manualSocketClose = false;
  let removeAuthListeners = () => {};

  function getProfileWebSocketUrl() {
    if (!browser) return "";
    const wsProtocol = page.url.protocol === "https:" ? "wss" : "ws";
    return `${wsProtocol}://${page.url.host}/ws/profile`;
  }

  function clearReconnectTimer() {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  }

  function closeSocket() {
    clearReconnectTimer();
    if (ws) {
      manualSocketClose = true;
      ws.close();
      ws = null;
    }
  }

  function scheduleReconnect(username: string) {
    reconnectAttempts += 1;
    if (reconnectAttempts >= maxReconnectAttempts) {
      return;
    }

    const backoff =
      Math.min(30000, (Math.pow(2, reconnectAttempts) - 1) * 1000) +
      Math.random() * 1000;
    clearReconnectTimer();
    reconnectTimeout = setTimeout(() => connectSocket(username), backoff);
  }

  function connectSocket(username: string) {
    if (!browser || !username) {
      return;
    }

    closeSocket();
    manualSocketClose = false;
    ws = new WebSocket(getProfileWebSocketUrl());

    ws.onopen = () => {
      reconnectAttempts = 0;
    };

    ws.onmessage = async (message) => {
      try {
        const payload = JSON.parse(message.data);
        const event = payload?.content as Event | undefined;
        if (!event?.id) {
          return;
        }

        eventNotifications.addIncomingEvent(event);
        if (!event.read && event.message) {
          toast.info(event.message);
        }
      } catch {
        // ignore malformed websocket payloads
      }
    };

    ws.onclose = () => {
      if (manualSocketClose) {
        manualSocketClose = false;
        return;
      }
      if (lastConnectedUsername === username) {
        scheduleReconnect(username);
      }
    };
  }

  const unsubscribeCurrentUser = currentUser.subscribe(async (creator) => {
    if (!browser) {
      return;
    }

    const username = creator?.username || "";

    if (!username) {
      lastConnectedUsername = "";
      closeSocket();
      reconnectAttempts = 0;
      eventNotifications.clearForLogout();
      return;
    }

    if (lastConnectedUsername !== username) {
      lastConnectedUsername = username;
      await eventNotifications.refreshMeta();
      connectSocket(username);
      return;
    }

    await eventNotifications.refreshMeta();
  });

  onDestroy(() => {
    unsubscribeCurrentUser();
    removeAuthListeners();
    closeSocket();
  });

  onMount(() => {
    const syncAuthState = () => {
      authStore.checkAuth({ force: true, silent: true }).catch(console.error);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncAuthState();
      }
    };

    window.addEventListener('focus', syncAuthState);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    removeAuthListeners = () => {
      window.removeEventListener('focus', syncAuthState);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };

    syncAuthState();
  });

  $: if (browser && $pageStore.url.pathname) {
    authStore.checkAuth({ silent: true }).catch(console.error);
  }

  $: privateSurface = /\/(dashboard|private)(\/|$)/.test($pageStore.url.pathname)
    || ['/edit', '/buy-2z', '/login'].includes($pageStore.url.pathname)
    || $pageStore.url.pathname.startsWith('/checkout/');
</script>

<svelte:head>
  {#if privateSurface}
    <meta name="robots" content="noindex, nofollow, noarchive" />
  {/if}
</svelte:head>

<QueryClientProvider client={queryClient}>
  <Tooltip.Provider>
    <Toaster position="bottom-center" />
    <ModeWatcher />
    <div
      class="flex min-h-screen flex-col"
      style="background: var(--f2z-bg-primary);"
    >
      {#if !($pageStore.route.id === "/edit" || ($pageStore.route.id?.includes("dashboard/stream") && $liveStreamStore.meeting))}
        <Navbar />
        <ClassicUiBanner />
      {/if}
      <main class="flex flex-1 flex-col px-2 md:p-0">
        <slot />
      </main>
      {#if !($pageStore.route.id?.includes("dashboard/stream") && $liveStreamStore.meeting)}
        <Footer />
      {/if}
    </div>
  </Tooltip.Provider>
</QueryClientProvider>
